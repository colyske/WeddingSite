// Isolated database only; a synthetic unmatched refund never contacts a provider.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";

const container = process.env.PROVIDER_ADJUSTMENT_TEST_DB_CONTAINER;
if (container !== "supabase_db_weddingsite") {
  throw new Error("Set PROVIDER_ADJUSTMENT_TEST_DB_CONTAINER to the isolated local CI database.");
}

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
  if (hold) child.stdin.write(input);
  else child.stdin.end(input);
  return { result, release: () => { if (!child.stdin.destroyed) child.stdin.end("commit;\n"); } };
}
const run = input => sql(input).result;
const waitFor = condition => run(`do $$ begin for i in 1..1000 loop
  perform pg_stat_clear_snapshot();
  if ${condition} then return; end if;
  perform pg_sleep(0.01);
end loop; raise exception 'Concurrency barrier timed out'; end $$;`);

const event = `fixture-${randomUUID()}`;
const holderName = `adjustment_holder_${randomUUID()}`;
const workerName = `adjustment_worker_${randomUUID()}`;
const call = `public.record_provider_adjustment('stripe','${event}','refund.created',
  'refund-${event}','payment-${event}',100,'KES','refund_pending',now())`;
const holder = sql(`begin; set local statement_timeout='20s';
  set local idle_in_transaction_session_timeout='25s';
  set local application_name='${holderName}'; select pg_advisory_xact_lock(71110001);\n`, true);
const holderResult = holder.result.then(value => ({ value }), error => ({ error }));
let workerResult, barrierError;
try {
  await waitFor(`exists(select 1 from pg_stat_activity where application_name='${holderName}'
    and state='idle in transaction' and wait_event='ClientRead')`);
  const worker = sql(`begin; set local statement_timeout='20s';
    set local application_name='${workerName}'; set local role service_role;
    select set_config('request.jwt.claim.role','service_role',true);
    select ${call}; commit;`);
  workerResult = worker.result.then(value => ({ value }), error => ({ error }));
  await waitFor(`exists(select 1 from pg_stat_activity waiting join pg_stat_activity holding
    on holding.pid=any(pg_blocking_pids(waiting.pid))
    where waiting.application_name='${workerName}' and holding.application_name='${holderName}'
    and waiting.wait_event='advisory')`);
  assert.equal(await run(`select count(*) from public.provider_adjustment_events
    where provider='stripe' and provider_event_id='${event}';`), "0",
  "No observation is inserted before the accounting lock is acquired");
} catch (error) {
  barrierError = error;
} finally {
  holder.release();
}
try {
  const [held, processed] = await Promise.all([holderResult, workerResult]);
  if (barrierError) throw barrierError;
  if (held.error) throw held.error;
  if (processed.error) throw processed.error;
  assert.match(processed.value, /(^|\n)t(\n|$)/, "Unmatched observation is recorded after the lock is released");
  assert.equal(await run(`select outcome from public.provider_adjustment_events
    where provider='stripe' and provider_event_id='${event}';`), "unmatched");
  const retry = await run(`begin; set local role service_role;
    select set_config('request.jwt.claim.role','service_role',true);
    select ${call}; commit;`);
  assert.match(retry, /(^|\n)f(\n|$)/, "Retry remains idempotent");
  assert.equal(await run(`select has_function_privilege('service_role',
    'public.record_provider_adjustment_locked_body(text,text,text,text,text,bigint,text,text,timestamptz)',
    'execute');`), "f", "The unlocked body cannot be called by the service role");
  console.log("Verified adjustment admission waits for the accounting lock before recording its event.");
} finally {
  await run(`delete from public.provider_adjustment_events
    where provider='stripe' and provider_event_id='${event}';`);
}
