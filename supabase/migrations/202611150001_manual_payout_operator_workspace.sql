-- Read-only leadership workspace for the released manual payout workflow.
-- Exposes only opaque IDs, providers, amounts and actor IDs already held in the
-- append-only manual tables: no KYC snapshot hash, names, bank or contact data.
-- Listing/intents never change policy, gates, reservations, claims or reconciliation.
-- Explicit staff creation delegates to the existing guarded reservation RPC.
create table public.manual_payout_intents (
  id uuid primary key default extensions.gen_random_uuid(),
  request_key uuid not null unique,
  wedding_id uuid not null references public.weddings(id),
  requested_by uuid not null references public.profiles(id),
  amount_minor bigint not null check(amount_minor>0),
  currency text not null check(currency ~ '^[A-Z]{3}$'),
  requested_at timestamptz not null default clock_timestamp()
);
create table public.manual_payout_intent_reviews (
  intent_id uuid primary key references public.manual_payout_intents(id),
  decision text not null check(decision in ('created','declined')),
  payout_id uuid unique references public.manual_payout_requests(id),
  actor_id uuid not null references public.profiles(id),
  reviewed_at timestamptz not null default clock_timestamp(),
  check((decision='created')=(payout_id is not null))
);
alter table public.manual_payout_intents enable row level security;
alter table public.manual_payout_intent_reviews enable row level security;
revoke all on public.manual_payout_intents,public.manual_payout_intent_reviews from public,anon,authenticated,service_role;
create trigger manual_payout_immutable before update or delete on public.manual_payout_intents
  for each row execute function public.manual_payout_immutable();
create trigger manual_payout_immutable before update or delete on public.manual_payout_intent_reviews
  for each row execute function public.manual_payout_immutable();

-- A nonfinancial queue entry, usable OFF. No account/recipient/notes input.
-- Advisory -> actor -> wedding matches financial writers; one pending per wedding.
create function public.manual_payout_submit_intent(p_key uuid,p_wedding uuid,p_amount bigint,p_confirmed boolean)
returns uuid language plpgsql security definer set search_path='' as $$
declare w public.weddings; prior public.manual_payout_intents; result uuid;
begin
  perform pg_advisory_xact_lock(71110001);
  perform 1 from public.profiles where id=auth.uid() for share;
  select * into w from public.weddings where id=p_wedding for update;
  if auth.uid() is null or w.client_owner_id is distinct from auth.uid() then raise exception 'Access denied.'; end if;
  if p_confirmed is not true or p_key is null or p_amount is null or p_amount<=0 then
    raise exception 'MANUAL_INTENT_INVALID: Confirm a positive amount and request key.'; end if;
  select * into prior from public.manual_payout_intents where request_key=p_key;
  if found then
    if (prior.wedding_id,prior.requested_by,prior.amount_minor,prior.currency) is distinct from
      (p_wedding,auth.uid(),p_amount,w.currency) then raise exception 'MANUAL_INTENT_CONFLICT: Idempotency input changed.'; end if;
    return prior.id;
  end if;
  if exists(select 1 from public.manual_payout_intents i where i.wedding_id=p_wedding
    and not exists(select 1 from public.manual_payout_intent_reviews r where r.intent_id=i.id)) then
    raise exception 'MANUAL_INTENT_PENDING: A request already awaits staff review.'; end if;
  insert into public.manual_payout_intents(request_key,wedding_id,requested_by,amount_minor,currency)
    values(p_key,p_wedding,auth.uid(),p_amount,w.currency) returning id into result;
  insert into public.audit_events(actor_id,table_name,record_id,action)
    values(auth.uid(),'manual_payout_intents',result::text,'couple_request_intent');
  return result;
end $$;

create function public.manual_payout_intent_history(p_wedding uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
begin
  if auth.uid() is null or not exists(select 1 from public.weddings where id=p_wedding and client_owner_id=auth.uid()) then
    raise exception 'Access denied.'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id',i.id,'amount_minor',i.amount_minor,'currency',i.currency,
    'requested_at',i.requested_at,'status',coalesce(r.decision,'pending'),'payout_id',r.payout_id) order by i.requested_at desc)
    from (select * from public.manual_payout_intents where wedding_id=p_wedding order by requested_at desc limit 100) i
    left join public.manual_payout_intent_reviews r on r.intent_id=i.id),'[]'::jsonb);
