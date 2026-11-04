-- Offline operator reporting, not provider verification or legacy gate activation.
-- Existing requests, claims, statements, policies and evidence stay unchanged.
create table public.simple_payout_requests (
  id uuid primary key default extensions.gen_random_uuid(),
  request_key uuid not null unique,
  wedding_id uuid not null references public.weddings(id),
  requested_by uuid not null references public.profiles(id),
  amount_minor bigint not null check(amount_minor>0 and amount_minor<=9007199254740991),
  currency text not null check(currency='KES'),
  partner_slot integer not null check(partner_slot in (1,2)),
  kyc_hash text not null,
  consent_at timestamptz not null default clock_timestamp(),
  requested_at timestamptz not null default clock_timestamp()
);
create table public.simple_payout_events (
  id bigint generated always as identity primary key,
  payout_id uuid not null references public.simple_payout_requests(id),
  action_key uuid not null unique,
  state text not null check(state in ('requested','hold','reviewed','processing','paid','cancelled')),
  reason text check(reason in ('recipient_check','funds_review','operator_unavailable','outcome_uncertain','other_review')),
  actor_id uuid not null references public.profiles(id),
  created_at timestamptz not null default clock_timestamp()
);
create table public.simple_payout_claims (
  payout_id uuid primary key references public.simple_payout_requests(id),
  claim_key uuid not null unique,
  sender_id uuid not null references public.profiles(id),
  reviewer_id uuid not null references public.profiles(id),
  owner_solo boolean not null,
  fee_minor bigint not null check(fee_minor>=0 and fee_minor<=9007199254740991),
  provider text not null check(provider='daraja'),
  claimed_at timestamptz not null default clock_timestamp()
);
create table public.simple_payout_receipts (
  payout_id uuid primary key references public.simple_payout_requests(id),
  provider text not null check(provider='daraja'),
  transaction_reference text not null check(transaction_reference ~ '^[A-Z0-9][A-Z0-9._:-]{0,119}$'),
  reported_by uuid not null references public.profiles(id),
  reported_at timestamptz not null default clock_timestamp(),
  unique(provider,transaction_reference)
);
-- Conservative provider-wide deduplication: without collecting merchant account
-- details, ambiguous same-provider references are held rather than guessed apart.
create table public.simple_payout_incidents (
  id bigint generated always as identity primary key,
  payout_id uuid not null references public.simple_payout_requests(id),
  provider text not null,
  transaction_reference text not null,
  actor_id uuid not null references public.profiles(id),
  created_at timestamptz not null default clock_timestamp(),
  unique(payout_id,provider,transaction_reference)
);
do $$ declare t text; begin
  foreach t in array array['simple_payout_requests','simple_payout_events','simple_payout_claims',
    'simple_payout_receipts','simple_payout_incidents'] loop
    execute format('alter table public.%I enable row level security',t);
    execute format('revoke all on public.%I from public,anon,authenticated,service_role',t);
    execute format('create trigger simple_payout_immutable before update or delete on public.%I
      for each row execute function public.manual_payout_immutable()',t);
  end loop;
end $$;

create function public.simple_payout_state(p_id uuid) returns text
language sql stable security definer set search_path='' as $$
  select state from public.simple_payout_events where payout_id=p_id order by id desc limit 1
$$;
create function public.simple_payout_kyc_hash(p_wedding uuid) returns text
language sql stable security definer set search_path='' as $$
  select encode(extensions.digest(to_jsonb(k)::text,'sha256'),'hex') from public.wedding_kyc k where wedding_id=p_wedding
$$;
create function public.simple_payout_lock(p_wedding uuid) returns void
language plpgsql security definer set search_path='' as $$
begin
  perform pg_advisory_xact_lock(71110001);
  perform 1 from public.profiles where id=auth.uid() for share;
  perform 1 from public.contributions where wedding_id=p_wedding order by id for update;
  perform 1 from public.weddings where id=p_wedding for update;
  perform 1 from public.wedding_kyc where wedding_id=p_wedding for share;
end $$;
create function public.simple_payout_available(p_wedding uuid,p_exclude uuid default null,p_old_exclude uuid default null)
returns bigint language sql stable security definer set search_path='' as $$
  select greatest(coalesce((select sum(c.net_paid_minor::numeric-c.provider_fee_minor)
    from public.contributions c join public.weddings w on w.id=c.wedding_id
    where c.wedding_id=p_wedding and c.currency=w.currency and c.payment_environment='live'
      and c.settlement_route='platform_wallet' and c.payment_status='paid' and c.verified_provider_payment
      and not c.provider_fee_pending and c.provider_fee_minor is not null and c.provider_fee_minor>=0
      and c.net_paid_minor>=c.provider_fee_minor and c.provider_name in ('daraja','paystack')
      and (c.funds_available_at is null or c.funds_available_at<=now())),0)
    - coalesce((select sum(s.debit_minor::numeric+s.hold_minor) from public.manual_payout_sources() s
      join public.weddings w on w.id=s.wedding_id where s.wedding_id=p_wedding and s.currency=w.currency),0)
    - coalesce((select sum(r.amount_minor::numeric+r.fee_minor) from public.manual_payout_requests r
      join public.weddings w on w.id=r.wedding_id where r.wedding_id=p_wedding and r.currency=w.currency
      and r.id is distinct from p_old_exclude and public.manual_payout_state(r.id) not in ('cancelled','not_transferred')),0)
    - coalesce((select sum(r.amount_minor::numeric+coalesce(c.fee_minor,0)) from public.simple_payout_requests r
      left join public.simple_payout_claims c on c.payout_id=r.id where r.wedding_id=p_wedding
      and r.id is distinct from p_exclude and public.simple_payout_state(r.id)<>'cancelled'),0),0)::bigint
$$;

create function public.simple_payout_submit(p_key uuid,p_wedding uuid,p_amount bigint,p_partner integer,p_confirmed boolean)
returns uuid language plpgsql security definer set search_path='' as $$
declare prior public.simple_payout_requests; result uuid; phone text;
begin
  perform public.simple_payout_lock(p_wedding);
  if auth.uid() is null or not exists(select 1 from public.weddings where id=p_wedding and client_owner_id=auth.uid()) then
    raise exception 'SIMPLE_PAYOUT: Wedding owner access required.'; end if;
  if p_confirmed is distinct from true or p_key is null or p_partner not in (1,2) or p_partner is null then
    raise exception 'SIMPLE_PAYOUT: Confirm the amount, selected recipient and consent.'; end if;
  select * into prior from public.simple_payout_requests where request_key=p_key;
  if found then
    if (prior.wedding_id,prior.requested_by,prior.amount_minor,prior.partner_slot) is distinct from
      (p_wedding,auth.uid(),p_amount,p_partner) then raise exception 'SIMPLE_PAYOUT: Request retry changed. Refresh history.'; end if;
    return prior.id;
  end if;
  if not public.kyc_is_complete(p_wedding) then raise exception 'PAYOUT_KYC_REQUIRED: Complete both partners identity details and consent first.'; end if;
  select case when p_partner=1 then partner1_phone else partner2_phone end into phone from public.wedding_kyc where wedding_id=p_wedding;
  if not exists(select 1 from public.weddings where id=p_wedding and currency='KES')
    or regexp_replace(phone,'[^0-9]','','g') !~ '^(254[17][0-9]{8}|0[17][0-9]{8})$' then
    raise exception 'SIMPLE_PAYOUT: This path supports KES to an existing Kenyan partner phone. Ask support for other receiving methods; do not enter bank details here.'; end if;
  perform public.manual_payout_check_amount(p_wedding,'KES',p_amount);
  if p_amount>public.simple_payout_available(p_wedding) then raise exception 'SIMPLE_PAYOUT: Amount exceeds available wedding balance.'; end if;
  insert into public.simple_payout_requests(request_key,wedding_id,requested_by,amount_minor,currency,partner_slot,kyc_hash)
    values(p_key,p_wedding,auth.uid(),p_amount,'KES',p_partner,public.simple_payout_kyc_hash(p_wedding)) returning id into result;
  insert into public.simple_payout_events(payout_id,action_key,state,actor_id) values(result,p_key,'requested',auth.uid());
  return result;
end $$;

create function public.simple_payout_action(p_id uuid,p_key uuid,p_action text,p_reason text,p_fee bigint,
  p_reference text,p_solo boolean,p_recipient_confirmed boolean,p_confirmed boolean) returns jsonb
language plpgsql security definer set search_path='' as $$
declare r public.simple_payout_requests; c public.simple_payout_claims; old_event public.simple_payout_events;
  current_state text; reviewer uuid; role public.platform_role; ref text:=upper(btrim(p_reference));
begin
  select * into strict r from public.simple_payout_requests where id=p_id;
  perform public.simple_payout_lock(r.wedding_id);
  role:=public.current_platform_role();
  if role not in ('owner','superadmin') or role is null then raise exception 'SIMPLE_PAYOUT: Leadership access required.'; end if;
  if p_key is null or p_confirmed is distinct from true or p_solo is null or p_recipient_confirmed is null
    or p_action is null or p_action not in ('hold','reviewed','processing','paid','cancelled')
    or (p_solo and role<>'owner') then raise exception 'SIMPLE_PAYOUT: Explicit valid action confirmation required.'; end if;
  if (p_action='hold' and (p_reason is null or p_reason not in
      ('recipient_check','funds_review','operator_unavailable','outcome_uncertain','other_review')))
    or (p_action<>'hold' and p_reason is not null)
    or (p_action<>'processing' and (p_fee is not null or p_solo))
    or (p_action not in ('reviewed','processing') and p_recipient_confirmed)
    or (p_action<>'paid' and p_reference is not null) then
    raise exception 'SIMPLE_PAYOUT: Only fields belonging to the selected action are accepted.'; end if;
  select * into c from public.simple_payout_claims where payout_id=p_id;
  select * into old_event from public.simple_payout_events where action_key=p_key;
  if found then
    if old_event.payout_id=p_id and old_event.state='hold' and old_event.reason='outcome_uncertain'
      and old_event.actor_id=auth.uid() and p_action='paid' and exists(
        select 1 from public.simple_payout_incidents where payout_id=p_id and transaction_reference=ref and actor_id=auth.uid()) then
      return jsonb_build_object('state','hold','conflict',true,'replayed',true);
    end if;
    if (old_event.payout_id,old_event.state,old_event.reason,old_event.actor_id) is distinct from
      (p_id,p_action,p_reason,auth.uid()) or (p_action='processing' and
      (c.claim_key,c.sender_id,c.fee_minor,c.owner_solo) is distinct from (p_key,auth.uid(),p_fee,p_solo))
      or (p_action='paid' and not exists(select 1 from public.simple_payout_receipts
        where payout_id=p_id and transaction_reference=ref and reported_by=auth.uid())) then
      raise exception 'SIMPLE_PAYOUT: Action retry changed. Refresh history; do not resend.'; end if;
    return jsonb_build_object('state',public.simple_payout_state(p_id),'replayed',true);
  end if;
  current_state:=public.simple_payout_state(p_id);
  if current_state in ('paid','cancelled') then raise exception 'SIMPLE_PAYOUT: Terminal record cannot be changed.'; end if;
  if p_action='cancelled' and c.payout_id is not null then
    raise exception 'SIMPLE_PAYOUT: Processing has already been claimed. Hold it; never release or resend an uncertain transfer.'; end if;
  if p_action='reviewed' then
    if c.payout_id is not null or not p_recipient_confirmed or not public.kyc_is_complete(r.wedding_id)
      or r.kyc_hash is distinct from public.simple_payout_kyc_hash(r.wedding_id) then
      raise exception 'SIMPLE_PAYOUT: Check the current recipient and consent. Changed identity needs a new request before processing.'; end if;
    if r.amount_minor>public.simple_payout_available(r.wedding_id,r.id) then
      raise exception 'SIMPLE_PAYOUT: Balance changed. Hold for funds review before checking this request.'; end if;
  end if;
  if p_action='processing' then
    if c.payout_id is not null then raise exception 'SIMPLE_PAYOUT: Already claimed. Do not send again; record Paid or Hold the existing claim.'; end if;
    if p_fee is null or p_fee<0 or not p_recipient_confirmed
      or not public.kyc_is_complete(r.wedding_id) or r.kyc_hash is distinct from public.simple_payout_kyc_hash(r.wedding_id) then
      raise exception 'SIMPLE_PAYOUT: Enter the actual expected fee and check the unchanged recipient/consent before Processing.'; end if;
    if exists(select 1 from public.simple_payout_incidents where provider='daraja')
      or exists(select 1 from public.manual_payout_account_holds h join public.manual_payout_custody a on a.id=h.custody_id where a.provider='daraja') then
      raise exception 'SIMPLE_PAYOUT: Conflicting transaction IDs hold this provider. Contact support; do not resend.'; end if;
    if p_solo then reviewer:=auth.uid();
    else
      select e.actor_id into reviewer from public.simple_payout_events e
        join public.profiles p on p.id=e.actor_id and p.platform_role in ('owner','superadmin')
        where e.payout_id=p_id and e.state='reviewed' and e.actor_id<>auth.uid() order by e.id desc limit 1;
      if reviewer is null then raise exception 'SIMPLE_PAYOUT: Another eligible leader must check the recipient first, or the protected Owner may explicitly use solo mode.'; end if;
      perform 1 from public.profiles where id=reviewer and platform_role in ('owner','superadmin') for share;
      if not found then raise exception 'SIMPLE_PAYOUT: Reviewer authority changed. Request another review.'; end if;
    end if;
    perform public.manual_payout_check_amount(r.wedding_id,r.currency,r.amount_minor);
    if r.amount_minor::numeric+p_fee>public.simple_payout_available(r.wedding_id,r.id) then
      raise exception 'SIMPLE_PAYOUT: Balance changed or cannot cover this amount plus the fee. Hold for funds review.'; end if;
    insert into public.simple_payout_claims values(p_id,p_key,auth.uid(),reviewer,p_solo,p_fee,'daraja',clock_timestamp());
  end if;
  if p_action='paid' then
    if c.payout_id is null or c.sender_id<>auth.uid() then raise exception 'SIMPLE_PAYOUT: Only the claimed operator can report their external transfer.'; end if;
    if ref is null or ref !~ '^[A-Z0-9][A-Z0-9._:-]{0,119}$' then raise exception 'SIMPLE_PAYOUT: Enter the actual transaction ID, not recipient details.'; end if;
    if exists(select 1 from public.simple_payout_incidents where payout_id=p_id) then
      raise exception 'SIMPLE_PAYOUT: A conflicting outcome already holds this request. Contact support; changing the transaction ID cannot resolve it. Do not resend.'; end if;
    if exists(select 1 from public.simple_payout_receipts where provider=c.provider and transaction_reference=ref)
      or exists(select 1 from public.manual_payout_receipts where provider=c.provider and transaction_reference=ref)
      or exists(select 1 from public.b2c_callback_events where kind='result' and evidence->>'result_code'='0'
        and upper(evidence->>'transaction_id')=ref and c.provider='daraja') then
      insert into public.simple_payout_incidents(payout_id,provider,transaction_reference,actor_id)
        values(p_id,c.provider,ref,auth.uid()) on conflict do nothing;
      insert into public.simple_payout_events(payout_id,action_key,state,reason,actor_id)
        values(p_id,p_key,'hold','outcome_uncertain',auth.uid());
      return jsonb_build_object('state','hold','conflict',true,'message','Transaction ID already used. Reservation and claim retained; do not resend.');
    end if;
    insert into public.simple_payout_receipts(payout_id,provider,transaction_reference,reported_by)
      values(p_id,c.provider,ref,auth.uid());
  end if;
  insert into public.simple_payout_events(payout_id,action_key,state,reason,actor_id) values(p_id,p_key,p_action,p_reason,auth.uid());
  return jsonb_build_object('state',p_action,'operator_reported',p_action='paid');
end $$;

-- New exposure must also be honored by every existing financial admission/claim.
create function public.simple_payout_guard_existing() returns trigger
language plpgsql security definer set search_path='' as $$
declare r public.manual_payout_requests;
begin
  perform pg_advisory_xact_lock(71110001);
  if tg_table_name='manual_payout_events' then
    if new.state not in ('approved','executing') then return new; end if;
  end if;
  if tg_table_name='manual_payout_requests' then r:=new;
  else select * into strict r from public.manual_payout_requests where id=new.payout_id; end if;
  if tg_table_name='manual_payout_claims' and exists(
    select 1 from public.simple_payout_incidents i join public.manual_payout_custody a on a.provider=i.provider
      where a.id=r.custody_id) then
    raise exception 'SIMPLE_PAYOUT: Conflicting transaction IDs hold this provider; do not send.'; end if;
  if exists(select 1 from public.simple_payout_requests where wedding_id=r.wedding_id
      and public.simple_payout_state(id)<>'cancelled')
    and r.amount_minor::numeric+r.fee_minor>public.simple_payout_available(r.wedding_id,null,r.id) then
    raise exception 'SIMPLE_PAYOUT: Wedding funds already committed to another payout path.'; end if;
  return new;
end $$;
create trigger simple_payout_guard_existing before insert on public.manual_payout_requests
  for each row execute function public.simple_payout_guard_existing();
create trigger simple_payout_guard_existing before insert on public.manual_payout_events
  for each row execute function public.simple_payout_guard_existing();
create trigger simple_payout_guard_existing before insert on public.manual_payout_claims
  for each row execute function public.simple_payout_guard_existing();

create function public.simple_payout_guard_commitment() returns trigger
language plpgsql security definer set search_path='' as $$
declare prior_debit numeric:=0; next_debit numeric;
begin
  if not pg_try_advisory_xact_lock(71110001) then
    raise exception 'SIMPLE_PAYOUT: Accounting is busy. Retry the commitment after review.'; end if;
  if not exists(select 1 from public.simple_payout_requests where wedding_id=new.wedding_id
    and public.simple_payout_state(id)<>'cancelled') then return new; end if;
  next_debit:=case when (tg_table_name='expenses' and new.status::text in ('approved','paid'))
    or (tg_table_name='payout_records' and new.status::text in ('requested','approved','sent')) then new.amount_minor else 0 end;
  if tg_op='UPDATE' then
    if (new.wedding_id,new.currency) is not distinct from (old.wedding_id,old.currency) then
      prior_debit:=case when (tg_table_name='expenses' and old.status::text in ('approved','paid'))
        or (tg_table_name='payout_records' and old.status::text in ('requested','approved','sent')) then old.amount_minor else 0 end;
    end if;
  end if;
  if exists(select 1 from public.weddings where id=new.wedding_id and currency=new.currency)
    and next_debit-prior_debit>public.simple_payout_available(new.wedding_id) then
    raise exception 'SIMPLE_PAYOUT: Wedding funds already reserved. This commitment would overdraw them.'; end if;
  return new;
end $$;
create trigger simple_payout_guard_commitment before insert or update on public.expenses
  for each row execute function public.simple_payout_guard_commitment();
create trigger simple_payout_guard_commitment before insert or update on public.payout_records
  for each row execute function public.simple_payout_guard_commitment();

-- Preserve old report/reconcile behavior, adding only new-path conflicts to its
-- existing committed hold branch. No provider/rail gate is altered.
do $$ declare name text; definition text; updated text; begin
  foreach name in array array['manual_payout_report','b2c_reconcile'] loop
    select pg_get_functiondef(oid) into strict definition from pg_proc
      where pronamespace='public'::regnamespace and proname=name;
    if name='manual_payout_report' then
      updated:=replace(definition,'if p_actual is distinct from r.amount_minor',
        'if exists(select 1 from public.simple_payout_receipts where provider=a.provider and transaction_reference=upper(btrim(p_reference))) or p_actual is distinct from r.amount_minor');
    else
      updated:=replace(definition,'if exists(select 1 from public.manual_payout_receipts where provider=a.provider',
        'if exists(select 1 from public.simple_payout_receipts where provider=a.provider and transaction_reference=upper(btrim(p_reference))) or exists(select 1 from public.manual_payout_receipts where provider=a.provider');
    end if;
    if updated=definition then raise exception 'Unexpected report predecessor: %',name; end if;
    execute updated;
  end loop;
end $$;
create function public.simple_payout_receipt_guard() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  perform pg_advisory_xact_lock(71110001);
  if exists(select 1 from public.simple_payout_receipts where provider=new.provider and transaction_reference=new.transaction_reference) then
    raise exception 'SIMPLE_PAYOUT: Transaction ID already reported on another payout path; hold and investigate.'; end if;
  return new;
end $$;
create trigger simple_payout_receipt_guard before insert on public.manual_payout_receipts
  for each row execute function public.simple_payout_receipt_guard();

-- Extend the existing paid-history invariant to weddings using the simple path.
do $$ declare definition text; updated text; begin
  definition:=pg_get_functiondef('public.manual_payout_preserve_attributed_history()'::regprocedure);
  updated:=replace(definition,'and exists(select 1 from public.manual_payout_requests r join',
    'and (exists(select 1 from public.manual_payout_requests r join');
  updated:=replace(updated,'and a.shared_manual) then',
    'and a.shared_manual) or exists(select 1 from public.simple_payout_requests where wedding_id=old.wedding_id)) then');
  if updated=definition or position('simple_payout_requests' in updated)=0 then
    raise exception 'Unexpected attributed history predecessor'; end if;
  execute updated;
end $$;

create function public.simple_payout_status(p_wedding uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare result jsonb;
begin
  if auth.uid() is null or not exists(select 1 from public.weddings where id=p_wedding
    and (client_owner_id=auth.uid() or public.current_platform_role() in ('owner','superadmin'))) then
    raise exception 'SIMPLE_PAYOUT: Wedding access required.'; end if;
  select jsonb_build_object('currency',w.currency,'available_minor',public.simple_payout_available(w.id),
    'kyc_complete',public.kyc_is_complete(w.id),'supported',w.currency='KES',
    'recipients',jsonb_build_array(
      jsonb_build_object('slot',1,'label','Partner 1 phone ending '||right(regexp_replace(coalesce(k.partner1_phone,''),'[^0-9]','','g'),4)),
      jsonb_build_object('slot',2,'label','Partner 2 phone ending '||right(regexp_replace(coalesce(k.partner2_phone,''),'[^0-9]','','g'),4))),
    'requests',coalesce((select jsonb_agg(to_jsonb(x) order by requested_at desc) from (
      select r.id,r.amount_minor,r.currency,r.partner_slot,r.requested_at,public.simple_payout_state(r.id) status,
        r.kyc_hash is distinct from public.simple_payout_kyc_hash(r.wedding_id) recipient_changed,
        c.fee_minor,c.sender_id,c.owner_solo,c.claimed_at,x.transaction_reference,
        (select reason from public.simple_payout_events where payout_id=r.id order by id desc limit 1) reason,
        (select jsonb_agg(jsonb_build_object('state',state,'reason',reason,'actor_id',actor_id,'at',created_at) order by id)
          from public.simple_payout_events where payout_id=r.id) history
      from public.simple_payout_requests r left join public.simple_payout_claims c on c.payout_id=r.id
        left join public.simple_payout_receipts x on x.payout_id=r.id where r.wedding_id=w.id order by requested_at desc limit 100
    ) x),'[]'::jsonb)) into result
    from public.weddings w left join public.wedding_kyc k on k.wedding_id=w.id where w.id=p_wedding;
  return result;
end $$;
create function public.simple_payout_workspace() returns jsonb
language plpgsql stable security definer set search_path='' as $$
begin
  perform public.require_staff('superadmin');
  return jsonb_build_object('actor_id',auth.uid(),'weddings',coalesce((select jsonb_agg(jsonb_build_object('id',w.id,'label',w.couple_names,
    'payouts',public.simple_payout_status(w.id))) from public.weddings w where exists(
      select 1 from public.simple_payout_requests where wedding_id=w.id)),'[]'::jsonb),
    'notice','Offline operator reporting only. Paid is not provider verification or statement reconciliation. No gate or provider is activated.');
end $$;
do $$ declare f record; begin
  for f in select oid,proname from pg_proc where pronamespace='public'::regnamespace and proname like 'simple_payout_%' loop
    execute format('revoke all on function %s from public,anon,authenticated,service_role',f.oid::regprocedure);
    if f.proname in ('simple_payout_submit','simple_payout_action','simple_payout_status','simple_payout_workspace') then
      execute format('grant execute on function %s to authenticated',f.oid::regprocedure);
    end if;
  end loop;
end $$;
