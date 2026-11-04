import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";

if (process.env.MANUAL_PAYOUT_TEST_DB_CONTAINER !== "supabase_db_weddingsite") throw new Error("Explicit isolated CI container required.");
function sql(input, output = () => {}, control) {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", ["exec", "-i", "supabase_db_weddingsite", "psql", "-U", "postgres", "-d", "postgres", "-At", "-v", "ON_ERROR_STOP=1"]);
    let stdout = "", stderr = "";
    child.stdout.on("data", chunk => { stdout+=chunk; output(stdout); });
    child.stderr.on("data", chunk => { stderr+=chunk; });
    child.on("error", reject);
    child.on("exit", code => code===0 ? resolve(stdout.trim()) : reject(new Error(stderr)));
    if (control) { control.release = () => child.stdin.end("commit;\n"); child.stdin.write(input); }
    else child.stdin.end(input);
  });
}
const fixture = readFileSync(new URL("./manual-payout-readiness.sql", import.meta.url), "utf8")
  .replace(/rollback;\s*$/, () => "create table public.simple_ci_context as select jsonb_object_agg(key,id) ids from mr_ids; commit;");
await sql(fixture);
const ids = JSON.parse(await sql("select ids from public.simple_ci_context;"));
const actor = id => `set local role authenticated; select set_config('request.jwt.claim.sub','${id}',true);
  select set_config('request.jwt.claim.role','authenticated',true);`;
const run = (id, expr) => sql(`begin; set local statement_timeout='20s'; ${actor(id)} select ${expr}; commit;`);
const uuid = text => text.split("\n").find(x => /^[0-9a-f-]{36}$/.test(x) && !Object.values(ids).includes(x));
const request = (key = randomUUID(), amount = 1000, wedding = ids.wedding) => `public.simple_payout_submit('${key}','${wedding}',${amount},1,true)`;
const action = (id, state, key = randomUUID(), fee = null, reference = null, solo = true) => `public.simple_payout_action(
  '${id}','${key}','${state}',${state==="hold" ? "'outcome_uncertain'" : "null"},${fee},${reference ? `'${reference}'` : "null"},
  ${state==="processing" && solo},${["processing","reviewed"].includes(state)},true)`;
const wait = (name, event, blocker) => sql(`do $$ begin for i in 1..1000 loop
  perform pg_stat_clear_snapshot();
  if exists(select 1 from pg_stat_activity w where application_name='${name}' and wait_event='${event}'
    and exists(select 1 from pg_stat_activity b where application_name='${blocker}' and b.pid=any(pg_blocking_pids(w.pid)))) then return; end if;
  perform pg_sleep(0.01);
end loop; raise exception 'Expected exact writer lock never observed'; end $$;`);
async function held(input) {
  const control = {}, name = randomUUID();
  let ready; const signal = new Promise(resolve => { ready=resolve; });
  const task = sql(`begin; set local idle_in_transaction_session_timeout='30s'; set local application_name='${name}';
    ${input} select 'READY';\n`, out => { if (out.includes("READY")) ready(); }, control);
  await Promise.race([signal, task.then(() => { throw new Error("Missing barrier"); })]);
  return { control, task, name };
}
const key = randomUUID();
const replay = await Promise.all([run(ids.client, request(key)), run(ids.client, request(key))]);
const p = uuid(replay[0]); assert.ok(p); assert.equal(uuid(replay[1]), p);
await assert.rejects(run(ids.client, request(key,1001)), /retry changed/);
await run(ids.owner, action(p,"cancelled"));
const competing = await Promise.allSettled([run(ids.client,request(randomUUID(),9000)),run(ids.client,request(randomUUID(),9000))]);
assert.equal(competing.filter(x => x.status==="fulfilled").length,1);
assert.match(competing.find(x => x.status==="rejected").reason.message,/exceeds available/);
const competingId = uuid(competing.find(x => x.status==="fulfilled").value);
await run(ids.owner,action(competingId,"cancelled"));
const cancelId = uuid(await run(ids.client,request()));
const cancelRace = await Promise.allSettled([run(ids.owner,action(cancelId,"processing",randomUUID(),0)),run(ids.owner,action(cancelId,"cancelled"))]);
assert.equal(cancelRace.filter(x => x.status==="fulfilled").length,1,"Processing/cancel have one immutable winner");
if (await sql(`select public.simple_payout_state('${cancelId}');`)==="processing") await run(ids.owner,action(cancelId,"paid",randomUUID(),null,cancelId));
const feeId = uuid(await run(ids.client,request()));
const feeWriter = await held(`update public.contributions set provider_fee_pending=true where id='${ids.contribution}';`);
const feeWaiter = randomUUID();
const deniedFee = assert.rejects(sql(`begin; set local statement_timeout='20s'; set local application_name='${feeWaiter}';
  ${actor(ids.owner)} select ${action(feeId,"processing",randomUUID(),0)}; commit;`), /Balance changed/);
