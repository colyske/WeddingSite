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
  // Nonfinancial admission works OFF; same-key replay and distinct-key pending
  // submissions serialize before any reservation or staff financial request.
  await policy({ enabled: false });
  const intent = (key = randomUUID()) => `public.manual_payout_submit_intent('${key}','${ids.wedding}',1000,true)`;
  const beforeRequests = await sql("select count(*) from public.manual_payout_requests;");
  const intentKey = randomUUID();
  const intentReplays = await Promise.all([run(ids.client, intent(intentKey)), run(ids.client, intent(intentKey))]);
  const intentId = uuid(intentReplays[0]);
  assert.ok(intentId);
  assert.equal(uuid(intentReplays[1]), intentId, "Concurrent couple replay records one intent");
  await assert.rejects(run(ids.client, intent()), /already awaits/);
  assert.equal(await sql("select count(*) from public.manual_payout_requests;"), beforeRequests, "OFF intents reserve nothing");
  const review = (id, decision, key = randomUUID()) => `public.manual_payout_review_intent('${id}','${decision}',
    ${decision === "created" ? `'${key}','${ids.custody}','${ids.recipient}',100` : "null,null,null,null"},false,true)`;
  await assert.rejects(run(ids.maker, review(intentId, "created")), /MANUAL_PAYOUT_BLOCKED/);
  assert.equal(await sql(`select count(*) from public.manual_payout_intent_reviews where intent_id='${intentId}';`), "0");
  await policy({ enabled: true });
  await revokeWhileWaiting(review(intentId, "created"));
  const staffKey = randomUUID();
  const staffReplays = await Promise.all([run(ids.maker, review(intentId, "created", staffKey)), run(ids.maker, review(intentId, "created", staffKey))]);
  const intentPayout = uuid(staffReplays[0]);
  assert.ok(intentPayout);
  assert.equal(uuid(staffReplays[1]), intentPayout, "Concurrent staff replay reserves exactly once");
  await run(ids.maker, `public.manual_payout_transition('${intentPayout}','cancelled')`);
  const pendingRace = await Promise.allSettled([run(ids.client, intent()), run(ids.client, intent())]);
  assert.equal(pendingRace.filter(r => r.status === "fulfilled").length, 1, "Only one pending intent");
  const pendingId = uuid(pendingRace.find(r => r.status === "fulfilled").value);
  const reviewRace = await Promise.allSettled([run(ids.maker, review(pendingId, "created")), run(ids.owner, review(pendingId, "declined"))]);
  assert.equal(reviewRace.filter(r => r.status === "fulfilled").length, 1, "Create vs decline has a single immutable decision");
  const racedPayout = await sql(`select coalesce(payout_id::text,'') from public.manual_payout_intent_reviews where intent_id='${pendingId}';`);
  if (racedPayout) await run(ids.maker, `public.manual_payout_transition('${racedPayout}','cancelled')`);
  const offKey = randomUUID();
  await deactivateWhileWaiting(request(offKey, 1000));
  assert.equal(await sql(`select count(*) from public.manual_payout_requests where request_key='${offKey}';`), "0");
  await policy({ enabled: true });
  const replayKey = randomUUID();
  const replays = await Promise.all([run(ids.maker, request(replayKey, 1000)), run(ids.maker, request(replayKey, 1000))]);
  const replayId = uuid(replays[0]);
  assert.ok(replayId);
  assert.equal(uuid(replays[1]), replayId, "Concurrent real-policy replay reserves once");
  await assert.rejects(run(ids.maker, request(replayKey, 1001)), /Idempotency/);
  await run(ids.maker, `public.manual_payout_transition('${replayId}','cancelled')`);
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
  // Two real claimed outcomes compete for one provider/account receipt reference
  // while admission is OFF. One receipt commits; the other commits a shared hold.
  await policy({ enabled: true, daily_minor: 14000 });
  const receiptRaces = [];
  for (let i = 0; i < 2; i++) {
    const id = uuid(await run(ids.maker, request(randomUUID(), 1000)));
    await run(ids.checker, `public.manual_payout_transition('${id}','approved')`);
    await run(ids.maker, `public.manual_payout_transition('${id}','executing','${randomUUID()}')`);
    receiptRaces.push({ id, evidence: await evidence("receipt") });
  }
  await policy({ enabled: false });
  const reference = randomUUID();
  const reports = await Promise.all(receiptRaces.map(r => run(ids.maker,
    `public.manual_payout_report('${r.id}','${reference}',1000,100,'KES',clock_timestamp(),'${r.evidence}')`)));
  assert.equal(reports.filter(output => output.split("\n").includes("t")).length, 1);
  assert.equal(reports.filter(output => output.split("\n").includes("f")).length, 1);
  assert.equal(await sql(`select count(*) from public.manual_payout_receipts where transaction_reference=upper('${reference}');`), "1");
  assert.equal(await sql(`select count(*) from public.manual_payout_account_holds where custody_id='${ids.custody}';`), "1");
  assert.equal(await sql(`select count(*) from public.manual_payout_claims where payout_id in
    ('${receiptRaces[0].id}','${receiptRaces[1].id}');`), "2");
  const balance = JSON.parse((await run(ids.client, `public.manual_payout_balance('${ids.wedding}')`)).split("\n").find(line => line.startsWith("{")));
  assert.equal(balance.reserved_minor, 2200);
  assert.equal(balance.available_minor, 0);
  await assert.rejects(policy({ enabled: true }), /prerequisites/);
  // Shared merchant mode does not read a global bank balance. Only actual
  // contribution net proof and WeddingSite commitments constrain admission.
  const sharedAccount = randomUUID(), sharedContribution = randomUUID();
  await run(ids.owner, `public.manual_payout_register_account('${sharedAccount}','daraja','${randomUUID()}','${await evidence("account")}')`);
  const sharedScope = uuid(await run(ids.owner, `public.manual_payout_register_shared_account('${sharedAccount}','KES','${await evidence("custody")}')`));
  assert.ok(sharedScope);
  await sql(`begin;
    alter table public.contributions disable trigger guard_payment_environment;
    alter table public.contributions disable trigger guard_live_payment_context;
    insert into public.contributions(id,wedding_id,stream_name,pledged_amount_minor,paid_amount_minor,platform_fee_minor,net_paid_minor,
      currency,payment_status,verified_provider_payment,provider_fee_pending,provider_fee_minor,payment_environment,provider_name,paid_at)
    values('${sharedContribution}','${ids.wedding}','Isolated shared settlement',20000,20000,0,20000,
      'KES','paid',true,false,100,'live','daraja',now()-interval '3 days');
    set constraints all immediate;
    alter table public.contributions enable trigger guard_payment_environment;
    alter table public.contributions enable trigger guard_live_payment_context; commit;`);
  const settlementEvidence = await evidence("settlement");
  const attribute = line => `public.manual_payout_attribute_settlement('${sharedContribution}','${sharedScope}','${line}',19900,clock_timestamp(),'${settlementEvidence}')`;
  const creditRace = await Promise.allSettled([run(ids.maker, attribute(randomUUID())), run(ids.maker, attribute(randomUUID()))]);
  assert.equal(creditRace.filter(r => r.status === "fulfilled").length, 1, "One settled contribution credits once");
  assert.equal(await sql(`select count(*) from public.manual_payout_statement_batches where custody_id='${sharedScope}';`), "0");
  const sharedRequest = (key = randomUUID(), amount = 6000) => `public.manual_payout_request('${key}','${ids.wedding}',
    '${sharedScope}','${ids.recipient}',${amount},100,'KES')`;
  await policy({ enabled: false, custody_id: sharedScope, statement_max_age_minutes: null, daily_minor: 20000 });
  await policy({ enabled: true });
  const sharedReservations = await Promise.allSettled([run(ids.maker, sharedRequest()), run(ids.maker, sharedRequest())]);
  assert.equal(sharedReservations.filter(r => r.status === "fulfilled").length, 1,
    `Shared wedding net admits one: ${sharedReservations.map(r => r.status === "rejected" ? r.reason.message : r.value).join("\n")}`);
  assert.match(sharedReservations.find(r => r.status === "rejected").reason.message, /attributable settled wedding net/);
  const sharedPayout = uuid(sharedReservations.find(r => r.status === "fulfilled").value);
  await run(ids.checker, `public.manual_payout_transition('${sharedPayout}','approved')`);
  await deactivateWhileWaiting(`public.manual_payout_transition('${sharedPayout}','executing','${randomUUID()}')`);
  await run(ids.maker, `public.manual_payout_transition('${sharedPayout}','cancelled')`);
  await policy({ enabled: true });
  const sharedClaimed = uuid(await run(ids.maker, sharedRequest()));
  await run(ids.checker, `public.manual_payout_transition('${sharedClaimed}','approved')`);
  const feeControl = {};
  let feeReady;
  const feeSignal = new Promise(resolve => { feeReady = resolve; });
  const feeChange = sql(`begin; set local idle_in_transaction_session_timeout='30s';
    update public.contributions set provider_fee_pending=true where id='${sharedContribution}';
    select 'FEE_HELD';\n`, data => { if (data.includes("FEE_HELD")) feeReady(); }, feeControl);
  await Promise.race([feeSignal, feeChange.then(() => { throw new Error("Missing fee-change barrier"); })]);
  const feeWaiter = randomUUID();
  const feeDenied = assert.rejects(sql(`begin; set local statement_timeout='20s';
    set local application_name='${feeWaiter}'; ${actor(ids.maker)}
    select public.manual_payout_transition('${sharedClaimed}','executing','${randomUUID()}'); commit;`),
  /Insufficient attributable/);
  try { await waitForAdvisory(feeWaiter); } finally { feeControl.release(); }
  await Promise.all([feeChange, feeDenied]);
  assert.equal(await sql(`select count(*) from public.manual_payout_claims where payout_id='${sharedClaimed}';`), "0",
    "A committed unknown fee blocks the waiting claim without releasing the reservation");
  await sql(`update public.contributions set provider_fee_pending=false where id='${sharedContribution}';`);
  await revokeWhileWaiting(`public.manual_payout_transition('${sharedClaimed}','executing','${randomUUID()}')`, true);
  const sharedClaims = await Promise.allSettled([run(ids.maker, `public.manual_payout_transition('${sharedClaimed}','executing','${randomUUID()}')`),
    run(ids.maker, `public.manual_payout_transition('${sharedClaimed}','executing','${randomUUID()}')`)]);
  assert.equal(sharedClaims.filter(r => r.status === "fulfilled").length, 1, "One durable shared manual claim");
  const sharedReceiptEvidence = await evidence("receipt");
  await run(ids.maker, `public.manual_payout_report('${sharedClaimed}','${sharedClaimed}',6000,100,'KES',clock_timestamp(),'${sharedReceiptEvidence}')`);
  const sharedDebit = await evidence("statement"), sharedReconciliation = await evidence("reconciliation");
  const sharedBooked = await sql("select clock_timestamp()::text;");
  await policy({ enabled: false });
  const verifyTransfer = `public.manual_payout_verify_transfer('${sharedClaimed}','${sharedClaimed}',6000,100,'KES',
    '${sharedBooked}','${sharedDebit}','${sharedReconciliation}')`;
  await assert.rejects(run(ids.maker, verifyTransfer), /Independent reconciler/);
  const verifyReplays = await Promise.all([run(ids.checker, verifyTransfer), run(ids.checker, verifyTransfer)]);
  assert.equal(verifyReplays.length, 2);
  assert.equal(await sql(`select count(*) from public.manual_payout_transfer_verifications where payout_id='${sharedClaimed}';`), "1");
  assert.equal(await sql(`select public.manual_payout_state('${sharedClaimed}');`), "paid");
  assert.equal(await sql(`select count(*) from public.manual_payout_statement_batches where custody_id='${sharedScope}';`), "0",
    "Exact shared paid verification never fabricates global statements");
  console.log("Shared-account races: credit once, wedding-net overdraw, role revocation, OFF/claim serialization, durable single claim and exact OFF transaction verification replay passed.");
  console.log("Real default-OFF policy: replays, aggregate reservations, single claims, deactivation races, Owner CAS, revoked actors/reviewer, exact OFF reconciliation, and duplicate receipt holds passed.");
} finally {
  if (ids) await policy({ enabled: false });
}
