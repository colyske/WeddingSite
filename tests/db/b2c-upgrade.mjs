import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

// CI-only, immediately after the populated manual-foundation upgrade.
const migration = readFileSync(new URL("../../supabase/migrations/202611120001_b2c_shared_dispatch.sql", import.meta.url), "utf8");
const tables = ["weddings", "contributions", "expenses", "payout_records", "manual_payout_policy",
  "manual_payout_evidence", "manual_payout_evidence_checks", "manual_payout_accounts", "manual_payout_custody",
  "manual_payout_statement_batches", "manual_payout_statement_lines", "manual_payout_source_allocations",
  "manual_payout_recipients", "manual_payout_settlements", "manual_payout_requests", "manual_payout_events",
  "manual_payout_claims", "manual_payout_receipts", "manual_payout_reconciliations", "manual_payout_statement_debits"];
const snapshot = tables.map(table => `select '${table}' as kind,to_jsonb(r) as payload from public.${table} r`).join(" union all ");
const fixture = suffix => `71112000-0000-4000-8000-${String(suffix).padStart(12, "0")}`;
const user = fixture(1), wedding = fixture(2), account = fixture(3), custody = fixture(4), recipient = fixture(5), payout = fixture(6);
const result = spawnSync("docker", ["exec", "-i", "supabase_db_weddingsite", "psql", "-U", "postgres",
  "-d", "postgres", "-v", "ON_ERROR_STOP=1"], { encoding: "utf8", input: `
  begin;
  insert into auth.users(id) values('${user}');
  insert into public.weddings(id,client_owner_id,couple_names,currency,wedding_date)
    values('${wedding}','${user}','Synthetic B2C upgrade predecessor','KES',current_date+30);
  insert into public.manual_payout_evidence(id,kind,external_reference,sha256,submitted_by) values
    ('${fixture(10)}','account','${fixture(20)}',repeat('a',64),'${user}'),
    ('${fixture(11)}','custody','${fixture(21)}',repeat('b',64),'${user}'),
    ('${fixture(12)}','recipient','${fixture(22)}',repeat('c',64),'${user}');
  insert into public.manual_payout_accounts values('${account}','daraja','${fixture(23)}','${fixture(10)}','${user}');
  insert into public.manual_payout_custody(id,provider,account_reference,currency,available_minor,statement_at,evidence_id,recorded_by)
    values('${custody}','daraja','${account}','KES',10000,now(),'${fixture(11)}','${user}');
  insert into public.manual_payout_recipients(id,wedding_id,evidence_id,provider,currency,kyc_snapshot_hash,recorded_by)
    values('${recipient}','${wedding}','${fixture(12)}','daraja','KES','synthetic-unreviewed','${user}');
  insert into public.manual_payout_requests(id,request_key,wedding_id,custody_id,recipient_revision,amount_minor,fee_minor,currency,requested_by)
    values('${payout}','${fixture(24)}','${wedding}','${custody}','${recipient}',1000,0,'KES','${user}');
  insert into public.manual_payout_events(payout_id,state,actor_id) values('${payout}','requested','${user}');
  commit;
  create table public.b2c_upgrade_before as ${snapshot};
  create table public.b2c_upgrade_gates as select
    pg_get_functiondef('public.manual_payout_require_enabled()'::regprocedure) as manual,
    pg_get_functiondef('public.live_payouts_enabled()'::regprocedure) as automatic;
  begin; ${migration} rollback;
  do $$ begin
    if to_regclass('public.b2c_dispatches') is not null or
      to_regprocedure('public.b2c_request(uuid,uuid,uuid,uuid,bigint)') is not null then
      raise exception 'B2C DDL rollback failed';
    end if;
  end $$;
  begin; ${migration}
  insert into supabase_migrations.schema_migrations(version,name,statements)
    values('202611120001','b2c_shared_dispatch',array[]::text[]);
  commit;
  do $$ begin
    if exists((select * from public.b2c_upgrade_before except all (${snapshot}))
      union all ((${snapshot}) except all select * from public.b2c_upgrade_before)) then
      raise exception 'B2C upgrade changed shared accounting or historical financial records';
    end if;
    if public.manual_payouts_enabled() or public.live_payouts_enabled()
      or exists(select 1 from public.b2c_policy where enabled or not require_four_eyes
        or per_payout_minor is not null or daily_minor is not null or payout_fee_minor is not null
        or cardinality(custody_ids)>0 or cardinality(recipient_ids)>0) then
      raise exception 'B2C upgrade activated a gate or invented approval limits';
    end if;
    if (select manual from public.b2c_upgrade_gates) is distinct from
      pg_get_functiondef('public.manual_payout_require_enabled()'::regprocedure)
      or (select automatic from public.b2c_upgrade_gates) is distinct from
      pg_get_functiondef('public.live_payouts_enabled()'::regprocedure) then
      raise exception 'B2C changed an existing execution gate';
    end if;
    if exists(select 1 from public.b2c_request_intents) or exists(select 1 from public.b2c_dispatches)
      or exists(select 1 from public.b2c_destinations) or exists(select 1 from public.b2c_reviewed_destinations) then
      raise exception 'B2C upgrade adopted a manual request or fabricated verified destinations/executions';
    end if;
  end $$;
` });
if (result.error) throw result.error;
assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
console.log("B2C migration COMMITs on populated shared accounting; rollback, history, channel ownership and default-OFF gates preserved.");
