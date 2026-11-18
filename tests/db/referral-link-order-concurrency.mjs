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

const creator = randomUUID(), referrer = randomUUID(), revision = randomUUID();
const cases = ["concurrent_link_first", "concurrent_attribution_first", "link_unlink_attribution"]
  .map(name => ({ name, wedding: randomUUID(), intent: randomUUID(), app: `referral_order_${randomUUID()}` }));
const weddings = cases.map(c => `'${c.wedding}'`).join(",");
const attribution = c => `insert into public.referral_attributions
  (wedding_id,referrer_id,creator_id,intent_id,disclosed_revision,terms_version,eligible)
  values('${c.wedding}','${referrer}','${creator}','${c.intent}','${revision}','client-referrals-v1',true);`;
const membership = c => `insert into public.wedding_memberships(wedding_id,user_id,role)
  values('${c.wedding}','${referrer}','client');`;
const events = c => run(`select count(*) from public.referral_eligibility_events
  where wedding_id='${c.wedding}' and reason='client_membership' and linked_user_id='${referrer}';`);
let fixtureCreated = false;
try {
  await run(`begin;
    insert into auth.users(id) values('${creator}'),('${referrer}');
    insert into public.referral_accounts(user_id,opted_in,terms_version)
      values('${referrer}',true,'client-referrals-v1');
    ${cases.map(c => `insert into public.weddings(id,couple_names,currency,client_owner_id)
      values('${c.wedding}','Fictional ${c.name}','KES','${creator}');
    insert into public.referral_intents(id,creator_id,referrer_id,state,consumed_at,disclosed_revision,disclosed_terms_version)
      values('${c.intent}','${creator}','${referrer}','consumed',now(),'${revision}','client-referrals-v1');`).join("\n")}
    commit;`);
  fixtureCreated = true;

  // Link transaction first: the attribution waits, then must observe the committed link.
  const [linkFirst, attributionFirst, inTransaction] = cases;
  const holdLink = sql(`begin; set local statement_timeout='25s'; set local idle_in_transaction_session_timeout='30s';
    set local application_name='${linkFirst.app}'; ${membership(linkFirst)}\n`, true);
  const heldLink = holdLink.result.then(value => ({ value }), error => ({ error }));
  let pending;
  try {
    await waitFor(`exists(select 1 from pg_stat_activity where application_name='${linkFirst.app}'
      and state='idle in transaction' and wait_event='ClientRead')`);
    pending = run(`set application_name='${linkFirst.app}_w'; ${attribution(linkFirst)}`);
    await waitFor(`exists(select 1 from pg_stat_activity where application_name='${linkFirst.app}_w'
      and wait_event_type='Lock')`);
  } finally { holdLink.release(); }
  const heldLinkResult = await heldLink;
  if (heldLinkResult.error) throw heldLinkResult.error;
  await pending;
  assert.equal(await events(linkFirst), "1", "Attribution waited and saw the concurrent link");

  // Attribution transaction first: the link waits, then must observe the attribution.
  const holdAttribution = sql(`begin; set local statement_timeout='25s'; set local idle_in_transaction_session_timeout='30s';
    set local application_name='${attributionFirst.app}'; ${attribution(attributionFirst)}\n`, true);
  const heldAttribution = holdAttribution.result.then(value => ({ value }), error => ({ error }));
  try {
    await waitFor(`exists(select 1 from pg_stat_activity where application_name='${attributionFirst.app}'
      and state='idle in transaction' and wait_event='ClientRead')`);
    pending = run(`set application_name='${attributionFirst.app}_w'; ${membership(attributionFirst)}`);
    await waitFor(`exists(select 1 from pg_stat_activity where application_name='${attributionFirst.app}_w'
      and wait_event_type='Lock')`);
  } finally { holdAttribution.release(); }
  const heldAttributionResult = await heldAttribution;
  if (heldAttributionResult.error) throw heldAttributionResult.error;
  await pending;
  assert.equal(await events(attributionFirst), "1", "Link waited and saw the concurrent attribution");

  // Link, unlink, then attribute within one transaction still records the historical link.
  await run(`begin; ${membership(inTransaction)}
    delete from public.wedding_memberships where wedding_id='${inTransaction.wedding}' and user_id='${referrer}';
    ${attribution(inTransaction)} commit;`);
  assert.equal(await events(inTransaction), "1", "Same-transaction link/unlink is still excluded");
  console.log("Link and attribution writers are ordered; historical links are excluded.");
} finally {
  if (fixtureCreated) await run(`begin;
    alter table public.referral_eligibility_events disable trigger referral_eligibility_events_immutable;
    delete from public.referral_eligibility_events where wedding_id in (${weddings});
    alter table public.referral_eligibility_events enable trigger referral_eligibility_events_immutable;
    alter table public.referral_link_history disable trigger immutable;
    delete from public.referral_link_history where wedding_id in (${weddings});
    alter table public.referral_link_history enable trigger immutable;
    delete from public.wedding_memberships where wedding_id in (${weddings});
    alter table public.referral_attributions disable trigger referral_attribution_immutable;
    delete from public.referral_attributions where wedding_id in (${weddings});
    alter table public.referral_attributions enable trigger referral_attribution_immutable;
    delete from public.referral_intents where id in (${cases.map(c => `'${c.intent}'`).join(",")});
    alter table public.weddings disable trigger weddings_no_delete;
    delete from public.weddings where id in (${weddings});
    alter table public.weddings enable trigger weddings_no_delete;
    delete from public.referral_accounts where user_id='${referrer}';
    delete from public.profiles where id in ('${creator}','${referrer}');
    delete from auth.users where id in ('${creator}','${referrer}');
    delete from public.audit_events where table_name='profiles' and record_id in ('${creator}','${referrer}');
    commit;`);
}
