// Isolated database only; staged synthetic data is deleted after the test.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";

const container = process.env.PROVIDER_ADJUSTMENT_TEST_DB_CONTAINER;
if (container !== "supabase_db_weddingsite") throw new Error("An isolated local CI database is required.");
function sql(input, hold = false) {
  const child = spawn("docker", ["exec", "-i", container, "psql", "-X", "-U", "postgres",
    "-d", "postgres", "-At", "-v", "ON_ERROR_STOP=1"]);
  let stdout = "", stderr = "";
  const result = new Promise((resolve, reject) => {
    const timer = setTimeout(() => child.kill(), 35000);
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("error", error => { clearTimeout(timer); reject(error); });
    child.on("close", code => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`psql exited ${code}: ${stderr}`));
    });
  });
  if (hold) child.stdin.write(input); else child.stdin.end(input);
  return { result, release: () => { if (!child.stdin.destroyed) child.stdin.end("commit;\n"); } };
}
const run = input => sql(input).result;
const waitFor = condition => run(`do $$ begin for i in 1..1000 loop
  perform pg_stat_clear_snapshot();
  if ${condition} then return; end if;
  perform pg_sleep(0.01);
end loop; raise exception 'Concurrency barrier timed out'; end $$;`);
const event = `inbox-fixture-${randomUUID()}`;
const holderName = `inbox_holder_${randomUUID()}`, workerName = `inbox_worker_${randomUUID()}`;
const actor = "set local role service_role; select set_config('request.jwt.claim.role','service_role',true);";
const holder = sql(`begin; set local statement_timeout='20s';
  set local idle_in_transaction_session_timeout='25s';
  set local application_name='${holderName}'; select pg_advisory_xact_lock(71110001);\n`, true);
const heldResult = holder.result.then(value => ({ value }), error => ({ error }));
let workerResult, barrierError, id;
try {
  await waitFor(`exists(select 1 from pg_stat_activity where application_name='${holderName}'
    and state='idle in transaction' and wait_event='ClientRead')`);
  const staged = await run(`begin; ${actor}
    select public.stage_verified_adjustment('stripe','${event}','refund.created','refund-${event}',
      'missing-${event}',100,'KES','refund_pending',null,repeat('a',64)); commit;`);
  id = JSON.parse(staged.split("\n").find(line => line.startsWith("{"))).id;
  assert.ok(id, "Verified observation commits while the accounting lock is held");
  assert.equal(await run(`select count(*) from public.verified_adjustment_inbox where id='${id}';`), "1");
  const worker = sql(`begin; set local statement_timeout='20s';
    set local application_name='${workerName}'; ${actor}
    select public.process_verified_adjustment('${id}'); commit;`);
  workerResult = worker.result.then(value => ({ value }), error => ({ error }));
  await waitFor(`exists(select 1 from pg_stat_activity waiting join pg_stat_activity holding
    on holding.pid=any(pg_blocking_pids(waiting.pid))
    where waiting.application_name='${workerName}' and holding.application_name='${holderName}'
    and waiting.wait_event='advisory')`);
  assert.equal(await run(`select count(*) from public.provider_adjustment_events
    where provider='stripe' and provider_event_id='${event}';`), "0");
} catch (error) {
  barrierError = error;
} finally {
  holder.release();
}
try {
  const [held, processed] = await Promise.all([heldResult, workerResult]);
  if (barrierError) throw barrierError;
  if (held.error) throw held.error;
  if (processed.error) throw processed.error;
  assert.match(processed.value, /"processed": true/);
  assert.equal(await run(`select count(*) from public.verified_adjustment_inbox_processed where inbox_id='${id}';`), "1");
  assert.equal(await run(`select count(*) from public.provider_adjustment_events where provider_event_id='${event}';`), "1");
  console.log("Verified observation persists independently while its processor waits for the accounting lock.");
} finally {
  if (id) await run(`begin;
    alter table public.verified_adjustment_inbox_processed disable trigger verified_adjustment_inbox_immutable;
    delete from public.verified_adjustment_inbox_processed where inbox_id='${id}';
    alter table public.verified_adjustment_inbox_processed enable trigger verified_adjustment_inbox_immutable;
    alter table public.verified_adjustment_inbox disable trigger verified_adjustment_inbox_immutable;
    delete from public.verified_adjustment_inbox where id='${id}';
    alter table public.verified_adjustment_inbox enable trigger verified_adjustment_inbox_immutable;
    delete from public.provider_adjustment_events where provider='stripe' and provider_event_id='${event}';
    commit;`);
}
