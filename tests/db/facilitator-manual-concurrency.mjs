// This test deliberately commits synthetic fixtures and temporarily replaces a
// hard-disabled gate. Run only on the disposable GitHub Actions database.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

const container = process.env.FACILITATOR_MANUAL_TEST_DB_CONTAINER;
if (process.env.CI !== "true" || process.env.GITHUB_ACTIONS !== "true"
  || container !== "supabase_db_weddingsite") {
  throw new Error("This test requires the disposable GitHub Actions database.");
}

function sql(input, hold = false) {
  const child = spawn("docker", ["exec", "-i", container, "psql", "-X", "-U", "postgres",
    "-d", "postgres", "-At", "-v", "ON_ERROR_STOP=1"]);
  let stdout = "", stderr = "";
  const result = new Promise((resolve, reject) => {
    const timer = setTimeout(() => child.kill(), 60000);
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
const waitFor = condition => run(`do $$ begin for i in 1..1500 loop
  perform pg_stat_clear_snapshot();
  if ${condition} then return; end if;
  perform pg_sleep(0.01);
end loop; raise exception 'Concurrency barrier timed out'; end $$;`);
const matchJson = value => JSON.parse(value.split("\n").find(line => line.startsWith("{")));

const fixture = readFileSync("tests/db/referral-commissions.sql", "utf8")
  .split("savepoint synthetic_reservation_core;")[0];
assert.ok(fixture.includes("insert into referral_actors values('funding-review',r)"));
const gateReset = `create or replace function public.facilitator_manual_enabled() returns boolean
  language sql immutable set search_path='' as $$ select false $$;`;
let gateChanged = false;
try {
  const initialGate = await run("select public.facilitator_manual_enabled();");
  assert.equal(initialGate, "f", "Manual model must start disabled");
  gateChanged = true;
  const seed = await run(`${fixture}
    do $$ begin
      if public.facilitator_manual_enabled() then raise exception 'Manual model must start disabled'; end if;
    end $$;
    create or replace function public.facilitator_manual_enabled() returns boolean
      language sql immutable set search_path='' as $$ select true $$;
    do $$ declare v uuid; e uuid;
    begin
      insert into public.facilitator_recipient_versions(user_id,request_key,full_name,phone,ownership_attested,consent_version)
        values((select id from referral_actors where kind='referrer'),extensions.gen_random_uuid(),
          'Synthetic race facilitator','254700000003',true,'facilitator-mpesa-recipient-v1') returning revision_id into v;
      insert into public.facilitator_recipient_evidence(revision_id,external_reference,sha256,submitted_by)
        values(v,extensions.gen_random_uuid(),repeat('a',64),(select id from referral_actors where kind='owner')) returning id into e;
      insert into public.facilitator_recipient_checks(revision_id,evidence_id,checked_by,owner_solo)
        values(v,e,(select id from referral_actors where kind='superadmin'),false);
      insert into referral_actors values('race-recipient',v);
    end $$;
    select jsonb_build_object('user',(select id from referral_actors where kind='referrer'),
      'owner',(select id from referral_actors where kind='owner'),
      'admin',(select id from referral_actors where kind='admin'),
      'superadmin',(select id from referral_actors where kind='superadmin'),
      'recipient',(select id from referral_actors where kind='race-recipient'),
      'review',(select id from referral_actors where kind='funding-review'));
    commit;`);
  const fixtureIds = matchJson(seed);
  const requestId = value => value.split("\n").find(line =>
    /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(line) && line !== fixtureIds.user);
  const actor = user => `select set_config('request.jwt.claim.role','authenticated',true);
    select set_config('request.jwt.claim.sub','${user}',true);`;
  const request = (key, amount) => `public.facilitator_manual_request_internal(
    '${key}','${fixtureIds.recipient}','KES',${amount},
    jsonb_build_array(jsonb_build_object('review','${fixtureIds.review}','amount','${amount}')),true)`;
  async function race(firstCall, secondCall, user = fixtureIds.user) {
    const firstName = `manual_first_${randomUUID()}`, secondName = `manual_second_${randomUUID()}`;
    const first = sql(`begin; set local statement_timeout='30s';
      set local idle_in_transaction_session_timeout='45s'; set local application_name='${firstName}';
      ${actor(user)} select ${firstCall};\n`, true);
    const aResult = first.result.then(value => ({ value }), error => ({ error }));
    let bResult, barrierError;
    try {
      await waitFor(`exists(select 1 from pg_stat_activity where application_name='${firstName}'
        and state='idle in transaction' and wait_event='ClientRead')`);
      const second = sql(`begin; set local statement_timeout='30s'; set local application_name='${secondName}';
        ${actor(user)} select ${secondCall}; commit;`);
      bResult = second.result.then(value => ({ value }), error => ({ error }));
      await waitFor(`exists(select 1 from pg_stat_activity waiting join pg_stat_activity holding
        on holding.pid=any(pg_blocking_pids(waiting.pid))
        where waiting.application_name='${secondName}' and holding.application_name='${firstName}'
          and waiting.wait_event='advisory')`);
    } catch (error) {
      barrierError = error;
    } finally {
      first.release();
    }
    const [a, b] = await Promise.all([aResult, bResult]);
    if (barrierError) throw barrierError;
    if (a.error) throw a.error;
    return [a.value, b];
  }
  const firstKey = randomUUID(), competingKey = randomUUID(), replayKey = randomUUID(), changedKey = randomUUID();
  const [firstOutput, competing] = await race(request(firstKey, 500), request(competingKey, 600));
  const first = requestId(firstOutput);
  assert.ok(first, "First request must commit");
  assert.ok(competing.error, "Concurrent over-allocation must fail");
  assert.match(competing.error.message, /FACILITATOR_MANUAL_HOLD:/);
  const [secondOutput, replay] = await race(request(replayKey, 200), request(replayKey, 200));
  const second = requestId(secondOutput);
  assert.ok(second, "Remaining source capacity can be reserved");
  assert.ifError(replay.error);
  assert.equal(requestId(replay.value), second, "Concurrent identical retry returns the prior request");
  const [thirdOutput, changed] = await race(request(changedKey, 100), request(changedKey, 99));
  const third = requestId(thirdOutput);
  assert.ok(third, "Initial changed-key race commits the first request");
  assert.ok(changed.error, "Concurrent changed replay must fail");
  assert.match(changed.error.message, /FACILITATOR_MANUAL_CONFLICT:/);
  const claimKey = randomUUID();
  const claim = (key, payout = first) => `public.facilitator_manual_action_internal(
    '${payout}','${key}','processing',null,10,null,true,true)`;
  const [claimOutput, otherClaim] = await race(claim(claimKey), claim(randomUUID()), fixtureIds.owner);
  assert.equal(matchJson(claimOutput).state, "processing", "Owner claims the synthetic payout");
  assert.ok(otherClaim.error, "Concurrent second claim must fail");
  assert.match(otherClaim.error.message, /FACILITATOR_MANUAL_CONFLICT:/);
  const [claimReplayOutput, claimReplay] = await race(claim(claimKey), claim(claimKey), fixtureIds.owner);
  assert.equal(matchJson(claimReplayOutput).replayed, true, "Claim retry is historical acknowledgment");
  assert.ifError(claimReplay.error);
  assert.equal(matchJson(claimReplay.value).replayed, true, "Concurrent claim retry cannot create a new claim");
  const initialReplayKey = randomUUID();
  const [initialClaim, initialReplay] = await race(
    claim(initialReplayKey, second), claim(initialReplayKey, second), fixtureIds.owner);
  assert.equal(matchJson(initialClaim).state, "processing", "Initial same-key claim succeeds");
  assert.ifError(initialReplay.error);
  assert.equal(matchJson(initialReplay.value).replayed, true,
    "Identical retry racing the first claim is only historical acknowledgment");
  const report = (payout, key) => `public.facilitator_manual_action_internal(
    '${payout}','${key}','paid',null,null,'synthetic-race-reference',false,true)`;
  const [paidOutput, duplicateReport] = await race(
    report(first, randomUUID()), report(second, randomUUID()), fixtureIds.owner);
  assert.equal(matchJson(paidOutput).operator_reported, true, "First synthetic report is recorded");
  assert.ifError(duplicateReport.error);
  assert.equal(matchJson(duplicateReport.value).conflict, true,
    "Concurrent duplicate reference is retained as an incident");
  const incidentStatus = matchJson(await run(`begin; ${actor(fixtureIds.user)}
    select public.facilitator_manual_status_internal('${second}'); commit;`));
  assert.equal(incidentStatus.state, "outcome_review_required", "Incident is visible, not unqualified paid");
  assert.equal(incidentStatus.do_not_resend, true);
  await run(`begin; ${actor(fixtureIds.admin)}
    select public.facilitator_manual_action_internal('${third}','${randomUUID()}',
      'reviewed',null,10,null,false,true); commit;`);
  const revokeName = `manual_revoke_${randomUUID()}`, claimName = `manual_claim_${randomUUID()}`;
  const revoke = sql(`begin; set local statement_timeout='30s';
    set local idle_in_transaction_session_timeout='45s'; set local application_name='${revokeName}';
    update public.profiles set platform_role='client' where id='${fixtureIds.admin}';\n`, true);
  const revokeResult = revoke.result.then(value => ({ value }), error => ({ error }));
  let blockedClaimResult, roleBarrierError;
  try {
    await waitFor(`exists(select 1 from pg_stat_activity where application_name='${revokeName}'
      and state='idle in transaction' and wait_event='ClientRead')`);
    const blockedClaim = sql(`begin; set local statement_timeout='30s'; set local application_name='${claimName}';
      ${actor(fixtureIds.superadmin)} select public.facilitator_manual_action_internal(
        '${third}','${randomUUID()}','processing',null,10,null,false,true); commit;`);
    blockedClaimResult = blockedClaim.result.then(value => ({ value }), error => ({ error }));
    await waitFor(`exists(select 1 from pg_stat_activity waiting join pg_stat_activity holding
      on holding.pid=any(pg_blocking_pids(waiting.pid))
      where waiting.application_name='${claimName}' and holding.application_name='${revokeName}')`);
  } catch (error) {
    roleBarrierError = error;
  } finally {
    revoke.release();
  }
  const [revoked, blockedClaim] = await Promise.all([revokeResult, blockedClaimResult]);
  if (roleBarrierError) throw roleBarrierError;
  assert.ifError(revoked.error);
  assert.ok(blockedClaim.error, "Reviewer revocation must prevent the claim");
  assert.match(blockedClaim.error.message, /FACILITATOR_MANUAL_AUTH: Reviewer authority changed/);
  const checkerName = `manual_checker_${randomUUID()}`, checkerClaimName = `manual_checker_claim_${randomUUID()}`;
  const checkerRequestName = `manual_checker_request_${randomUUID()}`, checkerRequestKey = randomUUID();
  const checkerUpdate = sql(`begin; set local statement_timeout='30s';
    set local idle_in_transaction_session_timeout='45s'; set local application_name='${checkerName}';
    update public.profiles set platform_role='client' where id='${fixtureIds.superadmin}';\n`, true);
  const checkerResult = checkerUpdate.result.then(value => ({ value }), error => ({ error }));
  let checkerClaimResult, checkerRequestResult, checkerBarrierError;
  try {
    await waitFor(`exists(select 1 from pg_stat_activity where application_name='${checkerName}'
      and state='idle in transaction' and wait_event='ClientRead')`);
    const checkerClaim = sql(`begin; set local statement_timeout='30s';
      set local application_name='${checkerClaimName}'; ${actor(fixtureIds.owner)}
      select ${claim(randomUUID(), third)}; commit;`);
    checkerClaimResult = checkerClaim.result.then(value => ({ value }), error => ({ error }));
    await waitFor(`exists(select 1 from pg_stat_activity waiting join pg_stat_activity holding
      on holding.pid=any(pg_blocking_pids(waiting.pid))
      where waiting.application_name='${checkerClaimName}' and holding.application_name='${checkerName}')`);
    const checkerRequest = sql(`begin; set local statement_timeout='30s';
      set local application_name='${checkerRequestName}'; ${actor(fixtureIds.user)}
      select ${request(checkerRequestKey, 1)}; commit;`);
    checkerRequestResult = checkerRequest.result.then(value => ({ value }), error => ({ error }));
    await waitFor(`exists(select 1 from pg_stat_activity waiting join pg_stat_activity holding
      on holding.pid=any(pg_blocking_pids(waiting.pid))
      where waiting.application_name='${checkerRequestName}' and holding.application_name='${checkerClaimName}')`);
  } catch (error) {
    checkerBarrierError = error;
  } finally {
    checkerUpdate.release();
  }
  const [checkerRevoked, checkerClaim, checkerRequest] = await Promise.all(
    [checkerResult, checkerClaimResult, checkerRequestResult]);
  if (checkerBarrierError) throw checkerBarrierError;
  assert.ifError(checkerRevoked.error);
  assert.ok(checkerClaim.error, "Recipient checker revocation must prevent the claim");
  assert.match(checkerClaim.error.message, /FACILITATOR_MANUAL_HOLD: Recipient changed or is not verified/);
  assert.ok(checkerRequest.error, "Recipient checker revocation must prevent admission");
  assert.match(checkerRequest.error.message, /FACILITATOR_MANUAL_HOLD: Current verified recipient required/);
  await run(`update public.profiles set platform_role='superadmin' where id='${fixtureIds.superadmin}';`);
  assert.equal(await run(`select public.facilitator_payout_recipient_ready(
    '${fixtureIds.user}','${fixtureIds.recipient}');`), "t", "Recipient is ready before the independent revision race");
  const recipientName = `manual_recipient_${randomUUID()}`, waitingName = `manual_waiting_${randomUUID()}`;
  const waitingClaimName = `manual_recipient_claim_${randomUUID()}`;
  const recipientChange = sql(`begin; set local statement_timeout='30s';
    set local idle_in_transaction_session_timeout='45s'; set local application_name='${recipientName}';
    ${actor(fixtureIds.user)}
    select public.facilitator_recipient_submit('${randomUUID()}','Changed synthetic facilitator','254700000004',
      true,'facilitator-mpesa-recipient-v1');\n`, true);
  const recipientResult = recipientChange.result.then(value => ({ value }), error => ({ error }));
  let waitingResult, waitingClaimResult, recipientBarrierError;
  const staleKey = randomUUID();
  try {
    await waitFor(`exists(select 1 from pg_stat_activity where application_name='${recipientName}'
      and state='idle in transaction' and wait_event='ClientRead')`);
    const waitingClaim = sql(`begin; set local statement_timeout='30s';
      set local application_name='${waitingClaimName}'; ${actor(fixtureIds.owner)}
      select ${claim(randomUUID(), third)}; commit;`);
    waitingClaimResult = waitingClaim.result.then(value => ({ value }), error => ({ error }));
    await waitFor(`exists(select 1 from pg_stat_activity waiting join pg_stat_activity holding
      on holding.pid=any(pg_blocking_pids(waiting.pid))
      where waiting.application_name='${waitingClaimName}' and holding.application_name='${recipientName}')`);
    const waiting = sql(`begin; set local statement_timeout='30s'; set local application_name='${waitingName}';
      ${actor(fixtureIds.user)} select ${request(staleKey, 1)}; commit;`);
    waitingResult = waiting.result.then(value => ({ value }), error => ({ error }));
    await waitFor(`exists(select 1 from pg_stat_activity waiting join pg_stat_activity holding
      on holding.pid=any(pg_blocking_pids(waiting.pid))
      where waiting.application_name='${waitingName}' and holding.application_name='${waitingClaimName}')`);
  } catch (error) {
    recipientBarrierError = error;
  } finally {
    recipientChange.release();
  }
  const [recipientUpdated, staleRequest, staleClaim] = await Promise.all(
    [recipientResult, waitingResult, waitingClaimResult]);
  if (recipientBarrierError) throw recipientBarrierError;
  assert.ifError(recipientUpdated.error);
  assert.ok(staleRequest.error, "Concurrent recipient change must invalidate the old destination");
  assert.match(staleRequest.error.message, /FACILITATOR_MANUAL_HOLD: Current verified recipient required/);
  assert.ok(staleClaim.error, "Concurrent recipient change must also block the pending claim");
  assert.match(staleClaim.error.message, /FACILITATOR_MANUAL_HOLD: Recipient changed or is not verified/);
  const updatedRevision = matchJson(recipientUpdated.value).revision;
  await run(`with evidence as (
    insert into public.facilitator_recipient_evidence(revision_id,external_reference,sha256,submitted_by)
      values('${updatedRevision}','${randomUUID()}','${"b".repeat(64)}','${fixtureIds.owner}')
      returning id
  ) insert into public.facilitator_recipient_checks(revision_id,evidence_id,checked_by,owner_solo)
    select '${updatedRevision}',id,'${fixtureIds.owner}',true from evidence;`);
  assert.equal(await run(`select public.facilitator_payout_recipient_ready(
    '${fixtureIds.user}','${updatedRevision}');`), "t", "New synthetic recipient is ready for source race");
  const adjustmentName = `manual_adjustment_${randomUUID()}`, adjustedRequestName = `manual_adjusted_${randomUUID()}`;
  const adjustmentKey = randomUUID();
  const adjustedCall = `public.facilitator_manual_request_internal(
    '${adjustmentKey}','${updatedRevision}','KES',1,
    jsonb_build_array(jsonb_build_object('review','${fixtureIds.review}','amount','1')),true)`;
  const control = await run(`begin; ${actor(fixtureIds.user)} select ${adjustedCall}; rollback;`);
  assert.ok(requestId(control), "Identical request succeeds with spare source capacity before the refund");
  const adjustment = sql(`begin; set local statement_timeout='30s';
    set local idle_in_transaction_session_timeout='45s'; set local application_name='${adjustmentName}';
    select pg_advisory_xact_lock(71110001);
    insert into public.payment_adjustments(provider,adjustment_kind,provider_adjustment_id,contribution_id,wedding_id,
      amount_minor,currency,status,refund_fee_allocation)
      select 'stripe','refund','manual-concurrent-refund',c.id,c.wedding_id,50000,'KES','processed','platform'
      from public.contributions c join public.referral_funding_reviews f on f.contribution_id=c.id
      where f.id='${fixtureIds.review}';\n`, true);
  const adjustmentResult = adjustment.result.then(value => ({ value }), error => ({ error }));
  let adjustedResult, adjustmentBarrierError;
  try {
    await waitFor(`exists(select 1 from pg_stat_activity where application_name='${adjustmentName}'
      and state='idle in transaction' and wait_event='ClientRead')`);
    const adjusted = sql(`begin; set local statement_timeout='30s'; set local application_name='${adjustedRequestName}';
      ${actor(fixtureIds.user)} select ${adjustedCall}; commit;`);
    adjustedResult = adjusted.result.then(value => ({ value }), error => ({ error }));
    await waitFor(`exists(select 1 from pg_stat_activity waiting join pg_stat_activity holding
      on holding.pid=any(pg_blocking_pids(waiting.pid))
      where waiting.application_name='${adjustedRequestName}' and holding.application_name='${adjustmentName}'
        and waiting.wait_event='advisory')`);
  } catch (error) {
    adjustmentBarrierError = error;
  } finally {
    adjustment.release();
  }
  const [adjustmentCommitted, adjustedRequest] = await Promise.all([adjustmentResult, adjustedResult]);
  if (adjustmentBarrierError) throw adjustmentBarrierError;
  assert.ifError(adjustmentCommitted.error);
  assert.ok(adjustedRequest.error, "Committed refund must hold subsequent source admission");
  assert.match(adjustedRequest.error.message, /FACILITATOR_MANUAL_HOLD: Current checked source evidence is required/);
  const totals = matchJson(await run(`select jsonb_build_object(
    'requests',(select count(*) from public.facilitator_manual_requests where user_id='${fixtureIds.user}'),
    'allocations',(select count(*) from public.facilitator_manual_allocations),
    'total',(select sum(amount_minor) from public.facilitator_manual_allocations),
    'failed',(select count(*) from public.facilitator_manual_requests where request_key='${competingKey}'),
    'stale',(select count(*) from public.facilitator_manual_requests where request_key='${staleKey}'),
    'checker_failed',(select count(*) from public.facilitator_manual_requests where request_key='${checkerRequestKey}'),
    'adjustment_failed',(select count(*) from public.facilitator_manual_requests where request_key='${adjustmentKey}'),
    'claims',(select count(*) from public.facilitator_manual_claims),
    'receipts',(select count(*) from public.facilitator_manual_receipts),
    'incidents',(select count(*) from public.facilitator_manual_incidents));`));
  assert.deepEqual(totals, { requests: 3, allocations: 3, total: 800, failed: 0, stale: 0,
    checker_failed: 0, adjustment_failed: 0, claims: 2, receipts: 1, incidents: 1 });
  console.log("Concurrent synthetic requests and claims serialize; retries acknowledge history without additional liabilities.");
} finally {
  if (gateChanged) await run(gateReset);
}
