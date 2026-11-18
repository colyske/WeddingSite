// Explicit isolated local/CI database only; no provider calls or transfers.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";

const container = process.env.FACILITATOR_FUNDING_TEST_DB_CONTAINER;
if (container !== "supabase_db_weddingsite") {
  throw new Error("Set FACILITATOR_FUNDING_TEST_DB_CONTAINER to the isolated local CI database.");
}

function sql(input, hold = false) {
  const child = spawn("docker", ["exec", "-i", container, "psql", "-X", "-U", "postgres",
    "-d", "postgres", "-At", "-v", "ON_ERROR_STOP=1"]);
  let stdout = "", stderr = "";
  const result = new Promise((resolve, reject) => {
    const timer = setTimeout(() => child.kill(), 35000);
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("error", error => { clearTimeout(timer); reject(error); });
    child.on("close", code => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`psql exited ${code}: ${stderr}`));
    });
  });
  if (hold) child.stdin.write(input);
  else child.stdin.end(input);
  return { result, release: () => { if (!child.stdin.destroyed) child.stdin.end("commit;\n"); } };
}
const run = input => sql(input).result;
const owner = randomUUID();
const keys = [randomUUID(), randomUUID()];
const scope = randomUUID(), evidence = randomUUID();
const sha = "a".repeat(64);
const actor = `set local role authenticated;
  select set_config('request.jwt.claim.role','authenticated',true);
  select set_config('request.jwt.claim.sub','${owner}',true);`;
const call = (key, cash) => `public.facilitator_funding_attestation_create(
  '${key}','KES','${scope}','2020-01-01 00:00:00+00',
  '2020-01-02 00:00:00+00','2020-01-03 00:00:00+00',
  ${cash},500,200,300,'${evidence}','${sha}',true,true)`;
// Both connections need exactly the same timestamp values, not transaction-local now().
const times = await run(`select to_char(clock_timestamp()-interval '2 days','YYYY-MM-DD HH24:MI:SS.USOF')
  || '|' || to_char(clock_timestamp()-interval '1 hour','YYYY-MM-DD HH24:MI:SS.USOF')
  || '|' || to_char(clock_timestamp()+interval '1 day','YYYY-MM-DD HH24:MI:SS.USOF');`);
const [periodStart, asOf, expiresAt] = times.split("|");
assert.ok(periodStart && asOf && expiresAt, "Database supplied inventory timestamps");
const expression = (key, cash) => call(key, cash)
  .replace("2020-01-01 00:00:00+00", periodStart)
  .replace("2020-01-02 00:00:00+00", asOf)
  .replace("2020-01-03 00:00:00+00", expiresAt);
const waitFor = condition => run(`do $$ begin for i in 1..1000 loop
  perform pg_stat_clear_snapshot();
  if ${condition} then return; end if;
  perform pg_sleep(0.01);
end loop; raise exception 'Concurrency barrier timed out'; end $$;`);
const uuid = output => output.split("\n").find(line => /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(line) && line !== owner);
const json = output => JSON.parse(output.split("\n").find(line => line.startsWith("{")));

async function race(key, leftCash, rightCash) {
  const firstName = `funding_first_${randomUUID()}`, secondName = `funding_second_${randomUUID()}`;
  const first = sql(`begin; set local statement_timeout='20s';
    set local idle_in_transaction_session_timeout='25s';
    set local application_name='${firstName}'; ${actor}
    select ${expression(key, leftCash)};\n`, true);
  // Attach handlers before awaiting barriers, so failures cannot become unhandled rejections.
  const firstResult = first.result.then(value => ({ value }), error => ({ error }));
  let secondResult, barrierError;
  try {
    await waitFor(`exists(select 1 from pg_stat_activity where application_name='${firstName}'
      and state='idle in transaction' and wait_event='ClientRead')`);
    const second = sql(`begin; set local statement_timeout='20s';
      set local application_name='${secondName}'; ${actor}
      select ${expression(key, rightCash)}; commit;`);
    secondResult = second.result.then(value => ({ value }), error => ({ error }));
    await waitFor(`exists(select 1 from pg_stat_activity waiting join pg_stat_activity holding
      on holding.pid=any(pg_blocking_pids(waiting.pid))
      where waiting.application_name='${secondName}' and holding.application_name='${firstName}'
      and waiting.wait_event='advisory')`);
  } catch (error) {
    barrierError = error;
  } finally {
    first.release();
  }
  const [a, b] = await Promise.all([firstResult, secondResult]);
  if (barrierError) throw barrierError;
  if (a.error) throw a.error;
  return [a.value, b];
}