try { await wait(feeWaiter,"transactionid",feeWriter.name); } finally { feeWriter.control.release(); }
await Promise.all([feeWriter.task,deniedFee]);
assert.equal(await sql(`select count(*) from public.simple_payout_claims where payout_id='${feeId}';`),"0");
await sql(`update public.contributions set provider_fee_pending=false where id='${ids.contribution}';`);
for (const kind of ["refund","dispute"]) {
  const adjustment = randomUUID();
  const unreserved = await sql(`select public.simple_payout_available('${ids.wedding}');`);
  const writer = await held(`insert into public.payment_adjustments(provider,adjustment_kind,provider_adjustment_id,contribution_id,wedding_id,
    amount_minor,currency,status,hold_minor) values('paystack','${kind}','${adjustment}','${ids.contribution}',
    '${ids.wedding}',${unreserved},'KES','pending',${unreserved});`);
  const name = randomUUID();
  const denied = assert.rejects(sql(`begin; set local statement_timeout='20s'; set local application_name='${name}';
    ${actor(ids.owner)} select ${action(feeId,"processing",randomUUID(),1)}; commit;`), /Balance changed/);
  try { await wait(name,"advisory",writer.name); } finally { writer.control.release(); }
  await Promise.all([writer.task,denied]);
  await sql(`update public.payment_adjustments set status='failed',hold_minor=0 where provider_adjustment_id='${adjustment}';`);
}
// Role revocation while the action waits on the shared financial lock.
await run(ids.maker,action(feeId,"reviewed",randomUUID(),null,null,false));
const roleWriter = await held("select pg_advisory_xact_lock(71110001);");
const roleWaiter = randomUUID();
const deniedRole = assert.rejects(sql(`begin; set local statement_timeout='20s'; set local application_name='${roleWaiter}';
  ${actor(ids.checker)} select ${action(feeId,"processing",randomUUID(),0,null,false)}; commit;`), /Leadership access/);
try {
  await wait(roleWaiter,"advisory",roleWriter.name);
  await sql(`update public.profiles set platform_role='client' where id='${ids.checker}';`);
} finally { roleWriter.control.release(); }
await Promise.all([roleWriter.task,deniedRole]);
await sql(`update public.profiles set platform_role='superadmin' where id='${ids.checker}';`);
const reviewerWriter = await held("select pg_advisory_xact_lock(71110001);");
const reviewerWaiter = randomUUID();
const deniedReviewer = assert.rejects(sql(`begin; set local statement_timeout='20s'; set local application_name='${reviewerWaiter}';
  ${actor(ids.checker)} select ${action(feeId,"processing",randomUUID(),0,null,false)}; commit;`), /Another eligible leader/);
