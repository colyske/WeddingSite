create table public.referral_eligibility_events (
  id bigint generated always as identity primary key,
  wedding_id uuid not null references public.referral_attributions(wedding_id) on delete restrict,
  reason text not null check (reason in ('owner_account','client_membership')),
  linked_user_id uuid not null,
  created_at timestamptz not null default clock_timestamp(),
  unique(wedding_id,reason,linked_user_id)
);
create table public.referral_balances (
  contribution_id uuid primary key references public.referral_contribution_policy(contribution_id) on delete restrict,
  wedding_id uuid not null references public.referral_attributions(wedding_id) on delete restrict,
  currency char(3) not null,
  revision bigint not null default 0,
  basis_minor bigint not null default 0 check (basis_minor>=0),
  held_estimate_minor bigint not null default 0 check (held_estimate_minor>=0),
  hold_reasons text[] not null,
  source_digest text not null,
  updated_at timestamptz not null default clock_timestamp()
);
create table public.referral_estimate_ledger (
  id bigint generated always as identity primary key,
  contribution_id uuid not null references public.referral_contribution_policy(contribution_id) on delete restrict,
  wedding_id uuid not null references public.referral_attributions(wedding_id) on delete restrict,
  currency char(3) not null,
  revision bigint not null,
  policy_revision uuid not null,
  estimate_delta_minor bigint not null,
  basis_minor bigint not null,
  hold_reasons text[] not null,
  source_digest text not null,
  created_at timestamptz not null default clock_timestamp(),
  unique(contribution_id,revision)
);
create trigger referral_estimate_ledger_immutable before update or delete on public.referral_estimate_ledger
  for each row execute function public.referral_immutable();
create trigger referral_eligibility_events_immutable before update or delete on public.referral_eligibility_events
  for each row execute function public.referral_immutable();

-- Pure cap contract only. There is deliberately no source/attestation RPC that
-- can supply missing platform cash or commitments in this release.
create function public.referral_available_cap(
  p_estimate bigint,p_fees bigint,p_provider_costs bigint,p_losses bigint,p_holds bigint,
  p_settled_platform_net bigint,p_cash_holds bigint,p_other_commitments bigint,p_other_commissions bigint
) returns bigint language plpgsql immutable set search_path='' as $$
begin
  if p_estimate is null or p_fees is null or p_provider_costs is null or p_losses is null
    or p_holds is null or p_settled_platform_net is null or p_cash_holds is null
    or p_other_commitments is null or p_other_commissions is null then return 0; end if;
  if least(p_estimate,p_fees,p_provider_costs,p_losses,p_holds,p_settled_platform_net,
    p_cash_holds,p_other_commitments,p_other_commissions)<0 then
    raise exception 'Invalid referral cap input.';
  end if;
  return least(p_estimate,greatest(0::numeric,least(
    greatest(0::numeric,p_fees::numeric-p_provider_costs-p_losses-p_holds),
    greatest(0::numeric,p_settled_platform_net::numeric-p_cash_holds-p_other_commitments)
  )-p_other_commissions))::bigint;
end $$;

create function public.referral_reconcile_estimate(p_contribution_id uuid) returns void
language plpgsql security definer set search_path='' set row_security=off as $$
declare c public.contributions; s public.referral_contribution_policy; b public.referral_balances;
  refunds numeric:=0; disputes numeric:=0; basis bigint:=0; target bigint:=0;
  reasons text[]:=array['platform_settlement_unverified','platform_cost_inventory_incomplete',
    'platform_commitment_inventory_unverified','payouts_not_supported'];
  source text; adjustments jsonb; journal jsonb; events jsonb; v_excluded boolean;
