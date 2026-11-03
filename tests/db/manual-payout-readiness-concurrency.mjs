// Explicit isolated database only. Real policy RPCs; no gate substitutions/provider.
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";

const container = process.env.MANUAL_PAYOUT_TEST_DB_CONTAINER;
if (container !== "supabase_db_weddingsite") throw new Error("Explicit isolated CI database required.");
function sql(input, output = () => {}, control) {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", ["exec", "-i", container, "psql", "-U", "postgres", "-d", "postgres", "-At", "-v", "ON_ERROR_STOP=1"]);
    let stdout = "", stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; output(stdout); });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("error", reject);
    child.on("exit", code => code === 0 ? resolve(stdout.trim()) : reject(new Error(stderr)));
    if (control) {
      control.release = () => child.stdin.end("commit;\n");
      child.stdin.write(input);
    } else child.stdin.end(input);
  });
}
let ids;
const actor = id => `set local role authenticated; select set_config('request.jwt.claim.sub','${id}',true);
  select set_config('request.jwt.claim.role','authenticated',true);`;
const run = (id, expression) => sql(`begin; set local statement_timeout='20s'; ${actor(id)} select ${expression}; commit;`);
const uuid = output => output.split("\n").find(line => /^[0-9a-f-]{36}$/.test(line) && !Object.values(ids).includes(line));
const policy = changes => run(ids.owner, `public.owner_set_manual_payout_policy(
  (select (public.manual_payout_readiness()->'policy'->>'revision')::uuid),'${JSON.stringify(changes)}',true)`);
const request = (key = randomUUID(), amount = 4000) => `public.manual_payout_request('${key}','${ids.wedding}',
  '${ids.custody}','${ids.recipient}',${amount},100,'KES')`;
