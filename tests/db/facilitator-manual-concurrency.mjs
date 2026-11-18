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
      'recipient',(select id from referral_actors where kind='race-recipient'),
      'review',(select id from referral_actors where kind='funding-review'));
    commit;`);
  const fixtureIds = matchJson(seed);
  const requestId = value => value.split("\n").find(line =>
    /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(line) && line !== fixtureIds.user);
  const actor = `select set_config('request.jwt.claim.role','authenticated',true);
    select set_config('request.jwt.claim.sub','${fixtureIds.user}',true);`;
  const request = (key, amount) => `public.facilitator_manual_request_internal(
    '${key}','${fixtureIds.recipient}','KES',${amount},
    jsonb_build_array(jsonb_build_object('review','${fixtureIds.review}','amount','${amount}')),true)`;
  async function race(firstKey, firstAmount, secondKey, secondAmount) {
    const firstName = `manual_first_${randomUUID()}`, secondName = `manual_second_${randomUUID()}`;
    const first = sql(`begin; set local statement_timeout='30s';
      set local idle_in_transaction_session_timeout='45s'; set local application_name='${firstName}';
      ${actor} select ${request(firstKey, firstAmount)};\n`, true);
    const aResult = first.result.then(value => ({ value }), error => ({ error }));
    let bResult, barrierError;
    try {
      await waitFor(`exists(select 1 from pg_stat_activity where application_name='${firstName}'
        and state='idle in transaction' and wait_event='ClientRead')`);
      const second = sql(`begin; set local statement_timeout='30s'; set local application_name='${secondName}';
        ${actor} select ${request(secondKey, secondAmount)}; commit;`);
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
    return [requestId(a.value), b];
  }
  const firstKey = randomUUID(), competingKey = randomUUID(), replayKey = randomUUID();
  const [first, competing] = await race(firstKey, 600, competingKey, 600);
  assert.ok(first, "First request must commit");
  assert.ok(competing.error, "Concurrent over-allocation must fail");
  assert.match(competing.error.message, /FACILITATOR_MANUAL_HOLD:/);
  const [second, replay] = await race(replayKey, 400, replayKey, 400);
  assert.ok(second, "Remaining source capacity can be reserved");
  assert.ifError(replay.error);
  assert.equal(requestId(replay.value), second, "Concurrent identical retry returns the prior request");
  const totals = matchJson(await run(`select jsonb_build_object(
    'requests',(select count(*) from public.facilitator_manual_requests where user_id='${fixtureIds.user}'),
    'allocations',(select count(*) from public.facilitator_manual_allocations),
    'total',(select sum(amount_minor) from public.facilitator_manual_allocations),
    'failed',(select count(*) from public.facilitator_manual_requests where request_key='${competingKey}'));`));
  assert.deepEqual(totals, { requests: 2, allocations: 2, total: 1000, failed: 0 });
  console.log("Concurrent manual requests serialize: over-allocation rolls back and identical retry returns one request.");
} finally {
  if (gateChanged) await run(gateReset);
}
