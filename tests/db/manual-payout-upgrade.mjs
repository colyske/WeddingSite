import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

// CI-only populated predecessor. No configurable remote connection accepted.
const migration = readFileSync(new URL("../../supabase/migrations/202611110001_controlled_manual_payouts.sql", import.meta.url), "utf8");
function sql(input) {
  const result = spawnSync("docker", ["exec", "-i", "supabase_db_weddingsite", "psql", "-U", "postgres",
    "-d", "postgres", "-v", "ON_ERROR_STOP=1"], { input, encoding: "utf8" });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
}
sql(`begin;
  insert into auth.users(id) values('71110000-0000-4000-8000-000000000001');
  insert into public.weddings(id,client_owner_id,couple_names,currency,wedding_date)
    values('71110000-0000-4000-8000-000000000002','71110000-0000-4000-8000-000000000001','Populated finance predecessor','KES',current_date+30);
  insert into public.contributions(wedding_id,stream_name,pledged_amount_minor,currency)
    values('71110000-0000-4000-8000-000000000002','Predecessor pledge',1000,'KES');
  insert into public.expenses(wedding_id,category,description,amount_minor,currency)
    values('71110000-0000-4000-8000-000000000002','Fixture','Existing expense',100,'KES');
  insert into public.payout_records(wedding_id,amount_minor,currency,status)
    values('71110000-0000-4000-8000-000000000002',100,'KES','cancelled');
  commit;
  create table public.manual_upgrade_before as
  select 'weddings' as kind,to_jsonb(w) as payload from public.weddings w
  union all select 'contributions',to_jsonb(c) from public.contributions c
  union all select 'payouts',to_jsonb(p) from public.payout_records p
  union all select 'expenses',to_jsonb(e) from public.expenses e;
  create table public.manual_upgrade_gate as select pg_get_functiondef('public.live_payouts_enabled()'::regprocedure) as definition;
  begin; ${migration} rollback;
  do $$ begin
    if to_regclass('public.manual_payout_requests') is not null then raise exception 'DDL rollback failed'; end if;
  end $$;
  begin; ${migration}
  insert into supabase_migrations.schema_migrations(version,name,statements)
    values('202611110001','controlled_manual_payouts',array[]::text[]);
  commit;
  do $$ begin
    if exists((select * from public.manual_upgrade_before) except
      (select 'weddings',to_jsonb(w) from public.weddings w union all
       select 'contributions',to_jsonb(c) from public.contributions c union all
       select 'payouts',to_jsonb(p) from public.payout_records p union all
       select 'expenses',to_jsonb(e) from public.expenses e)) then raise exception 'Historical records changed'; end if;
    if (select count(*) from public.manual_upgrade_before) <>
       (select (select count(*) from public.weddings)+(select count(*) from public.contributions)+
        (select count(*) from public.payout_records)+(select count(*) from public.expenses)) then
      raise exception 'Migration created historical finance records'; end if;
    if public.manual_payouts_enabled() or public.live_payouts_enabled() then raise exception 'Payout gate unlocked'; end if;
    if (select definition from public.manual_upgrade_gate) is distinct from
      pg_get_functiondef('public.live_payouts_enabled()'::regprocedure) then raise exception 'Automatic gate changed'; end if;
    if exists(select 1 from public.manual_payout_requests) or exists(select 1 from public.manual_payout_evidence) then
      raise exception 'Migration fabricated payout evidence or reservations'; end if;
  end $$;`);
console.log("Manual payout upgrade fully COMMITs on populated predecessor; DDL rollback and historical/gate preservation passed.");
