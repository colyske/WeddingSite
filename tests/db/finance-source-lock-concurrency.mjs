// Isolated local CI database only. Synthetic fixtures; no provider calls.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";

const container = process.env.FINANCE_LOCK_TEST_DB_CONTAINER;
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
      else reject(new Error(stderr));
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

const wedding = randomUUID(), user = randomUUID(), outsider = randomUUID();
const holderName = `finance_holder_${randomUUID()}`;
const calls = [
  `public.record_expense('${wedding}','fixture','fixture',100,'KES',null,true)`,
  `public.record_reconciliation('${wedding}','fixture','fixture',100,100,'KES',null,true)`,
  `public.save_budget_line('${wedding}','fixture',100,100,'KES',true)`,
  `public.request_payout('${wedding}',100,'KES',null,true)`
];
await run(`begin;
  insert into auth.users(id) values('${user}');
  insert into public.weddings(id,couple_names,currency,client_owner_id)
    values('${wedding}','Fictional couple','KES','${user}');
  insert into public.wedding_memberships(wedding_id,user_id,role)
    values('${wedding}','${user}','client');
  commit;`);
try {
await run(`begin;
  set local role authenticated;
  select set_config('request.jwt.claim.sub','${user}',true);
  select set_config('request.jwt.claim.role','authenticated',true);
  select ${calls[0]}; select ${calls[1]}; select ${calls[2]};
  rollback;`);
const holder = sql(`begin; set local statement_timeout='20s';
  set local idle_in_transaction_session_timeout='25s';
  set local application_name='${holderName}'; select pg_advisory_xact_lock(71110001);\n`, true);
const holderResult = holder.result.then(value => ({ value }), error => ({ error }));
const workers = [];
let barrierError;
try {
  await waitFor(`exists(select 1 from pg_stat_activity where application_name='${holderName}'
    and state='idle in transaction' and wait_event='ClientRead')`);
  for (const call of calls) {
    await assert.rejects(run(`begin; set local statement_timeout='1s'; set local role authenticated;
      select set_config('request.jwt.claim.sub','${outsider}',true);
      select set_config('request.jwt.claim.role','authenticated',true);
      select ${call}; commit;`),
      /Workspace access denied|Budget editing permission denied|Only the Client or protected Owner/,
      "Unauthorized actors are rejected without waiting for accounting");
  }
  for (const call of calls) {
    const name = `finance_worker_${randomUUID()}`;
    const worker = sql(`begin; set local statement_timeout='20s';
      set local application_name='${name}'; set local role authenticated;
      select set_config('request.jwt.claim.sub','${user}',true);
      select set_config('request.jwt.claim.role','authenticated',true);
      select ${call}; commit;`);
    workers.push({ name, result: worker.result.then(value => ({ value }), error => ({ error })) });
  }
  for (const { name } of workers) {
    await waitFor(`exists(select 1 from pg_stat_activity waiting join pg_stat_activity holding
      on holding.pid=any(pg_blocking_pids(waiting.pid))
      where waiting.application_name='${name}' and holding.application_name='${holderName}'
      and waiting.wait_event='advisory')`);
  }
  await run(`delete from public.wedding_memberships
    where wedding_id='${wedding}' and user_id='${user}';`);
} catch (error) {
  barrierError = error;
} finally {
  holder.release();
}
const [held, ...results] = await Promise.all([holderResult, ...workers.map(worker => worker.result)]);
if (barrierError) throw barrierError;
if (held.error) throw held.error;
for (const result of results) {
  assert.match(result.error?.message ?? "", /Workspace access denied|Budget editing permission denied|Only the Client or protected Owner/,
    "An actor revoked while waiting is denied after accounting releases the lock");
}
console.log("Finance RPCs reject unauthorized actors early and recheck a revoked actor after accounting.");
} finally {
  await run(`begin;
    delete from public.wedding_memberships where wedding_id='${wedding}';
    alter table public.weddings disable trigger weddings_no_delete;
    delete from public.weddings where id='${wedding}';
    alter table public.weddings enable trigger weddings_no_delete;
    delete from public.profiles where id='${user}';
    delete from auth.users where id='${user}';
    delete from public.audit_events where table_name='profiles' and record_id='${user}';
    commit;`);
}