end $$;

-- Creation + review link is atomic; the released request RPC remains the only
-- reservation path. Requester/approver independence refers to actual staff actors.
create function public.manual_payout_review_intent(p_id uuid,p_decision text,p_key uuid,p_custody uuid,
  p_recipient uuid,p_fee bigint,p_owner_solo boolean,p_confirmed boolean) returns uuid
language plpgsql security definer set search_path='' as $$
declare i public.manual_payout_intents; review public.manual_payout_intent_reviews; result uuid; r public.manual_payout_requests;
begin
  perform public.require_staff('superadmin'); perform public.manual_payout_intake_authority(false);
  select * into strict i from public.manual_payout_intents where id=p_id;
  if p_confirmed is not true or p_decision is null or p_decision not in ('created','declined') then
    raise exception 'MANUAL_INTENT_INVALID: Confirm create or decline.'; end if;
  if p_decision='declined' and (p_key is not null or p_custody is not null or p_recipient is not null or p_fee is not null or p_owner_solo is distinct from false) then
    raise exception 'MANUAL_INTENT_INVALID: Decline accepts no payout settings.'; end if;
  select * into review from public.manual_payout_intent_reviews where intent_id=p_id;
  if found then
    if review.actor_id<>auth.uid() or review.decision<>p_decision then raise exception 'MANUAL_INTENT_CONFLICT: Already reviewed.'; end if;
    if review.payout_id is not null then
      select * into strict r from public.manual_payout_requests where id=review.payout_id;
      if (r.request_key,r.custody_id,r.recipient_revision,r.fee_minor,r.owner_solo) is distinct from
        (p_key,p_custody,p_recipient,p_fee,p_owner_solo) then raise exception 'MANUAL_INTENT_CONFLICT: Review replay changed.'; end if;
    end if;
    return review.payout_id;
  end if;
  if p_decision='created' then
    if exists(select 1 from public.manual_payout_requests where request_key=p_key) then
      raise exception 'MANUAL_INTENT_CONFLICT: Use a new request key for a new staff payout.'; end if;
    if not exists(select 1 from public.weddings where id=i.wedding_id and client_owner_id=i.requested_by and currency=i.currency) then
      raise exception 'MANUAL_INTENT_CONFLICT: Wedding ownership or currency changed.'; end if;
    result:=public.manual_payout_request(p_key,i.wedding_id,p_custody,p_recipient,i.amount_minor,p_fee,i.currency,p_owner_solo);
    -- Request holds the wedding row through COMMIT; recheck after any row wait.
    if not exists(select 1 from public.weddings where id=i.wedding_id and client_owner_id=i.requested_by and currency=i.currency) then
      raise exception 'MANUAL_INTENT_CONFLICT: Wedding ownership or currency changed.'; end if;
  end if;
  insert into public.manual_payout_intent_reviews(intent_id,decision,payout_id,actor_id) values(p_id,p_decision,result,auth.uid());
  insert into public.audit_events(actor_id,table_name,record_id,action)
    values(auth.uid(),'manual_payout_intents',p_id::text,'staff_intent_'||p_decision);
  return result;
end $$;

