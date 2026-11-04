import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
if(process.env.MANUAL_PAYOUT_TEST_DB_CONTAINER!=="supabase_db_weddingsite") throw new Error("Explicit isolated database required.");
function sql(input,onOutput=()=>{},control){
  return new Promise((resolve,reject)=>{
    const child=spawn("docker",["exec","-i","supabase_db_weddingsite","psql","-U","postgres","-d","postgres","-At","-v","ON_ERROR_STOP=1"]);
    let output="",errors="";
    child.stdout.on("data",c=>{output+=c;onOutput(output);});
    child.stderr.on("data",c=>{errors+=c;});
    child.on("error",reject); child.on("exit",code=>code===0?resolve(output.trim()):reject(new Error(errors)));
    if(control){control.release=()=>child.stdin.end("commit;\n");child.stdin.write(input);}else child.stdin.end(input);
  });
}
await sql(readFileSync(new URL("./manual-payout-readiness.sql",import.meta.url),"utf8")
  .replace(/rollback;\s*$/,()=>"create table public.fee_ci_context as select jsonb_object_agg(key,id) ids from mr_ids; commit;"));
const ids=JSON.parse(await sql("select ids from public.fee_ci_context;"));
const actor=id=>`set local role authenticated; select set_config('request.jwt.claim.sub','${id}',true);
  select set_config('request.jwt.claim.role','authenticated',true);`;
const run=(id,expr)=>sql(`begin;set local statement_timeout='20s';${actor(id)} select ${expr};commit;`);
const fee=(c,key=randomUUID(),amount=100)=>`public.owner_record_payment_fee('${key}','${c}',${amount},'statement','STMT-RACE1',false,true)`;
async function payment(){
  const c=randomUUID();
  await sql(`begin;alter table public.contributions disable trigger guard_payment_environment;
    alter table public.contributions disable trigger guard_live_payment_context;
    insert into public.contributions(id,wedding_id,stream_name,pledged_amount_minor,paid_amount_minor,platform_fee_minor,net_paid_minor,
      currency,payment_status,verified_provider_payment,provider_fee_pending,provider_fee_minor,payment_environment,
      provider_name,paid_at,funds_available_at,provider_reference)
      values('${c}','${ids.wedding}','Isolated concurrent fee',2000,2000,100,1900,'KES','paid',true,true,null,
      'live','daraja',now()-interval '4 days',now()-interval '1 day','${c}');
    set constraints all immediate;
    alter table public.contributions enable trigger guard_payment_environment;
    alter table public.contributions enable trigger guard_live_payment_context;commit;`);
  return c;
}
async function held(input){
  const name=randomUUID(),control={};let ready;const signal=new Promise(resolve=>{ready=resolve;});
  const task=sql(`begin;set local idle_in_transaction_session_timeout='30s';set local application_name='${name}';${input} select 'READY';\n`,
    out=>{if(out.includes("READY"))ready();},control);
  await Promise.race([signal,task.then(()=>{throw new Error("Missing barrier");})]);return{name,control,task};
}
const wait=(name,blocker)=>sql(`do $$ begin for i in 1..1000 loop perform pg_stat_clear_snapshot();
  if exists(select 1 from pg_stat_activity w where application_name='${name}' and wait_event='advisory'
    and exists(select 1 from pg_stat_activity b where application_name='${blocker}' and b.pid=any(pg_blocking_pids(w.pid)))) then return;end if;
  perform pg_sleep(0.01);end loop;raise exception 'Exact fee writer barrier absent';end $$;`);
const c=await payment(),key=randomUUID();
const replay=await Promise.all([run(ids.owner,fee(c,key)),run(ids.owner,fee(c,key))]);
assert.equal(replay[0],replay[1]);assert.equal(await sql(`select count(*) from public.owner_payment_fee_attestations where contribution_id='${c}';`),"1");
const c2=await payment();
const contenders=await Promise.allSettled([run(ids.owner,fee(c2)),run(ids.owner,fee(c2))]);
assert.equal(contenders.filter(x=>x.status==="fulfilled").length,1);
assert.match(contenders.find(x=>x.status==="rejected").reason.message,/Known fees cannot/);
// Refund holds commit first; Owner fee then reads the same locked wedding net.
const c3=await payment(),baseline=Number(await sql(`select public.simple_payout_available('${ids.wedding}');`));
const adjustment=randomUUID();
const writer=await held(`select pg_advisory_xact_lock(71110001);insert into public.payment_adjustments(provider,adjustment_kind,
  provider_adjustment_id,contribution_id,wedding_id,amount_minor,currency,status,hold_minor)
  values('paystack','refund','${adjustment}','${ids.contribution}','${ids.wedding}',1000,'KES','pending',1000);`);
const name=randomUUID(),pending=sql(`begin;set local statement_timeout='20s';set local application_name='${name}';
  ${actor(ids.owner)}select ${fee(c3)};commit;`);
try{await wait(name,writer.name);}finally{writer.control.release();}
await Promise.all([writer.task,pending]);
assert.equal(Number(await sql(`select public.simple_payout_available('${ids.wedding}');`)),baseline+1800-1000);
// Fee writer commits first; an existing request's claim sees only that final net.
const requestOut=await run(ids.client,`public.simple_payout_submit('${randomUUID()}','${ids.wedding}',1000,1,true)`);
const payout=requestOut.split("\n").find(x=>/^[0-9a-f-]{36}$/.test(x)&&!Object.values(ids).includes(x));assert.ok(payout);
const c4=await payment(),beforeClaim=Number(await sql(`select public.simple_payout_available('${ids.wedding}');`));
const feeWriter=await held(`${actor(ids.owner)}select ${fee(c4)};`);
const claimName=randomUUID(),claim=sql(`begin;set local statement_timeout='20s';set local application_name='${claimName}';${actor(ids.owner)}
  select public.simple_payout_action('${payout}','${randomUUID()}','processing',null,100,null,true,true,true);commit;`);
try{await wait(claimName,feeWriter.name);}finally{feeWriter.control.release();}
await Promise.all([feeWriter.task,claim]);
assert.equal(Number(await sql(`select public.simple_payout_available('${ids.wedding}');`)),beforeClaim+1800-100);
assert.equal(await sql(`select count(*) from public.simple_payout_claims where payout_id='${payout}';`),"1");
const known=await sql(`select provider_fee_minor from public.contributions where id='${c4}';`);
await sql(`begin;select set_config('request.jwt.claim.role','service_role',true);
  select public.record_verified_payment('daraja','${randomUUID()}','${c4}',2000,'KES','${c4}',150,now());commit;`);
assert.equal(await sql(`select provider_fee_minor from public.contributions where id='${c4}';`),known,"Later provider replay never overwrites known attested fee");
console.log("Owner fee two-connection replay/single-winner/refund-first/fee-first-claim and known-fee provider-replay protection passed.");
