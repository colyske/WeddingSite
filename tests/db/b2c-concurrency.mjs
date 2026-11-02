// Explicit isolated database runner only. Never imported by npm test.
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";

const container = process.env.B2C_TEST_DB_CONTAINER;
if (!container || !/^(supabase_db_weddingsite|weddingsite_b2c_ci_[a-z0-9]+)$/.test(container)) {
  throw new Error("An explicitly named isolated local B2C test database is required.");
}
const sql = statement => new Promise((resolve, reject) => {
  const child = spawn("docker", ["exec", "-i", container, "psql", "-U", "postgres", "-d", "postgres", "-At", "-v", "ON_ERROR_STOP=1"]);
  let output = "", errors = "";
  child.stdout.on("data", chunk => { output += chunk; });
  child.stderr.on("data", chunk => { errors += chunk; });
  child.on("error", reject);
  child.on("exit", code => code === 0 ? resolve(output.trim()) : reject(new Error(errors)));
  child.stdin.end(statement);
});
let context;
let originalGate;
let originalPolicy;
try {
  originalGate = await sql("select pg_get_functiondef('public.manual_payout_require_enabled()'::regprocedure);");
  originalPolicy = JSON.parse(await sql("select to_jsonb(p) from public.b2c_policy p;"));
  const fixture = readFileSync(new URL("./b2c.sql", import.meta.url), "utf8")
    .replace("begin;", "begin; create table public.b2c_ci_context(data jsonb); set local b2c.test_concurrency='on';")
    .replace(/rollback;\s*$/, "commit;");
  await sql(fixture);
  context = JSON.parse(await sql("select data from public.b2c_ci_context;"));
  // Transactional sandbox-only substitute: exercise the manual path while its
  // shipped gate remains hard OFF. No dispatcher/provider exists in this runner.
  await sql(`create or replace function public.manual_payout_require_enabled() returns void
    language plpgsql security definer set search_path='' as $$
    begin perform public.require_staff('superadmin'); perform pg_advisory_xact_lock(71110001); end $$;`);
  const run = (actor, statement) => sql(`begin; set local statement_timeout='20s';
    set local role authenticated;
    select set_config('request.jwt.claim.role','authenticated',true);
    select set_config('request.jwt.claim.sub','${actor}',true);
    ${statement}; select pg_sleep(0.2); commit;`);
  const autoKey = randomUUID(), manualKey = randomUUID();
  const requests = await Promise.allSettled([
    run(context.client, `select public.b2c_request('${autoKey}','${context.wedding}','${context.custody}','${context.recipient}',40000)`),
    run(context.staff, `select public.manual_payout_request('${manualKey}','${context.wedding}','${context.custody}','${context.recipient}',40000,100,'KES')`)
  ]);
  assert.equal(requests.filter(r => r.status === "fulfilled").length, 1, "Only one rail may reserve the last available funds");
  const rejected = requests.find(r => r.status === "rejected");
  assert.match(rejected.reason.message, /Insufficient|insufficient/);
  assert.equal(await sql(`select count(*) from public.manual_payout_requests where request_key in ('${autoKey}','${manualKey}');`), "1");

  // Race actual execution wrappers for a new small request. Test fixture only:
  // reserve capacity is already occupied; cancel the unclaimed race winner first.
  await sql(`begin;
    insert into public.manual_payout_events(payout_id,state,actor_id)
      select id,'cancelled','${context.owner}' from public.manual_payout_requests
      where request_key in ('${autoKey}','${manualKey}');
    select set_config('request.jwt.claim.sub','${context.owner}',true);
    select public.owner_update_b2c_policy((select revision from public.b2c_policy),
      '{"daily_minor":100000,"require_four_eyes":true}','Synthetic actual-wrapper concurrent claims');
    commit;`);
  const claimKey = randomUUID();
  await run(context.client, `select public.b2c_request('${claimKey}','${context.wedding}','${context.custody}','${context.recipient}',10000)`);
  const payout = await sql(`select id from public.manual_payout_requests where request_key='${claimKey}';`);
  await run(context.owner, `select public.staff_approve_b2c('${payout}')`);
  await run(context.staff, `select public.staff_approve_b2c('${payout}')`);
  const other = randomUUID();
  await sql(`begin; insert into auth.users(id) values('${other}');
    select set_config('request.jwt.claim.sub','${context.owner}',true);
    select public.assign_platform_role('${other}','superadmin'); commit;`);
  context.other = other;
  const results = await Promise.allSettled([
    sql(`begin; set local statement_timeout='20s';
      select set_config('request.jwt.claim.role','service_role',true);
      select public.b2c_claim('${payout}','${randomUUID()}',repeat('f',64),'123456','BusinessPayment',false);
      select pg_sleep(0.2); commit;`),
    run(other, `select public.manual_payout_transition('${payout}','executing','${randomUUID()}')`)
  ]);
  assert.equal(await sql(`select count(*) from public.manual_payout_claims where payout_id='${payout}';`), "1");
  const channel = await sql(`select execution_channel from public.manual_payout_claims where payout_id='${payout}';`);
  if (channel === "automatic_b2c") {
    assert.equal(results[1].status, "rejected");
    assert.match(results[1].reason.message, /Another execution channel/);
  } else {
    assert.equal(results[0].status, "fulfilled");
    assert.match(results[0].value, /"claimed": false/);
  }
  console.log("Actual manual/automatic reservation and execution wrappers serialize without double-spend or dual send claim.");
} finally {
  if (originalGate) await sql(originalGate);
  if (context) {
    // Exact fixture IDs only; disable immutable/FK triggers solely for isolated cleanup.
    const users = [context.owner, context.staff, context.client, context.other].filter(Boolean).map(v => `'${v}'`).join(",");
    await sql(`begin; set local session_replication_role=replica;
      delete from public.b2c_callback_events where dispatch_id in (select id from public.b2c_dispatches where payout_id in
        (select id from public.manual_payout_requests where wedding_id='${context.wedding}'));
      delete from public.b2c_dispatches where payout_id in (select id from public.manual_payout_requests where wedding_id='${context.wedding}');
      delete from public.b2c_human_reviews where payout_id in (select id from public.manual_payout_requests where wedding_id='${context.wedding}');
      delete from public.b2c_request_intents where payout_id in (select id from public.manual_payout_requests where wedding_id='${context.wedding}');
      delete from public.manual_payout_receipts where payout_id in (select id from public.manual_payout_requests where wedding_id='${context.wedding}');
      delete from public.manual_payout_claims where payout_id in (select id from public.manual_payout_requests where wedding_id='${context.wedding}');
      delete from public.manual_payout_events where payout_id in (select id from public.manual_payout_requests where wedding_id='${context.wedding}');
      delete from public.manual_payout_requests where wedding_id='${context.wedding}';
      delete from public.manual_payout_settlements where custody_id='${context.custody}';
      delete from public.b2c_custody_bindings where custody_id='${context.custody}';
      delete from public.manual_payout_custody where id='${context.custody}';
      delete from public.b2c_destinations where recipient_id='${context.recipient}';
      delete from public.b2c_reviewed_destinations where recipient_id='${context.recipient}';
      delete from public.manual_payout_recipients where wedding_id='${context.wedding}';
      delete from public.manual_payout_evidence_checks where evidence_id in (select id from public.manual_payout_evidence where submitted_by in (${users}));
      delete from public.manual_payout_evidence where submitted_by in (${users});
      delete from public.b2c_phone_attempts where user_id in (${users});
      delete from public.b2c_policy_history where actor_id in (${users});
      update public.b2c_policy set (revision,enabled,require_four_eyes,custody_ids,recipient_ids,per_payout_minor,daily_minor,
        payout_fee_minor,statement_max_age_minutes,shortcode,command_id,contract_reference,funding_reference,updated_by,updated_at)
        =(select revision,enabled,require_four_eyes,custody_ids,recipient_ids,per_payout_minor,daily_minor,payout_fee_minor,
          statement_max_age_minutes,shortcode,command_id,contract_reference,funding_reference,updated_by,updated_at
          from jsonb_populate_record(null::public.b2c_policy,'${JSON.stringify(originalPolicy).replaceAll("'", "''")}'::jsonb));
      delete from public.audit_events where actor_id in (${users}) or wedding_id='${context.wedding}';
      delete from public.contributions where wedding_id='${context.wedding}';
      delete from public.wedding_kyc where wedding_id='${context.wedding}';
      delete from public.wedding_memberships where wedding_id='${context.wedding}';
      delete from public.weddings where id='${context.wedding}';
      delete from public.profiles where id in (${users});
      delete from auth.users where id in (${users});
      drop table public.b2c_ci_context;
      commit;`);
  }
}