create function public.manual_payout_workspace() returns jsonb
language plpgsql stable security definer set search_path='' as $$
begin
  perform public.require_staff('superadmin');
  return jsonb_build_object(
    'intents',coalesce((select jsonb_agg(jsonb_build_object('id',i.id,'wedding_id',i.wedding_id,'amount_minor',i.amount_minor,
      'currency',i.currency,'requested_at',i.requested_at,'status',coalesce(r.decision,'pending'),'payout_id',r.payout_id)
      order by i.requested_at) from public.manual_payout_intents i left join public.manual_payout_intent_reviews r on r.intent_id=i.id
      where r.intent_id is null or i.id in (select intent_id from public.manual_payout_intent_reviews order by reviewed_at desc limit 100)),'[]'::jsonb),
    'evidence',coalesce((select jsonb_agg(jsonb_build_object('id',e.id,'kind',e.kind,'submitted_by',e.submitted_by,
      'submitted_at',e.submitted_at,'checks',coalesce((select jsonb_agg(jsonb_build_object('checked_by',c.checked_by,
        'owner_solo',c.owner_solo,'checked_at',c.checked_at) order by c.checked_at)
        from public.manual_payout_evidence_checks c where c.evidence_id=e.id),'[]'::jsonb)) order by e.submitted_at desc)
      from (select * from public.manual_payout_evidence order by submitted_at desc limit 200) e),'[]'::jsonb),
    'accounts',coalesce((select jsonb_agg(jsonb_build_object('id',a.id,'provider',a.provider,'evidence_id',a.evidence_id)
      order by a.provider,a.id) from public.manual_payout_accounts a),'[]'::jsonb),
    'custody',coalesce((select jsonb_agg(jsonb_build_object('id',c.id,'provider',c.provider,'account_reference',c.account_reference,
      'currency',c.currency,'latest_batch',(select jsonb_build_object('id',b.id,'statement_reference',b.statement_reference,
        'statement_at',b.statement_at,'closing_minor',b.closing_minor,'held_minor',b.held_minor)
        from public.manual_payout_statement_batches b where b.custody_id=c.id order by b.sequence desc limit 1))
      order by c.provider,c.currency) from public.manual_payout_custody c),'[]'::jsonb),
    'recipients',coalesce((select jsonb_agg(jsonb_build_object('id',r.id,'revision',r.revision,'wedding_id',r.wedding_id,
      'provider',r.provider,'currency',r.currency,'evidence_id',r.evidence_id,'created_at',r.created_at) order by r.revision desc)
      from (select * from public.manual_payout_recipients order by revision desc limit 200) r),'[]'::jsonb),
    'unreconciledDebits',coalesce((select jsonb_agg(jsonb_build_object('id',d.id,'custody_id',d.custody_id,'batch_id',d.batch_id,
      'statement_reference',b.statement_reference,'line_reference',d.line_reference,'transaction_reference',d.transaction_reference,
      'actual_minor',d.actual_minor,'actual_fee_minor',d.actual_fee_minor,'currency',d.currency,'booked_at',d.booked_at)
      order by d.booked_at desc) from public.manual_payout_statement_debit_entries d
      join public.manual_payout_statement_batches b on b.id=d.batch_id
      where not exists(select 1 from public.manual_payout_reconciliations x where x.statement_entry_id=d.id)),'[]'::jsonb),
    'requests',coalesce((select jsonb_agg(jsonb_build_object('id',r.id,'custody_id',r.custody_id,'provider',c.provider,
      'automatic',exists(select 1 from public.b2c_request_intents b where b.payout_id=r.id),
      'account_reference',c.account_reference,'requested_by',r.requested_by,
      'claim',(select jsonb_build_object('sender_id',k.sender_id,'claimed_at',k.claimed_at,'channel',k.execution_channel)
        from public.manual_payout_claims k where k.payout_id=r.id),
      'receipt',(select jsonb_build_object('transaction_reference',x.transaction_reference,'actual_minor',x.actual_minor,
        'actual_fee_minor',x.actual_fee_minor,'currency',x.currency,'transferred_at',x.transferred_at)
        from public.manual_payout_receipts x where x.payout_id=r.id),
      'reconciliation',(select jsonb_build_object('reconciled_by',x.reconciled_by,'reconciled_at',x.reconciled_at,
        'statement_reference',x.statement_reference,'line_reference',x.line_reference)
        from public.manual_payout_reconciliations x where x.payout_id=r.id)))
      from (select * from public.manual_payout_requests order by requested_at desc limit 100) r
      join public.manual_payout_custody c on c.id=r.custody_id),'[]'::jsonb));
end $$;
revoke all on function public.manual_payout_workspace() from public,anon,service_role;
grant execute on function public.manual_payout_workspace() to authenticated;
revoke all on function public.manual_payout_submit_intent(uuid,uuid,bigint,boolean),
  public.manual_payout_intent_history(uuid),public.manual_payout_review_intent(uuid,text,uuid,uuid,uuid,bigint,boolean,boolean)
  from public,anon,service_role;
grant execute on function public.manual_payout_submit_intent(uuid,uuid,bigint,boolean),
  public.manual_payout_intent_history(uuid),public.manual_payout_review_intent(uuid,text,uuid,uuid,uuid,bigint,boolean,boolean)
  to authenticated;
