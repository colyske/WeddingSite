// Synthetic referral fixtures in the isolated local CI database only.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";

const container = process.env.REFERRAL_TEST_DB_CONTAINER;
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
const creator = randomUUID(), referrer = randomUUID(), wedding = randomUUID(), intent = randomUUID();
const revision = randomUUID(), holderName = `referral_link_holder_${randomUUID()}`;
let fixtureCreated = false;
try {
  await run(`begin;
    insert into auth.users(id) values('${creator}'),('${referrer}');
    insert into public.referral_accounts(user_id,opted_in,terms_version)
      values('${referrer}',true,'client-referrals-v1');
    insert into public.weddings(id,couple_names,currency,client_owner_id)
      values('${wedding}','Fictional couple','KES','${creator}');
    insert into public.wedding_memberships(wedding_id,user_id,role)
      values('${wedding}','${referrer}','admin');
    insert into public.referral_intents(id,creator_id,referrer_id,state,consumed_at,disclosed_revision,disclosed_terms_version)
      values('${intent}','${creator}','${referrer}','consumed',now(),'${revision}','client-referrals-v1');
    insert into public.referral_attributions(wedding_id,referrer_id,creator_id,intent_id,disclosed_revision,terms_version,eligible)
      values('${wedding}','${referrer}','${creator}','${intent}','${revision}','client-referrals-v1',true);
    commit;`);
  fixtureCreated = true;
  const holder = sql(`begin; set local statement_timeout='20s';
    set local idle_in_transaction_session_timeout='25s';
    set local application_name='${holderName}'; select pg_advisory_xact_lock(71110001);\n`, true);
  const heldResult = holder.result.then(value => ({ value }), error => ({ error }));
  let error;
  try {
    await waitFor(`exists(select 1 from pg_stat_activity where application_name='${holderName}'
      and state='idle in transaction' and wait_event='ClientRead')`);
    await run(`update public.weddings set couple_names='Unrelated edit' where id='${wedding}';`);
    await assert.rejects(run(`update public.weddings set client_owner_id='${referrer}' where id='${wedding}';`),
      /REFERRAL_ACCOUNTING_BUSY/, "Relevant owner change fails fast rather than waiting after row lock");
    await assert.rejects(run(`insert into public.wedding_memberships(wedding_id,user_id,role)
      values('${wedding}','${referrer}','client')
      on conflict (wedding_id,user_id) do update set role=excluded.role;`),
      /REFERRAL_ACCOUNTING_BUSY/, "Promoting the referred user to client fails fast");
    assert.equal(await run(`select count(*) from public.referral_eligibility_events where wedding_id='${wedding}';`), "0");
  } catch (caught) {
    error = caught;
  } finally {
    holder.release();
  }
  const held = await heldResult;
  if (held.error) throw held.error;
  if (error) throw error;
  await run(`update public.weddings set client_owner_id='${referrer}' where id='${wedding}';`);
  assert.equal(await run(`select count(*) from public.referral_eligibility_events
    where wedding_id='${wedding}' and reason='owner_account';`), "1");
  await run(`update public.wedding_memberships set role='client'
    where wedding_id='${wedding}' and user_id='${referrer}';`);
  assert.equal(await run(`select count(*) from public.referral_eligibility_events
    where wedding_id='${wedding}' and reason='client_membership';`), "1");
  const secondHolderName = `referral_link_holder_${randomUUID()}`;
  const secondHolder = sql(`begin; set local statement_timeout='20s';
    set local idle_in_transaction_session_timeout='25s';
    set local application_name='${secondHolderName}'; select pg_advisory_xact_lock(71110001);\n`, true);
  const secondHeldResult = secondHolder.result.then(value => ({ value }), error => ({ error }));
  let secondError;
  try {
    await waitFor(`exists(select 1 from pg_stat_activity where application_name='${secondHolderName}'
      and state='idle in transaction' and wait_event='ClientRead')`);
    await run(`insert into public.wedding_memberships(wedding_id,user_id,role)
      values('${wedding}','${referrer}','client')
      on conflict (wedding_id,user_id) do update set role=excluded.role;`);
    const deleteName = `referral_link_delete_${randomUUID()}`;
    const deleteHolder = sql(`begin; set local statement_timeout='20s';
      set local idle_in_transaction_session_timeout='25s';
      set local application_name='${deleteName}';
      delete from public.wedding_memberships where wedding_id='${wedding}' and user_id='${referrer}';\n`, true);
    const deleteResult = deleteHolder.result.then(value => ({ value }), error => ({ error }));
    try {
      await waitFor(`exists(select 1 from pg_stat_activity where application_name='${deleteName}'
        and state='idle in transaction' and wait_event='ClientRead')`);
      const upsertName = `referral_link_upsert_${randomUUID()}`;
      const contender = run(`set application_name='${upsertName}';
        insert into public.wedding_memberships(wedding_id,user_id,role)
        values('${wedding}','${referrer}','client')
        on conflict (wedding_id,user_id) do update set role=excluded.role;`)
        .then(value => ({ value }), error => ({ error }));
      try {
        await waitFor(`exists(select 1 from pg_stat_activity where application_name='${upsertName}'
          and wait_event_type='Lock')`);
      } finally {
        deleteHolder.release();
      }
      const contenderResult = await contender;
      assert.match(contenderResult.error?.message ?? "", /REFERRAL_ACCOUNTING_BUSY/,
        "A concurrently deleted membership cannot bypass the link guard");
    } finally {
      deleteHolder.release();
      const deletion = await deleteResult;
      if (deletion.error) throw deletion.error;
    }
  } catch (caught) {
    secondError = caught;
  } finally {
    secondHolder.release();
  }
  const secondHeld = await secondHeldResult;
  if (secondHeld.error) throw secondHeld.error;
  if (secondError) throw secondError;
  assert.equal(await run(`select count(*) from public.referral_eligibility_events
    where wedding_id='${wedding}' and reason='client_membership';`), "1");
  console.log("Account-link writes fail fast under accounting lock; unrelated wedding edits remain available.");
} finally {
  if (fixtureCreated) await run(`begin;
    alter table public.referral_eligibility_events disable trigger referral_eligibility_events_immutable;
    delete from public.referral_eligibility_events where wedding_id='${wedding}';
    alter table public.referral_eligibility_events enable trigger referral_eligibility_events_immutable;
    alter table public.referral_attributions disable trigger referral_attribution_immutable;
    delete from public.referral_attributions where wedding_id='${wedding}';
    alter table public.referral_attributions enable trigger referral_attribution_immutable;
    delete from public.referral_intents where id='${intent}';
    alter table public.weddings disable trigger weddings_no_delete;
    delete from public.weddings where id='${wedding}';
    alter table public.weddings enable trigger weddings_no_delete;
    delete from public.referral_accounts where user_id='${referrer}';
    delete from public.profiles where id in ('${creator}','${referrer}');
    delete from auth.users where id in ('${creator}','${referrer}');
    delete from public.audit_events where table_name='profiles' and record_id in ('${creator}','${referrer}');
    commit;`);
}