let fixtureCreated = false;
try {
  await run(`begin;
    do $$ begin
      if exists(select 1 from public.protected_platform_owner where owner_user_id is not null)
        or exists(select 1 from auth.users u join public.protected_platform_owner o
          on lower(u.email)=lower(o.owner_email)) then
        raise exception 'Test requires an unprovisioned isolated owner identity';
      end if;
    end $$;
    insert into auth.users(id,email,email_confirmed_at)
      select '${owner}',owner_email,now() from public.protected_platform_owner where singleton;
    select public.bootstrap_protected_owner('${owner}'); commit;`);
  fixtureCreated = true;
  const initial = json(await run(`begin; ${actor}
    select public.facilitator_funding_attestations_list(); commit;`));
  assert.equal(initial.available_minor, "0");
  assert.equal(initial.payouts_enabled, false);

  const [first, identical] = await race(keys[0], 10000, 10000);
  assert.ifError(identical.error);
  const firstId = uuid(first);
  assert.ok(firstId, "First attestation returned an ID");
  assert.equal(uuid(identical.value), firstId, "Concurrent identical retry returns the same ID");

  const [winner, divergent] = await race(keys[1], 10000, 10001);
  assert.ok(uuid(winner), "First divergent attestation returned an ID");
  assert.ok(divergent.error, "Concurrent divergent retry is rejected");
  assert.match(divergent.error.message, /Attestation retry differs from the original/);
  const records = JSON.parse(await run(`select jsonb_agg(jsonb_build_object(
    'key',request_key,'cash',cash_minor::text) order by request_key)
    from public.facilitator_funding_attestations where request_key in ('${keys[0]}','${keys[1]}');`));
  assert.equal(records.length, 2, "Exactly one row per request key");
  assert.deepEqual(new Set(records.map(record => record.key)), new Set(keys));
  assert.ok(records.every(record => record.cash === "10000"), "Divergent retry did not change inventory");
  const listing = json(await run(`begin; ${actor}
    select public.facilitator_funding_attestations_list(); commit;`));
  assert.equal(listing.available_minor, "0", "Manual evidence never creates payable funds");
  assert.equal(listing.payouts_enabled, false);
  assert.equal(listing.manual_assertions_only, true);
  console.log("Concurrent facilitator funding replays serialize; divergent retry rejected; payable remains zero.");
} finally {
  if (fixtureCreated) {
    await run(`begin;
      alter table public.facilitator_funding_attestations disable trigger facilitator_funding_attestations_immutable;
      delete from public.facilitator_funding_attestations where request_key in ('${keys[0]}','${keys[1]}')
        and recorded_by='${owner}';
      alter table public.facilitator_funding_attestations enable trigger facilitator_funding_attestations_immutable;
      alter table public.protected_platform_owner disable trigger guard_protected_owner_identity_trigger;
      update public.protected_platform_owner set owner_user_id=null where owner_user_id='${owner}';
      alter table public.protected_platform_owner enable trigger guard_protected_owner_identity_trigger;
      delete from public.audit_events where actor_id='${owner}' or (table_name='profiles' and record_id='${owner}');
      alter table public.profiles disable trigger protect_owner_profile_trigger;
      delete from public.profiles where id='${owner}';
      alter table public.profiles enable trigger protect_owner_profile_trigger;
      delete from auth.users where id='${owner}';
      delete from public.audit_events where table_name='profiles' and record_id='${owner}';
      commit;`);
  }
}
