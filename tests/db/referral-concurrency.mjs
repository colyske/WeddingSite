// Explicit local/CI runner, not part of npm's browser/unit discovery.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";

const container = process.env.REFERRAL_TEST_DB_CONTAINER;
if (!container || !/^(supabase_db_weddingsite|weddingsite_referral_ci_[a-z0-9]+)$/.test(container)) {
  throw new Error("An explicitly named local referral test database is required.");
}
const actor = randomUUID(), first = randomUUID(), second = randomUUID();
function sql(statement) {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", ["exec", "-i", container, "psql", "-U", "postgres", "-d", "postgres", "-At", "-v", "ON_ERROR_STOP=1"]);
    let output = "", errors = "";
    child.stdout.on("data", chunk => { output += chunk; });
    child.stderr.on("data", chunk => { errors += chunk; });
    child.on("error", reject);
    child.on("exit", code => code === 0 ? resolve(output.trim()) : reject(new Error(errors)));
    child.stdin.end(statement);
  });
}
try {
  await sql(`begin;
    insert into auth.users(id) values('${actor}'),('${first}'),('${second}');
    select set_config('request.jwt.claim.role','authenticated',true);
    select set_config('request.jwt.claim.sub','${first}',true);
    select public.referral_set_consent(true,'client-referrals-v1');
    select set_config('request.jwt.claim.sub','${second}',true);
    select public.referral_set_consent(true,'client-referrals-v1');
    commit;`);
  const codes = (await sql(`select code from public.referral_accounts where user_id in ('${first}','${second}') order by user_id;`)).split("\n");
  const capture = code => sql(`begin;
    set local statement_timeout='20s';
    set local role authenticated;
    select set_config('request.jwt.claim.role','authenticated',true);
    select set_config('request.jwt.claim.sub','${actor}',true);
    select public.referral_capture('${code}');
    select pg_sleep(0.3);
    commit;`);
  const results = await Promise.all(codes.map(capture));
  const ids = results.map(output => output.split("\n").find(line => /^[a-f0-9-]{36}$/.test(line) && line !== actor));
  assert.ok(ids[0]);
  assert.equal(ids[0], ids[1], "Concurrent different codes must resolve to one first-valid intent");
  assert.equal(await sql(`select count(*) from public.referral_intents where creator_id='${actor}' and state='pending';`), "1");
  console.log("Concurrent first-valid intent capture passed; no duplicate attribution slot.");
} finally {
  // These fixtures are the only committed rows; clean exact IDs in the isolated DB.
  await sql(`begin;
    delete from public.referral_intents where creator_id='${actor}';
    alter table public.referral_consent_history disable trigger referral_consent_history_immutable;
    delete from public.referral_consent_history where user_id in ('${first}','${second}');
    alter table public.referral_consent_history enable trigger referral_consent_history_immutable;
    delete from public.referral_accounts where user_id in ('${first}','${second}');
    delete from auth.users where id in ('${actor}','${first}','${second}');
    delete from public.audit_events where table_name='profiles' and record_id in ('${actor}','${first}','${second}');
    commit;`);
}
