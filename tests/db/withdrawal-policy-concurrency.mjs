import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
if(process.env.MANUAL_PAYOUT_TEST_DB_CONTAINER!=="supabase_db_weddingsite")throw new Error("Explicit isolated database required.");
function sql(input,onOutput=()=>{},control){
  return new Promise((resolve,reject)=>{
    const child=spawn("docker",["exec","-i","supabase_db_weddingsite","psql","-U","postgres","-d","postgres","-At","-v","ON_ERROR_STOP=1"]);
    let output="",errors="";
    child.stdout.on("data",c=>{output+=c;onOutput(output);});child.stderr.on("data",c=>{errors+=c;});
    child.on("error",reject);child.on("exit",code=>code===0?resolve(output.trim()):reject(new Error(errors)));
    if(control){control.release=()=>child.stdin.end("commit;\n");child.stdin.write(input);}else child.stdin.end(input);
  });
}
await sql(readFileSync(new URL("./manual-payout-readiness.sql",import.meta.url),"utf8")
  .replace(/rollback;\s*$/,()=>"create table public.withdrawal_ci_context as select jsonb_object_agg(key,id) ids from mr_ids; commit;"));
const ids=JSON.parse(await sql("select ids from public.withdrawal_ci_context;"));
const actor=id=>`set local role authenticated;select set_config('request.jwt.claim.sub','${id}',true);
  select set_config('request.jwt.claim.role','authenticated',true);`;
const run=(id,expr)=>sql(`begin;set local statement_timeout='20s';${actor(id)}select ${expr};commit;`);
const uuid=output=>output.split("\n").find(x=>/^[0-9a-f-]{36}$/.test(x)&&!Object.values(ids).includes(x));
await run(ids.owner,`public.admin_save_policies('{"withdrawal_processing_fee_minor":100,"min_payout_minor":1000,"max_payout_minor":10000}')`);
const revision=Number(await sql("select withdrawal_policy_revision from public.platform_policies where id=true;"));
const request=(key=randomUUID(),amount=1000,fee=100,rev=revision)=>`public.simple_payout_submit('${key}','${ids.wedding}',${amount},1,true,${fee},${rev})`;
const claim=p=>`public.simple_payout_action('${p}','${randomUUID()}','processing',null,null,null,true,true,true)`;
const available=()=>sql(`select public.simple_payout_available('${ids.wedding}');`).then(Number);
const baseline=await available(),key=randomUUID();
const replay=await Promise.all([run(ids.client,request(key)),run(ids.client,request(key))]);
assert.equal(replay[0],replay[1]);const p=uuid(replay[0]);assert.ok(p);
assert.equal(await available(),baseline-1100);
const contenders=await Promise.allSettled([run(ids.client,request(randomUUID(),9000)),run(ids.client,request(randomUUID(),9000))]);
assert.equal(contenders.filter(x=>x.status==="fulfilled").length,1);
assert.match(contenders.find(x=>x.status==="rejected").reason.message,/plus processing fee/);
const claims=await Promise.allSettled([run(ids.owner,claim(p)),run(ids.owner,claim(p))]);
assert.equal(claims.filter(x=>x.status==="fulfilled").length,1);
assert.match(claims.find(x=>x.status==="rejected").reason.message,/Already claimed/);
assert.equal(await available(),baseline-10200,"Claim adds no second customer/provider fee");
async function held(input){
  const name=randomUUID(),control={};let ready;const signal=new Promise(resolve=>{ready=resolve;});
  const task=sql(`begin;set local idle_in_transaction_session_timeout='30s';set local application_name='${name}';${input}select 'READY';\n`,
    out=>{if(out.includes("READY"))ready();},control);
  await Promise.race([signal,task.then(()=>{throw new Error("Missing barrier");})]);return{name,control,task};
}
const wait=(name,blocker)=>sql(`do $$ begin for i in 1..1000 loop perform pg_stat_clear_snapshot();
  if exists(select 1 from pg_stat_activity w where application_name='${name}' and wait_event='advisory'
    and exists(select 1 from pg_stat_activity b where application_name='${blocker}' and b.pid=any(pg_blocking_pids(w.pid)))) then return;end if;
  perform pg_sleep(0.01);end loop;raise exception 'Exact withdrawal writer barrier absent';end $$;`);
const writer=await held(`select pg_advisory_xact_lock(71110001);${actor(ids.owner)}
  select public.admin_save_policies('{"withdrawal_processing_fee_minor":200}');`);
const name=randomUUID(),stale=sql(`begin;set local statement_timeout='20s';set local application_name='${name}';${actor(ids.client)}
  select ${request()};commit;`).then(()=>null,e=>e);
try{await wait(name,writer.name);}finally{writer.control.release();}
await writer.task;assert.match((await stale)?.message,/quote changed/);
assert.equal(await available(),baseline-10200,"Stale quote made no reservation");
assert.equal(await run(ids.client,request(key)),replay[0],"Policy change does not reprice replay");
await assert.rejects(run(ids.client,`public.simple_payout_submit('${randomUUID()}','${ids.wedding}',1000,1,true)`),/quote changed/);
const newRevision=Number(await sql("select withdrawal_policy_revision from public.platform_policies where id=true;"));
const next=uuid(await run(ids.client,request(randomUUID(),1000,200,newRevision)));
const beforeRefund=await available(),refund=beforeRefund+100;
const refundWriter=await held(`select pg_advisory_xact_lock(71110001);
  insert into public.payment_adjustments(provider,adjustment_kind,provider_adjustment_id,contribution_id,wedding_id,
    amount_minor,currency,status,hold_minor) values('paystack','refund','${randomUUID()}','${ids.contribution}','${ids.wedding}',
    ${refund},'KES','pending',${refund});`);
const claimName=randomUUID(),pendingClaim=sql(`begin;set local statement_timeout='20s';set local application_name='${claimName}';
  ${actor(ids.owner)}select ${claim(next)};commit;`).then(()=>null,e=>e);
try{await wait(claimName,refundWriter.name);}finally{refundWriter.control.release();}
await refundWriter.task;assert.match((await pendingClaim)?.message,/recorded adjustment deficit/);
assert.equal(await sql(`select public.simple_payout_balance_raw('${ids.wedding}');`),"-100");
assert.equal(await sql(`select count(*) from public.simple_payout_claims where payout_id='${p}';`),"1");
assert.equal(await sql(`select public.simple_payout_state('${p}');`),"hold");
const paidKey=randomUUID(),paid=`public.simple_payout_action('${p}','${paidKey}','paid',null,null,'CUSTOMER-RACE1',false,false,true)`;
await run(ids.owner,paid);await run(ids.owner,paid);
assert.equal(await sql(`select public.simple_payout_balance_raw('${ids.wedding}');`),"-100","Actual Paid and replay never erase deficit or release fee reservation");
assert.equal(await sql(`select count(*) from public.simple_payout_receipts where payout_id='${p}';`),"1");
console.log("Withdrawal two-connection replay/overdraw/single claim, stale-policy race, immutable old quote, refund-before-claim and refund-after-durable-claim/Paid replay passed.");