begin
  select * into s from public.referral_contribution_policy where contribution_id=p_contribution_id for update;
  if not found then return; end if;
  select * into c from public.contributions where id=p_contribution_id;
  select coalesce(jsonb_agg(to_jsonb(a) order by a.id),'[]'::jsonb) into adjustments
    from public.payment_adjustments a where contribution_id=c.id;
  select coalesce(jsonb_agg(to_jsonb(l) order by l.id),'[]'::jsonb) into journal
    from public.financial_adjustment_ledger l where contribution_id=c.id;
  select coalesce(jsonb_agg(to_jsonb(e) order by e.id),'[]'::jsonb) into events
    from public.provider_adjustment_events e where contribution_id=c.id;
  v_excluded:=exists(select 1 from public.referral_eligibility_events where wedding_id=s.wedding_id);
  if s.rate_basis_points=0 then reasons:=array_append(reasons,'policy_or_consent_off_at_admission'); end if;
  if v_excluded then reasons:=array_append(reasons,'provable_self_account_link'); end if;
  if c.provider_fee_pending or c.provider_fee_minor is null then
    reasons:=array_append(reasons,'provider_cost_unknown'); end if;
  if c.currency is distinct from s.currency then reasons:=array_append(reasons,'currency_mismatch'); end if;
  if exists(select 1 from public.payment_adjustments where contribution_id=c.id
    and (currency<>s.currency or status in ('pending','open','review'))) then
    reasons:=array_append(reasons,'adjustment_review_or_hold'); end if;
  -- A reviewed, provider-confirmed refund still removes principal before its
  -- couple allocation is resolved. Never count its event and journal twice.
  select coalesce(sum(a.amount_minor),0) into refunds from public.payment_adjustments a
    where a.contribution_id=c.id and a.currency=s.currency and a.adjustment_kind='refund'
      and (a.status='processed' or (a.status='review' and exists(
        select 1 from public.provider_adjustment_events e where e.contribution_id=c.id
          and e.provider=a.provider and e.provider_adjustment_id=a.provider_adjustment_id
          and e.provider_state='refund_processed' and e.outcome in ('held','applied'))));
  select coalesce(sum(-l.couple_net_delta_minor::numeric),0) into disputes
    from public.financial_adjustment_ledger l where l.contribution_id=c.id
      and l.currency=s.currency and l.entry_type in ('dispute_debit','dispute_reversal');
  if refunds+disputes>c.paid_amount_minor or disputes<0 then
    reasons:=array_append(reasons,'overlapping_or_invalid_adjustments');
  elsif c.verified_provider_payment and c.payment_environment='live'
    and c.payment_status in ('paid','refunded') and c.paid_amount_minor>0
    and c.platform_fee_minor>0 and c.currency=s.currency and not v_excluded then
    if c.payment_status='refunded' and refunds=0 then
      reasons:=array_append(reasons,'refund_evidence_missing');
    else
      basis:=greatest(0::numeric,c.paid_amount_minor::numeric-refunds-disputes)::bigint;
      target:=floor(basis::numeric*s.rate_basis_points/10000)::bigint;
    end if;
  else
    reasons:=array_append(reasons,'not_eligible_verified_live_payment');
  end if;
  source:=encode(extensions.digest(jsonb_build_object(
    'amount',c.paid_amount_minor,'fee',c.platform_fee_minor,'provider_fee',c.provider_fee_minor,
    'provider_pending',c.provider_fee_pending,'status',c.payment_status,'verified',c.verified_provider_payment,
    'environment',c.payment_environment,'currency',c.currency,'adjustments',adjustments,'journal',journal,'events',events,
    'excluded',v_excluded,'rate',s.rate_basis_points)::text,'sha256'),'hex');
  select * into b from public.referral_balances where contribution_id=c.id;
  if found and b.source_digest=source then return; end if;
  insert into public.referral_estimate_ledger(contribution_id,wedding_id,currency,revision,
    policy_revision,estimate_delta_minor,basis_minor,hold_reasons,source_digest)
    values(c.id,s.wedding_id,s.currency,coalesce(b.revision,0)+1,s.policy_revision,
      target-coalesce(b.held_estimate_minor,0),basis,reasons,source);
  insert into public.referral_balances(contribution_id,wedding_id,currency,revision,
    basis_minor,held_estimate_minor,hold_reasons,source_digest)
    values(c.id,s.wedding_id,s.currency,coalesce(b.revision,0)+1,basis,target,reasons,source)
    on conflict(contribution_id) do update set revision=excluded.revision,basis_minor=excluded.basis_minor,
      held_estimate_minor=excluded.held_estimate_minor,hold_reasons=excluded.hold_reasons,
      source_digest=excluded.source_digest,updated_at=clock_timestamp();
end $$;

create function public.referral_estimate_source_changed() returns trigger
language plpgsql security definer set search_path='' set row_security=off as $$
begin
  if tg_table_name='contributions' then perform public.referral_reconcile_estimate(new.id);
  else perform public.referral_reconcile_estimate(new.contribution_id); end if;
  return new;
end $$;
create constraint trigger referral_contribution_estimate after insert or update on public.contributions
  deferrable initially deferred for each row execute function public.referral_estimate_source_changed();
create constraint trigger referral_adjustment_estimate after insert or update on public.payment_adjustments
  deferrable initially deferred for each row execute function public.referral_estimate_source_changed();
create constraint trigger referral_adjustment_journal_estimate after insert on public.financial_adjustment_ledger
  deferrable initially deferred for each row execute function public.referral_estimate_source_changed();
create constraint trigger referral_adjustment_event_estimate after insert or update on public.provider_adjustment_events
  deferrable initially deferred for each row execute function public.referral_estimate_source_changed();

