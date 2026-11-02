// Explicit opt-in; never npm-discovered. The entire isolated CI DB is destroyed
// by the workflow after this test. No production connection string is accepted.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";

const container = process.env.MANUAL_PAYOUT_TEST_DB_CONTAINER;
if (container !== "supabase_db_weddingsite") throw new Error("Explicit isolated local/CI database required.");
function sql(input) {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", ["exec", "-i", container, "psql", "-U", "postgres", "-d", "postgres", "-At", "-v", "ON_ERROR_STOP=1"]);
    let output = "", errors = "";
    child.stdout.on("data", c => { output += c; });
    child.stderr.on("data", c => { errors += c; });
    child.on("error", reject);
    child.on("exit", code => code === 0 ? resolve(output.trim()) : reject(new Error(errors)));
    child.stdin.end(input);
  });
}
const maker = randomUUID(), checker = randomUUID(), sender = randomUUID(), wedding = randomUUID();
const contribution = randomUUID(), custody = randomUUID(), recipient = randomUUID();
const evidence = Array.from({ length: 5 }, () => randomUUID());
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
    alter table public.contributions enable trigger guard_payment_environment;
    alter table public.contributions enable trigger guard_live_payment_context;
    insert into public.manual_payout_evidence(id,kind,external_reference,sha256,submitted_by) values
      ('${evidence[0]}','recipient','${randomUUID()}',repeat('a',64),'${maker}'),
      ('${evidence[1]}','custody','${randomUUID()}',repeat('b',64),'${maker}'),
      ('${evidence[2]}','settlement','${randomUUID()}',repeat('c',64),'${maker}'),
      ('${evidence[3]}','receipt','${randomUUID()}',repeat('d',64),'${sender}'),
      ('${evidence[4]}','receipt','${randomUUID()}',repeat('e',64),'${sender}');
    insert into public.manual_payout_evidence_checks(evidence_id,checked_by)
      select id,'${checker}' from public.manual_payout_evidence where id in (${evidence.map(e => `'${e}'`).join(",")});
    insert into public.manual_payout_custody(id,provider,account_reference,currency,available_minor,statement_at,evidence_id,recorded_by)
      values('${custody}','daraja','${randomUUID()}','KES',10000,now()-interval '1 day','${evidence[1]}','${maker}');
    insert into public.manual_payout_recipients(id,wedding_id,evidence_id,provider,currency,kyc_snapshot_hash,recorded_by)
      select '${recipient}','${wedding}','${evidence[0]}','daraja','KES',encode(extensions.digest(to_jsonb(k)::text,'sha256'),'hex'),'${maker}'
      from public.wedding_kyc k where wedding_id='${wedding}';
    insert into public.manual_payout_settlements(contribution_id,custody_id,statement_line_reference,settled_minor,evidence_id,recorded_by)
      values('${contribution}','${custody}','${randomUUID()}',10000,'${evidence[2]}','${maker}');
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
  await call(sender, `public.manual_payout_transition('${second}','executing','${randomUUID()}')`);
  const receipts = await Promise.allSettled([
    call(sender, `public.manual_payout_report('${payout}','CONCURRENT-RECEIPT',6000,0,'KES',now(),'${evidence[3]}')`),
    call(sender, `public.manual_payout_report('${second}','CONCURRENT-RECEIPT',3000,0,'KES',now(),'${evidence[4]}')`)
  ]);
  assert.equal(receipts.filter(r => r.status === "fulfilled").length, 1);
  assert.match(receipts.find(r => r.status === "rejected").reason.message, /unique/);
  assert.equal(await sql(`select count(*) from public.manual_payout_claims where payout_id in ('${payout}','${second}')`), "2");
  console.log("Two-connection replay, overdraw, execution claims and scoped receipt uniqueness passed.");
} finally {
  await sql(originalGate);
}
