import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

const read = file => readFileSync(new URL(file, import.meta.url), "utf8");
const run = input => {
  const result = spawnSync("docker", ["exec", "-i", "supabase_db_weddingsite", "psql", "-U", "postgres", "-d", "postgres",
    "-v", "ON_ERROR_STOP=1"], { encoding: "utf8", input });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout.slice(-6000)}`);
};

const readiness = read("./manual-payout-readiness.sql");
assert.match(readiness, /rollback;\s*$/);
run(readiness.replace(/rollback;\s*$/, () => read("./facilitator-reference-observation.sql") + "\nrollback;"));

const b2c = read("./b2c.sql");
const marker = "  receipt_at:=clock_timestamp();";
const setup = "do $$\ndeclare owner_id uuid:=";
assert.equal(b2c.split(marker).length, 2);
assert.equal(b2c.split(setup).length, 2);
const b2cFixture = b2c.replace(setup, () => `
-- The synthetic receipt has no backing claim; callback-trigger behavior is
-- covered separately by payout-reference-guard.sql.
set local session_replication_role=replica;
insert into public.facilitator_manual_receipts(request_id,provider,transaction_reference,reported_by)
  values(extensions.gen_random_uuid(),'daraja','SYNRECEIPT',extensions.gen_random_uuid());
set local session_replication_role=origin;
alter table public.b2c_callback_events disable trigger facilitator_b2c_reference_incident;
${setup}`);
run(b2cFixture.replace(marker, () => `${marker}
    perform pg_temp.b2c_reject(format('select pg_temp.b2c_reconcile(%L,%L,%L,%L,%L,%L,100,%L)',
      dispatch,receipt_evidence,paid_evidence,account,statement,line,receipt_at),'Independent final');
    perform set_config('request.jwt.claim.sub',staff_id::text,true);
    outcome:=pg_temp.b2c_reconcile(dispatch,receipt_evidence,paid_evidence,account,statement,line,100,receipt_at);
    if outcome is distinct from 'account_held'
      or public.manual_payout_state(payout)<>'uncertain'
      or not exists(select 1 from public.manual_payout_claims where payout_id=payout)
      or not exists(select 1 from public.manual_payout_account_holds where payout_id=payout
        and evidence_id=paid_evidence and transaction_reference='SYNRECEIPT'
        and actual_minor=10000 and actual_fee_minor=100 and currency='KES' and observed_at=receipt_at)
      or exists(select 1 from public.manual_payout_receipts where payout_id=payout) then
      raise exception 'B2C facilitator collision lost observation or claim';
    end if;
    outcome:=pg_temp.b2c_reconcile(dispatch,receipt_evidence,paid_evidence,account,statement,line,100,receipt_at);
    if outcome is distinct from 'account_held'
      or (select count(*) from public.manual_payout_account_holds where payout_id=payout and evidence_id=paid_evidence)<>1 then
      raise exception 'B2C facilitator collision replay was not idempotent';
    end if;
    return;
`));
console.log("Facilitator reference collisions retain simple, manual, and B2C observations and claims.");