create function public.referral_account_link_changed() returns trigger
language plpgsql security definer set search_path='' set row_security=off as $$
declare a public.referral_attributions; cid uuid;
begin
  if tg_table_name='weddings' then
    select * into a from public.referral_attributions where wedding_id=new.id and referrer_id=new.client_owner_id;
    if found then
      insert into public.referral_eligibility_events(wedding_id,reason,linked_user_id)
        values(a.wedding_id,'owner_account',a.referrer_id) on conflict do nothing;
    end if;
  else
    -- Only legacy client-authority links are proof here, never helper/admin grants.
    if new.role<>'client' then return new; end if;
    select * into a from public.referral_attributions where wedding_id=new.wedding_id and referrer_id=new.user_id;
    if found then
      insert into public.referral_eligibility_events(wedding_id,reason,linked_user_id)
        values(a.wedding_id,'client_membership',a.referrer_id) on conflict do nothing;
    end if;
  end if;
  if a.wedding_id is not null then
    for cid in select contribution_id from public.referral_contribution_policy
      where wedding_id=a.wedding_id order by contribution_id loop
      perform public.referral_reconcile_estimate(cid);
    end loop;
  end if;
  return new;
end $$;
create constraint trigger referral_owner_link after update on public.weddings
  deferrable initially deferred for each row execute function public.referral_account_link_changed();
create constraint trigger referral_client_link after insert or update on public.wedding_memberships
  deferrable initially deferred for each row execute function public.referral_account_link_changed();

create function public.referral_my_summary() returns jsonb
language plpgsql stable security definer set search_path='' set row_security=off as $$
begin
  if auth.uid() is null then raise exception 'Referral authentication required.'; end if;
  return jsonb_build_object(
    'account',(select jsonb_build_object('code',a.code,'opted_in',a.opted_in,
      'consent_at',a.consent_at,'terms_version',a.terms_version) from public.referral_accounts a where user_id=auth.uid()),
    'referral_count',(select count(*) from public.referral_attributions where referrer_id=auth.uid()),
    'weddings',coalesce((select jsonb_agg(x) from (
      select a.wedding_id as reference,a.eligible,b.currency,
        exists(select 1 from public.referral_eligibility_events e where e.wedding_id=a.wedding_id) as excluded_by_account_link,
        coalesce(sum(b.basis_minor),0)::text as verified_basis_minor,
        coalesce(sum(b.held_estimate_minor),0)::text as held_estimate_minor,
        '0'::text as payable_minor,'held'::text as status
      from public.referral_attributions a left join public.referral_balances b on b.wedding_id=a.wedding_id
      where a.referrer_id=auth.uid() group by a.wedding_id,a.eligible,b.currency order by a.wedding_id,b.currency
    ) x),'[]'::jsonb),'payable_minor','0','payouts_enabled',false,
    'hold_reasons',array['platform_settlement_unverified','platform_cost_inventory_incomplete',
      'platform_commitment_inventory_unverified','payouts_not_supported']);
end $$;
create function public.referral_admin_ledger(p_before bigint default null) returns jsonb
language plpgsql stable security definer set search_path='' set row_security=off as $$
begin
  perform public.require_staff('superadmin');
  return jsonb_build_object('status','held','payable_minor','0','payouts_enabled',false,
    'entries',coalesce((select jsonb_agg(jsonb_build_object(
      'id',l.id::text,'wedding_id',l.wedding_id,'contribution_id',l.contribution_id,'currency',l.currency,
      'revision',l.revision::text,'policy_revision',l.policy_revision,
      'estimate_delta_minor',l.estimate_delta_minor::text,'basis_minor',l.basis_minor::text,
      'hold_reasons',l.hold_reasons,'created_at',l.created_at
    ) order by l.id desc) from (select * from public.referral_estimate_ledger
      where p_before is null or id<p_before order by id desc limit 100) l),'[]'::jsonb));
end $$;

do $$
declare t text; fn record;
begin
  foreach t in array array['referral_eligibility_events','referral_balances','referral_estimate_ledger'] loop
    execute format('alter table public.%I enable row level security',t);
    execute format('revoke all on public.%I from public,anon,authenticated,service_role',t);
  end loop;
  for fn in select p.oid::regprocedure signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname in ('referral_available_cap','referral_reconcile_estimate',
      'referral_estimate_source_changed','referral_account_link_changed','referral_my_summary','referral_admin_ledger') loop
    execute format('revoke all on function %s from public,anon,authenticated,service_role',fn.signature);
  end loop;
end $$;
grant execute on function public.referral_my_summary(),public.referral_admin_ledger(bigint) to authenticated;