const waitForAdvisory = name => sql(`do $$ begin for i in 1..1000 loop
  perform pg_stat_clear_snapshot();
  if exists(select 1 from pg_stat_activity where application_name='${name}' and wait_event='advisory') then return; end if;
  perform pg_sleep(0.01);
end loop; raise exception 'Writer never reached advisory wait'; end $$;`);
async function revokeWhileWaiting(expression, reviewer = false) {
  const revoked = reviewer ? ids.checker : randomUUID();
  if (!reviewer) await sql(`insert into auth.users(id) values('${revoked}');
    update public.profiles set platform_role='superadmin' where id='${revoked}';`);
  const control = {};
  let ready;
  const signal = new Promise(resolve => { ready = resolve; });
  const barrier = sql(`begin; set local idle_in_transaction_session_timeout='30s';
    select pg_advisory_xact_lock(71110001); select 'READY';\n`,
  data => { if (data.includes("READY")) ready(); }, control);
  await Promise.race([signal, barrier.then(() => { throw new Error("Missing barrier"); })]);
  const name = randomUUID();
  const denied = assert.rejects(sql(`begin; set local statement_timeout='20s';
    set local application_name='${name}'; ${actor(reviewer ? ids.maker : revoked)} select ${expression}; commit;`),
  /authority revoked|authorized intake|MANUAL_PAYOUT_BLOCKED/);
  try {
    await waitForAdvisory(name);
    await sql(`update public.profiles set platform_role='client' where id='${revoked}';`);
  } finally { control.release(); }
  try { await Promise.all([barrier, denied]); }
  finally {
    if (reviewer) await sql(`update public.profiles set platform_role='superadmin' where id='${revoked}';`);
  }
}
async function deactivateWhileWaiting(expression) {
  const control = {};
  let ready;
  const signal = new Promise(resolve => { ready = resolve; });
  const disabling = sql(`begin; set local idle_in_transaction_session_timeout='30s'; ${actor(ids.owner)}
    select public.owner_set_manual_payout_policy(
      (public.manual_payout_readiness()->'policy'->>'revision')::uuid,'{"enabled":false}',true);
    select 'DISABLED_HELD';\n`, data => { if (data.includes("DISABLED_HELD")) ready(); }, control);
  await Promise.race([signal, disabling.then(() => { throw new Error("Missing deactivation barrier"); })]);
  const name = randomUUID();
  const denied = assert.rejects(sql(`begin; set local statement_timeout='20s';
    set local application_name='${name}'; ${actor(ids.maker)} select ${expression}; commit;`), /MANUAL_PAYOUT_BLOCKED/);
  try { await waitForAdvisory(name); } finally { control.release(); }
  await Promise.all([disabling, denied]);
}
try {
  const fixture = readFileSync(new URL("./manual-payout-readiness.sql", import.meta.url), "utf8")
    .replace(/rollback;\s*$/, `create table public.manual_readiness_ci_context as
      select jsonb_object_agg(key,id) ids from mr_ids; commit;`);
  await sql(fixture);
  ids = JSON.parse(await sql("select ids from public.manual_readiness_ci_context;"));
  const offKey = randomUUID();
  await deactivateWhileWaiting(request(offKey, 1000));
  assert.equal(await sql(`select count(*) from public.manual_payout_requests where request_key='${offKey}';`), "0");
  await policy({ enabled: true });
  const competing = await Promise.allSettled([run(ids.maker, request()), run(ids.maker, request())]);
  assert.equal(competing.filter(r => r.status === "fulfilled").length, 1,
    `Only one request fits the real aggregate policy: ${competing.map(r => r.status === "rejected" ? r.reason.message : r.value).join("\n")}`);
  assert.match(competing.find(r => r.status === "rejected").reason.message, /UTC-day total/);
  let payout = uuid(competing.find(r => r.status === "fulfilled").value);
  await run(ids.checker, `public.manual_payout_transition('${payout}','approved')`);
  await deactivateWhileWaiting(`public.manual_payout_transition('${payout}','executing','${randomUUID()}')`);
  assert.equal(await sql(`select count(*) from public.manual_payout_claims where payout_id='${payout}';`), "0");
  await run(ids.maker, `public.manual_payout_transition('${payout}','cancelled')`);
  await policy({ enabled: true });
  payout = uuid(await run(ids.maker, request()));
  await run(ids.checker, `public.manual_payout_transition('${payout}','approved')`);
  await revokeWhileWaiting(request(randomUUID(), 1000));
  await revokeWhileWaiting(`public.manual_payout_transition('${payout}','executing','${randomUUID()}')`);
  await revokeWhileWaiting(`public.manual_payout_transition('${payout}','executing','${randomUUID()}')`, true);
  const claims = await Promise.allSettled([run(ids.maker, `public.manual_payout_transition('${payout}','executing','${randomUUID()}')`),
    run(ids.maker, `public.manual_payout_transition('${payout}','executing','${randomUUID()}')`)]);
  assert.equal(claims.filter(r => r.status === "fulfilled").length, 1);
  assert.match(claims.find(r => r.status === "rejected").reason.message, /already claimed/);
  await policy({ enabled: false });
  assert.equal(await sql(`select count(*) from public.manual_payout_claims where payout_id='${payout}';`), "1");
  await assert.rejects(run(ids.maker, request()), /MANUAL_PAYOUT_BLOCKED/);
  const evidence = async (kind, submitter = ids.maker) => {
    const id = uuid(await run(submitter, `public.manual_payout_submit_evidence('${kind}','${randomUUID()}','${"b".repeat(64)}')`));
    await run(ids.checker, `public.manual_payout_check_evidence('${id}')`);
    return id;
  };
  const receipt = await evidence("receipt");
  await run(ids.maker, `public.manual_payout_report('${payout}','${payout}',4000,100,'KES',clock_timestamp(),'${receipt}')`);
  const statementEvidence = await evidence("statement"), statement = randomUUID(), line = randomUUID();
  const prior = JSON.parse(await sql(`select to_jsonb(b) from public.manual_payout_statement_batches b
    where custody_id='${ids.custody}' order by sequence desc limit 1;`));
  const booked = await sql("select clock_timestamp()::text;");
  const batch = uuid(await run(ids.owner, `public.manual_payout_append_statement('${ids.custody}','${prior.id}',
    '${statement}',clock_timestamp(),${prior.closing_minor},0,4100,${prior.closing_minor - 4100},0,'${statementEvidence}')`));
  await run(ids.owner, `public.manual_payout_register_statement_debit('${batch}','${line}','${payout}',4000,100,'KES','${booked}','${statementEvidence}')`);
  const reconciliation = await evidence("reconciliation");
  const account = await sql(`select account_reference from public.manual_payout_custody where id='${ids.custody}';`);
  const exactFinalize = `public.manual_payout_reconcile('${payout}','daraja','${account}',
    '${statement}','${line}','${payout}',4000,100,'KES','${booked}','${reconciliation}')`;
  await revokeWhileWaiting(exactFinalize);
  await run(ids.checker, exactFinalize);
  assert.equal(await sql(`select public.manual_payout_state('${payout}');`), "paid", "Outcome completes after deactivation without releasing the claim");
  // Two Owner writes against one revision cannot both win, nor overwrite history.
  const current = await sql("select revision from public.manual_payout_operating_policies order by sequence desc limit 1;");
  const edits = await Promise.allSettled([false, true].map(enabled => run(ids.owner,
    `public.owner_set_manual_payout_policy('${current}','{"enabled":${enabled}}',true)`)));
  assert.equal(edits.filter(r => r.status === "fulfilled").length, 1);
  assert.match(edits.find(r => r.status === "rejected").reason.message, /CONFLICT/);
  console.log("Real default-OFF policy: aggregate reservations, single claims, Owner CAS, revoked waiting actors, and exact reconciliation after deactivation passed.");
} finally {
  if (ids) await policy({ enabled: false });
}