try {
  await wait(reviewerWaiter,"advisory",reviewerWriter.name);
  await sql(`update public.profiles set platform_role='client' where id='${ids.maker}';`);
} finally { reviewerWriter.control.release(); }
await Promise.all([reviewerWriter.task,deniedReviewer]);
await sql(`update public.profiles set platform_role='superadmin' where id='${ids.maker}';`);
const claims = await Promise.allSettled([run(ids.owner,action(feeId,"processing",randomUUID(),100)),run(ids.owner,action(feeId,"processing",randomUUID(),100))]);
assert.equal(claims.filter(x => x.status==="fulfilled").length,1,"One durable claim, never expires");
const paidKey = randomUUID();
await Promise.all([run(ids.owner,action(feeId,"paid",paidKey,null,feeId)),run(ids.owner,action(feeId,"paid",paidKey,null,feeId))]);
assert.equal(await sql(`select count(*) from public.simple_payout_receipts where payout_id='${feeId}';`),"1");
const reported = [];
const otherWedding = randomUUID(), otherContribution = randomUUID();
await sql(`begin;
  insert into public.weddings(id,client_owner_id,couple_names,currency,wedding_date)
    values('${otherWedding}','${ids.client}','Second isolated wedding','KES',current_date+30);
  insert into public.wedding_kyc select (jsonb_populate_record(null::public.wedding_kyc,
    to_jsonb(k)||jsonb_build_object('wedding_id','${otherWedding}'))).*
    from public.wedding_kyc k where wedding_id='${ids.wedding}';
  alter table public.contributions disable trigger guard_payment_environment;
  alter table public.contributions disable trigger guard_live_payment_context;
  insert into public.contributions(id,wedding_id,stream_name,pledged_amount_minor,paid_amount_minor,
    platform_fee_minor,net_paid_minor,currency,payment_status,verified_provider_payment,provider_fee_pending,
    provider_fee_minor,payment_environment,provider_name,paid_at)
    values('${otherContribution}','${otherWedding}','Second isolated net',20000,20000,0,20000,'KES',
      'paid',true,false,0,'live','daraja',now()-interval '3 days');
  set constraints all immediate;
  alter table public.contributions enable trigger guard_payment_environment;
  alter table public.contributions enable trigger guard_live_payment_context;
commit;`);
for(let i=0;i<2;i++){
  const id=uuid(await run(ids.client,request(randomUUID(),1000,i===0 ? ids.wedding : otherWedding)));
  await run(ids.owner,action(id,"processing",randomUUID(),0)); reported.push(id);
}
// Claim wins the shared lock first. The actual refund waits, then persists a
// deficit rather than pretending the durable claim disappeared or rejecting fact.
const deficitPayout=uuid(await run(ids.client,request()));
const unreserved=await sql(`select public.simple_payout_available('${ids.wedding}');`);
const claimWriter=await held(`${actor(ids.owner)} select ${action(deficitPayout,"processing",randomUUID(),0)};`);
const refundWaiter=randomUUID(), adjustment=randomUUID();
const refund=sql(`begin; set local statement_timeout='20s'; set local application_name='${refundWaiter}';
  select pg_advisory_xact_lock(71110001);
  insert into public.payment_adjustments(provider,adjustment_kind,provider_adjustment_id,contribution_id,wedding_id,
    amount_minor,currency,status,hold_minor) values('paystack','refund','${adjustment}','${ids.contribution}',
    '${ids.wedding}',${Number(unreserved)+1},'KES','pending',${Number(unreserved)+1}); commit;`);
try { await wait(refundWaiter,"advisory",claimWriter.name); } finally { claimWriter.control.release(); }
await Promise.all([claimWriter.task,refund]);
assert.equal(await sql(`select public.simple_payout_state('${deficitPayout}');`),"hold");
assert.equal(await sql(`select count(*) from public.simple_payout_claims where payout_id='${deficitPayout}';`),"1");
assert.equal(await sql(`select count(*) from public.payment_adjustments where provider_adjustment_id='${adjustment}';`),"1");
assert.equal(await sql(`select max(deficit_minor) from public.simple_payout_deficits where wedding_id='${ids.wedding}';`),"1");
await assert.rejects(run(ids.client,request()),/recorded adjustment deficit/);
await assert.rejects(run(ids.owner,action(deficitPayout,"cancelled")),/already been claimed/);
const deficitPaidKey=randomUUID();
await run(ids.owner,action(deficitPayout,"paid",deficitPaidKey,null,deficitPayout));
await run(ids.owner,action(deficitPayout,"paid",deficitPaidKey,null,deficitPayout));
assert.equal(await sql(`select count(*) from public.simple_payout_deficits where wedding_id='${ids.wedding}';`),"1");
const ref = randomUUID();
const outcomes = await Promise.all(reported.map(id=>run(ids.owner,action(id,"paid",randomUUID(),null,ref))));
assert.equal(outcomes.filter(x=>x.includes('"conflict": true')).length,1);
assert.equal(await sql(`select count(*) from public.simple_payout_receipts where transaction_reference=upper('${ref}');`),"1");
assert.equal(await sql("select count(*) from public.simple_payout_incidents;"),"1");
const heldId=await sql(`select payout_id from public.simple_payout_incidents;`);
await assert.rejects(run(ids.owner,action(heldId,"cancelled")),/already been claimed/);
await sql(`do $$ begin if public.live_payouts_enabled() then raise exception 'B2C gate changed'; end if; end $$;`);
console.log("Simple two-connection replay/overdraw/cancel-claim/fee/refund/dispute/revoked-actor-and-reviewer/single-claim/Paid-replay/cross-wedding duplicate-ID retained-hold tests passed.");
