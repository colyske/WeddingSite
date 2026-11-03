// Explicit opt-in; never npm-discovered. The entire isolated CI DB is destroyed
// by the workflow after this test. No production connection string is accepted.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";

const container = process.env.MANUAL_PAYOUT_TEST_DB_CONTAINER;
if (container !== "supabase_db_weddingsite") throw new Error("Explicit isolated local/CI database required.");
function sql(input, onOutput = () => {}, control) {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", ["exec", "-i", container, "psql", "-U", "postgres", "-d", "postgres", "-At", "-v", "ON_ERROR_STOP=1"]);
    let output = "", errors = "";
    child.stdout.on("data", c => { output += c; onOutput(output); });
    child.stderr.on("data", c => { errors += c; });
    child.on("error", reject);
    child.on("exit", code => code === 0 ? resolve(output.trim()) : reject(new Error(errors)));
    if (control) {
      control.release = () => child.stdin.end("commit;\n");
      child.stdin.write(input);
    } else child.stdin.end(input);
  });
}
const maker = randomUUID(), checker = randomUUID(), sender = randomUUID(), wedding = randomUUID();
const contribution = randomUUID(), custody = randomUUID(), recipient = randomUUID(), account = randomUUID(), batch = randomUUID();
const evidence = Array.from({ length: 9 }, () => randomUUID());
const originalGate = await sql("select pg_get_functiondef('public.manual_payouts_enabled()'::regprocedure);");
const actor = id => `set local role authenticated; select set_config('request.jwt.claim.sub','${id}',true);
  select set_config('request.jwt.claim.role','authenticated',true);`;
const call = (id, expression) => sql(`begin; set local statement_timeout='15s'; ${actor(id)}
  select ${expression}; select pg_sleep(0.2); commit;`);
const key = randomUUID();
const request = (requestKey, amount) => `public.manual_payout_request('${requestKey}','${wedding}','${custody}','${recipient}',${amount},0,'KES')`;
const idFrom = output => output.split("\n").find(line => /^[0-9a-f-]{36}$/.test(line) && ![maker, checker, sender].includes(line));
try {
  await sql(`begin;
    create or replace function public.manual_payouts_enabled() returns boolean language sql as $$ select true $$;
    insert into auth.users(id) values('${maker}'),('${checker}'),('${sender}');
    update public.profiles set platform_role='superadmin' where id in ('${maker}','${checker}','${sender}');
    insert into public.weddings(id,client_owner_id,couple_names,currency,wedding_date)
      values('${wedding}','${maker}','Isolated concurrent manual fixture','KES',current_date+30);
    insert into public.wedding_kyc(wedding_id,partner1_legal_name,partner1_id_type,partner1_id_number,
      partner1_nationality,partner1_phone,partner1_email,partner2_legal_name,partner2_id_type,partner2_id_number,
      partner2_nationality,partner2_phone,partner2_email,consent_at)
      values('${wedding}','Fixture One','passport','FIXTURE1','Kenyan','254700000001','one@example.test',
      'Fixture Two','passport','FIXTURE2','Kenyan','254700000002','two@example.test',now());
    alter table public.contributions disable trigger guard_payment_environment;
    alter table public.contributions disable trigger guard_live_payment_context;
    insert into public.contributions(id,wedding_id,stream_name,pledged_amount_minor,paid_amount_minor,
      platform_fee_minor,net_paid_minor,currency,payment_status,verified_provider_payment,provider_fee_pending,
      provider_fee_minor,payment_environment,provider_name,paid_at)
      values('${contribution}','${wedding}','Concurrent verified fixture',10000,10000,0,10000,'KES',
        'paid',true,false,0,'live','daraja',now()-interval '2 days');
    set constraints all immediate;
    alter table public.contributions enable trigger guard_payment_environment;
    alter table public.contributions enable trigger guard_live_payment_context;
    insert into public.manual_payout_evidence(id,kind,external_reference,sha256,submitted_by) values
      ('${evidence[0]}','recipient','${randomUUID()}',repeat('a',64),'${maker}'),
      ('${evidence[1]}','custody','${randomUUID()}',repeat('b',64),'${maker}'),
      ('${evidence[2]}','settlement','${randomUUID()}',repeat('c',64),'${maker}'),
      ('${evidence[3]}','receipt','${randomUUID()}',repeat('d',64),'${sender}'),
      ('${evidence[4]}','receipt','${randomUUID()}',repeat('e',64),'${sender}'),
      ('${evidence[5]}','account','${randomUUID()}',repeat('f',64),'${maker}'),
      ('${evidence[6]}','receipt','${randomUUID()}',repeat('1',64),'${sender}'),
      ('${evidence[7]}','statement','${randomUUID()}',repeat('2',64),'${maker}'),
      ('${evidence[8]}','reconciliation','${randomUUID()}',repeat('3',64),'${maker}');
    insert into public.manual_payout_evidence_checks(evidence_id,checked_by)
      select id,'${checker}' from public.manual_payout_evidence where id in (${evidence.map(e => `'${e}'`).join(",")});
    insert into public.manual_payout_accounts(id,provider,canonical_registry_reference,evidence_id,recorded_by)
      values('${account}','daraja','${randomUUID()}','${evidence[5]}','${maker}');
    insert into public.manual_payout_custody(id,provider,account_reference,currency,available_minor,statement_at,evidence_id,recorded_by)
      values('${custody}','daraja','${account}','KES',10000,now()-interval '1 day','${evidence[1]}','${maker}');
    insert into public.manual_payout_statement_batches(id,custody_id,statement_reference,statement_at,
      opening_minor,credit_minor,debit_minor,closing_minor,held_minor,evidence_id,statement_digest,recorded_by)
      values('${batch}','${custody}','${randomUUID()}',now()-interval '1 day',10000,0,0,10000,0,'${evidence[1]}',repeat('b',64),'${maker}');
    insert into public.manual_payout_recipients(id,wedding_id,evidence_id,provider,currency,kyc_snapshot_hash,recorded_by)
      select '${recipient}','${wedding}','${evidence[0]}','daraja','KES',encode(extensions.digest(to_jsonb(k)::text,'sha256'),'hex'),'${maker}'
      from public.wedding_kyc k where wedding_id='${wedding}';
    insert into public.manual_payout_settlements(contribution_id,custody_id,statement_line_reference,settled_minor,evidence_id,recorded_by,batch_id,settled_at)
      values('${contribution}','${custody}','${randomUUID()}',10000,'${evidence[2]}','${maker}','${batch}',now()-interval '36 hours');
    commit;`);
  const replay = await Promise.all([call(maker, request(key, 6000)), call(maker, request(key, 6000))]);
  const payout = idFrom(replay[0]);
  assert.ok(payout); assert.equal(payout, idFrom(replay[1]));
  const overdraw = await Promise.allSettled([call(maker, request(randomUUID(), 3000)), call(maker, request(randomUUID(), 3000))]);
  assert.equal(overdraw.filter(r => r.status === "fulfilled").length, 1, "Only one competing reservation fits");
  assert.match(overdraw.find(r => r.status === "rejected").reason.message, /Insufficient/);
  const second = idFrom(overdraw.find(r => r.status === "fulfilled").value);
  await call(checker, `public.manual_payout_transition('${payout}','approved')`);
  const claims = await Promise.allSettled([call(sender, `public.manual_payout_transition('${payout}','executing','${randomUUID()}')`),
    call(sender, `public.manual_payout_transition('${payout}','executing','${randomUUID()}')`)]);
  assert.equal(claims.filter(r => r.status === "fulfilled").length, 1);
  assert.match(claims.find(r => r.status === "rejected").reason.message, /already claimed/);
  await call(checker, `public.manual_payout_transition('${second}','approved')`);
  let markClaimReady;
  const claimReady = new Promise(resolve => { markClaimReady = resolve; });
  const manualClaim = sql(`begin; ${actor(sender)}
    select public.manual_payout_transition('${second}','executing','${randomUUID()}');
    select 'MANUAL_CLAIM_HELD'; select pg_sleep(1); commit;`,
    output => { if (output.includes("MANUAL_CLAIM_HELD")) markClaimReady(); });
  await Promise.race([claimReady, manualClaim.then(() => { throw new Error("Claim lock signal missing"); })]);
  // Isolated worker stand-in tests the shared protocol/PK, not an authorized
  // automatic adapter (whose independent policy tests belong to its own release).
  const otherRail = assert.rejects(sql(`begin; select pg_advisory_xact_lock(71110001);
    select public.manual_payout_lock('${custody}','${wedding}');
    select public.manual_payout_eligible('${wedding}','${custody}','${recipient}','KES',3000,'${second}');
    insert into public.manual_payout_claims(payout_id,execution_channel,claim_key,sender_id)
      values('${second}','automatic_b2c','${randomUUID()}','${checker}'); commit;`), /unique/);
  await Promise.all([manualClaim, otherRail]);
  assert.equal(await sql(`select count(*) from public.manual_payout_claims where payout_id in ('${payout}','${second}')`), "2");
  const third = idFrom(await call(maker, request(randomUUID(), 1000)));
  await call(checker, `public.manual_payout_transition('${third}','approved')`);
  let markReady;
  const ready = new Promise(resolve => { markReady = resolve; });
  const refund = sql(`begin;
    select id from public.contributions where id='${contribution}' for update;
    select id from public.weddings where id='${wedding}' for update;
    insert into public.payment_adjustments(provider,adjustment_kind,provider_adjustment_id,contribution_id,wedding_id,
      amount_minor,currency,status,hold_minor)
      values('paystack','refund','isolated-concurrent-refund','${contribution}','${wedding}',100,'KES','pending',100);
    select 'REFUND_LOCKED'; select pg_sleep(1); commit;`,
    output => { if (output.includes("REFUND_LOCKED")) markReady(); });
  await Promise.race([ready, refund.then(() => { throw new Error("Refund lock signal missing"); })]);
  const execution = assert.rejects(call(sender, `public.manual_payout_transition('${third}','executing','${randomUUID()}')`), /Insufficient/);
  await Promise.all([refund, execution]);
  // Prove authorization is re-read AFTER an advisory wait, not just at admission.
  const revoked = randomUUID();
  await sql(`insert into auth.users(id) values('${revoked}');`);
  await call(sender, `public.manual_payout_report('${payout}','FIRST-RECEIPT',6000,0,'KES',now(),'${evidence[6]}')`);
  const reported = payout;
  const attempts = [
    request(randomUUID(), 1000),
    `public.manual_payout_transition('${third}','executing','${randomUUID()}')`,
    `public.manual_payout_reconcile('${reported}','daraja','${account}','${randomUUID()}','${randomUUID()}','FIRST-RECEIPT',6000,0,'KES',now(),'${evidence[3]}')`
  ];
  for (let index = 0; index < attempts.length; index++) {
    await sql(`update public.profiles set platform_role='superadmin' where id='${revoked}';`);
    let markBarrier;
    const barrierReady = new Promise(resolve => { markBarrier = resolve; });
    const control = {};
    const barrier = sql(`begin; set local idle_in_transaction_session_timeout='20s';
      select pg_advisory_xact_lock(71110001); select 'REVOCATION_BARRIER';\n`,
      output => { if (output.includes("REVOCATION_BARRIER")) markBarrier(); }, control);
    await Promise.race([barrierReady, barrier.then(() => { throw new Error("Missing role barrier"); })]);
    const name = `manual-revoke-${index}`;
    const waiting = assert.rejects(sql(`begin; set local statement_timeout='15s';
      set local application_name='${name}'; ${actor(revoked)} select ${attempts[index]}; commit;`), /authority revoked/);
    try {
      await sql(`do $$ begin
        for i in 1..1000 loop
          perform pg_stat_clear_snapshot();
          if exists(select 1 from pg_stat_activity where application_name='${name}' and wait_event='advisory') then return; end if;
          perform pg_sleep(0.01);
        end loop;
        raise exception 'Writer did not reach the role-revocation advisory wait';
      end $$;
      update public.profiles set platform_role='client' where id='${revoked}';`);
    } finally { control.release(); }
    await Promise.all([barrier, waiting]);
  }
  await sql(`update public.payment_adjustments set status='failed',hold_minor=0
    where provider_adjustment_id='isolated-concurrent-refund' and wedding_id='${wedding}';`);
  const statement = randomUUID();
  const booked = await sql("select clock_timestamp()::text;");
  const debitBatch = idFrom(await call(maker, `public.manual_payout_append_statement('${custody}','${batch}',
    '${statement}',clock_timestamp(),10000,0,6000,4000,0,'${evidence[7]}')`));
  const observed = await Promise.allSettled([randomUUID(), randomUUID()].map(line =>
    call(maker, `public.manual_payout_register_statement_debit('${debitBatch}','${line}','FIRST-RECEIPT',
      6000,0,'KES','${booked}','${evidence[7]}')`)));
  assert.equal(observed.filter(r => r.status === "fulfilled").length, 1, "One immutable statement observation owns the unique reference/capacity");
  assert.match(observed.find(r => r.status === "rejected").reason.message, /unique/);
  const observedLine = await sql(`select line_reference from public.manual_payout_statement_debit_entries where batch_id='${debitBatch}';`);
  assert.equal(await sql(`select public.manual_payout_state('${payout}');`), "reported", "Intake alone cannot declare paid");
  const finalize = `public.manual_payout_reconcile('${payout}','daraja','${account}','${statement}','${observedLine}',
    'FIRST-RECEIPT',6000,0,'KES','${booked}','${evidence[8]}')`;
  const reconciled = await Promise.allSettled([call(checker, finalize), call(checker, finalize)]);
  assert.equal(reconciled.filter(r => r.status === "fulfilled").length, 1, "Exactly one atomic reconciliation may finalize");
  assert.match(reconciled.find(r => r.status === "rejected").reason.message, /Reported claimed transfer/);
  assert.equal(await sql(`select count(*) from public.manual_payout_events e
    join public.manual_payout_reconciliations r on r.payout_id=e.payout_id
    join public.manual_payout_statement_debits d on d.payout_id=r.payout_id
    where e.payout_id='${payout}' and e.state='paid' and d.batch_id='${debitBatch}' and d.line_reference='${observedLine}';`), "1");
  await call(sender, `public.manual_payout_transition('${third}','executing','${randomUUID()}')`);
  const receipts = await Promise.all([
    call(sender, `public.manual_payout_report('${third}','CONCURRENT-RECEIPT',1000,0,'KES',now(),'${evidence[3]}')`),
    call(sender, `public.manual_payout_report('${second}','CONCURRENT-RECEIPT',3000,0,'KES',now(),'${evidence[4]}')`)
  ]);
  assert.equal(receipts.filter(output => output.split("\n").includes("t")).length, 1, "One receipt accepted");
  assert.equal(receipts.filter(output => output.split("\n").includes("f")).length, 1, "Conflicting receipt explicitly held");
  assert.equal(await sql(`select count(*) from public.manual_payout_account_holds where custody_id='${custody}'`), "1");
  await assert.rejects(call(maker, request(randomUUID(), 1000)), /Held custody account/);
  console.log("Two-connection replay, overdraw, cross-rail claims, atomic observed-debit reconciliation, duplicate receipts and refund/execution race passed.");
} finally {
  await sql(originalGate);
}
