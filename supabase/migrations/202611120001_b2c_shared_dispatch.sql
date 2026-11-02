-- Automated M-Pesa execution over the SAME custody, reservations and execution slot
-- as controlled manual payouts. No flag, credential or production data is enabled.
create table public.b2c_policy (
  singleton boolean primary key default true check(singleton),
  revision bigint not null default 1,
  enabled boolean not null default false,
  require_four_eyes boolean not null default true,
  custody_ids uuid[] not null default '{}',
  recipient_ids uuid[] not null default '{}',
  per_payout_minor bigint check(per_payout_minor > 0),
  daily_minor bigint check(daily_minor > 0),
  payout_fee_minor bigint check(payout_fee_minor >= 0),
  statement_max_age_minutes integer check(statement_max_age_minutes > 0),
  shortcode text check(shortcode ~ '^[0-9]{5,7}$'),
  command_id text check(command_id in ('BusinessPayment','SalaryPayment','PromotionPayment')),
  contract_reference uuid,
  funding_reference uuid,
  updated_by uuid references public.profiles(id),
  updated_at timestamptz not null default now(),
  check(not enabled or (cardinality(custody_ids)>0 and cardinality(recipient_ids)>0
    and per_payout_minor is not null and daily_minor is not null
    and payout_fee_minor is not null and statement_max_age_minutes is not null
    and shortcode is not null and command_id is not null and contract_reference is not null
    and funding_reference is not null and updated_by is not null)),
  check(require_four_eyes or (per_payout_minor is not null and daily_minor is not null
    and cardinality(recipient_ids)>0 and cardinality(custody_ids)>0))
);
insert into public.b2c_policy(singleton) values(true);
create table public.b2c_policy_history (
  revision bigint primary key,
  actor_id uuid not null references public.profiles(id),
  reason text not null check(length(btrim(reason)) between 10 and 240),
  previous jsonb not null,
  current_policy jsonb not null,
  created_at timestamptz not null default now()
);
create table public.b2c_phone_attempts (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.profiles(id),
  wedding_id uuid not null references public.weddings(id),
  created_at timestamptz not null default now()
);
create table public.b2c_request_intents (
  payout_id uuid primary key references public.manual_payout_requests(id),
  created_at timestamptz not null default now()
);
create table public.b2c_human_reviews (
  payout_id uuid not null references public.manual_payout_requests(id),
  policy_revision bigint not null references public.b2c_policy_history(revision),
  reviewer_role text not null check(reviewer_role in ('owner','superadmin')),
  reviewer_id uuid not null references public.profiles(id),
  created_at timestamptz not null default now(),
  primary key(payout_id,policy_revision,reviewer_role),
  unique(payout_id,policy_revision,reviewer_id)
);
create table public.b2c_custody_bindings (
  custody_id uuid primary key references public.manual_payout_custody(id),
  shortcode text not null check(shortcode ~ '^[0-9]{5,7}$'),
  funding_evidence uuid not null references public.manual_payout_evidence(id)
);
create table public.b2c_destinations (
  recipient_id uuid primary key references public.manual_payout_recipients(id),
  user_id uuid not null references public.profiles(id),
  msisdn text not null check(msisdn ~ '^254[17][0-9]{8}$'),
  phone_confirmed_at timestamptz not null,
  bound_at timestamptz not null default now()
);
create table public.b2c_dispatches (
  id uuid primary key default extensions.gen_random_uuid(),
  payout_id uuid not null unique references public.manual_payout_claims(payout_id),
  policy_revision bigint not null references public.b2c_policy_history(revision),
  callback_hash text not null check(callback_hash ~ '^[a-f0-9]{64}$'),
  msisdn text not null check(msisdn ~ '^254[17][0-9]{8}$'),
  shortcode text not null,
  command_id text not null,
  conversation_id text unique,
  originator_id text unique,
  accepted_at timestamptz,
  created_at timestamptz not null default now(),
  check((conversation_id is null)=(originator_id is null))
);
create table public.b2c_callback_events (
  id bigint generated always as identity primary key,
  dispatch_id uuid not null references public.b2c_dispatches(id),
  event_key text not null check(event_key ~ '^[a-f0-9]{64}$'),
  kind text not null check(kind in ('result','timeout','uncertain','accepted','rejected')),
  evidence jsonb not null,
  created_at timestamptz not null default now(),
  unique(dispatch_id,event_key)
);

do $$
declare t text;
begin
  foreach t in array array['b2c_policy','b2c_policy_history','b2c_phone_attempts',
    'b2c_destinations','b2c_dispatches','b2c_callback_events','b2c_request_intents','b2c_custody_bindings','b2c_human_reviews'] loop
    execute format('alter table public.%I enable row level security',t);
    execute format('revoke all on public.%I from public,anon,authenticated,service_role',t);
    if t not in ('b2c_policy','b2c_dispatches') then
      execute format('create trigger b2c_immutable before update or delete on public.%I
        for each row execute function public.manual_payout_immutable()',t);
    end if;
  end loop;
end $$;
create function public.b2c_guard_dispatch() returns trigger language plpgsql set search_path='' as $$
begin
  if tg_op='DELETE' then raise exception 'B2C dispatch identity is immutable.'; end if;
  if (to_jsonb(new)-array['conversation_id','originator_id','accepted_at']) is distinct from
      (to_jsonb(old)-array['conversation_id','originator_id','accepted_at'])
    or old.conversation_id is not null and to_jsonb(new) is distinct from to_jsonb(old) then
    raise exception 'B2C dispatch identity and provider binding are immutable.';
  end if;
  return new;
end $$;
create trigger b2c_guard_dispatch before update or delete on public.b2c_dispatches
  for each row execute function public.b2c_guard_dispatch();

create function public.b2c_audit(p_wedding uuid,p_id text,p_action text,p_actor uuid) returns void
language plpgsql security definer set search_path='' as $$
begin
  insert into public.audit_events(wedding_id,actor_id,table_name,record_id,action)
    values(p_wedding,p_actor,'b2c_dispatches',p_id,p_action);
end $$;
create function public.owner_get_b2c_policy() returns jsonb
language plpgsql stable security definer set search_path='' as $$
begin perform public.require_staff('owner');
  return (select to_jsonb(p) from public.b2c_policy p where singleton);
end $$;
create function public.owner_update_b2c_policy(p_revision bigint,p_changes jsonb,p_reason text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare old public.b2c_policy; n public.b2c_policy; key text;
begin
  perform public.require_staff('owner');
  perform pg_advisory_xact_lock(71110001);
  select * into old from public.b2c_policy where singleton for update;
  if old.revision is distinct from p_revision or p_changes is null
    or jsonb_typeof(p_changes)<>'object' or length(btrim(p_reason)) not between 10 and 240
    or p_reason is null then raise exception 'B2C: Current policy revision and audit reason required.'; end if;
  for key in select jsonb_object_keys(p_changes) loop
    if key not in ('enabled','require_four_eyes','custody_ids','recipient_ids','per_payout_minor','daily_minor',
      'payout_fee_minor','statement_max_age_minutes','shortcode','command_id','contract_reference','funding_reference')
      then raise exception 'B2C: Unsupported policy field.'; end if;
  end loop;
  n:=jsonb_populate_record(old,p_changes);
  update public.b2c_policy set revision=old.revision+1,enabled=n.enabled,require_four_eyes=n.require_four_eyes,
    custody_ids=n.custody_ids,recipient_ids=n.recipient_ids,per_payout_minor=n.per_payout_minor,
    daily_minor=n.daily_minor,payout_fee_minor=n.payout_fee_minor,statement_max_age_minutes=n.statement_max_age_minutes,
    shortcode=n.shortcode,command_id=n.command_id,contract_reference=n.contract_reference,funding_reference=n.funding_reference,
    updated_by=auth.uid(),updated_at=now() where singleton returning * into n;
  insert into public.b2c_policy_history(revision,actor_id,reason,previous,current_policy)
    values(n.revision,auth.uid(),p_reason,to_jsonb(old),to_jsonb(n));
  perform public.b2c_audit(null,n.revision::text,'policy_changed',auth.uid());
  return to_jsonb(n);
end $$;

-- Phone control uses Supabase Auth's verified phone, never a browser assertion.
-- Identity/name/consent remains separately checked recipient evidence, not OTP.
create function public.b2c_phone_start(p_wedding uuid,p_msisdn text) returns boolean
language plpgsql security definer set search_path='' as $$
begin
  perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text,71112001));
  if auth.uid() is null or not exists(select 1 from public.weddings w join public.wedding_kyc k on k.wedding_id=w.id
    where w.id=p_wedding and w.client_owner_id=auth.uid() and public.kyc_is_complete(w.id)
    and p_msisdn ~ '^254[17][0-9]{8}$' and p_msisdn in (k.partner1_phone,k.partner2_phone)) then
    raise exception 'B2C: Authenticated couple account and exact submitted partner phone required.';
  end if;
  if exists(select 1 from public.b2c_phone_attempts where user_id=auth.uid() and created_at>now()-interval '1 minute')
    or (select count(*) from public.b2c_phone_attempts where user_id=auth.uid()
      and created_at>now()-interval '1 day')>=5 then raise exception 'B2C: Phone verification rate limit reached.'; end if;
  insert into public.b2c_phone_attempts(user_id,wedding_id) values(auth.uid(),p_wedding);
  return true;
end $$;
create function public.b2c_bind_destination(p_recipient uuid) returns boolean
language plpgsql security definer set search_path='' as $$
declare r public.manual_payout_recipients; u auth.users; k public.wedding_kyc;
begin
  select * into strict r from public.manual_payout_recipients where id=p_recipient;
  perform 1 from public.weddings where id=r.wedding_id and client_owner_id=auth.uid() for update;
  if not found or r.provider<>'daraja' or r.currency<>'KES' then raise exception 'B2C: Couple account required.'; end if;
  select * into strict u from auth.users where id=auth.uid();
  select * into strict k from public.wedding_kyc where wedding_id=r.wedding_id for share;
  perform public.manual_payout_evidence_require(r.evidence_id,'recipient');
  if u.phone_confirmed_at is null or u.phone is null or u.phone !~ '^254[17][0-9]{8}$'
    or u.phone not in (k.partner1_phone,k.partner2_phone)
    or r.kyc_snapshot_hash<>encode(extensions.digest(to_jsonb(k)::text,'sha256'),'hex') then
    raise exception 'B2C: Verified current phone control and current independently reviewed identity/name evidence required.';
  end if;
  insert into public.b2c_destinations(recipient_id,user_id,msisdn,phone_confirmed_at)
    values(r.id,u.id,u.phone,u.phone_confirmed_at);
  perform public.b2c_audit(r.wedding_id,r.id::text,'phone_control_bound_not_identity_verification',auth.uid());
  return true;
end $$;
create function public.b2c_destination_require(p_recipient uuid) returns text
language plpgsql security definer set search_path='' as $$
declare phone text;
begin
  select d.msisdn into phone from public.b2c_destinations d join auth.users u on u.id=d.user_id
    join public.manual_payout_recipients r on r.id=d.recipient_id
    join public.weddings w on w.id=r.wedding_id
    join public.wedding_kyc k on k.wedding_id=w.id
    where d.recipient_id=p_recipient and w.client_owner_id=u.id and u.phone=d.msisdn
    and u.phone_confirmed_at=d.phone_confirmed_at and d.msisdn in (k.partner1_phone,k.partner2_phone)
    and r.kyc_snapshot_hash=encode(extensions.digest(to_jsonb(k)::text,'sha256'),'hex');
  if phone is null then raise exception 'B2C: Destination control changed or is unverified.'; end if;
  return phone;
end $$;

create function public.b2c_require_service() returns void
language plpgsql security definer set search_path='' as $$
begin
  if auth.role() is distinct from 'service_role' then raise exception 'B2C: Service role required.'; end if;
end $$;
create function public.b2c_policy_require(p_custody uuid,p_recipient uuid,p_amount bigint,p_fee bigint) returns public.b2c_policy
language plpgsql security definer set search_path='' as $$
declare p public.b2c_policy; a public.manual_payout_custody;
begin
  select * into strict p from public.b2c_policy where singleton;
  if not p.enabled or not exists(select 1 from public.profiles where id=p.updated_by and platform_role='owner')
    or not coalesce(p_custody=any(p.custody_ids),false) or not coalesce(p_recipient=any(p.recipient_ids),false)
    or p_amount is null or p_amount<=0 or p_amount%100<>0
    or p_amount>p.per_payout_minor or p_fee is distinct from p.payout_fee_minor then
    raise exception 'B2C: Dispatch OFF or outside explicit Owner limits, recipients, custody or fee policy.';
  end if;
  select * into strict a from public.manual_payout_custody where id=p_custody;
  if a.provider<>'daraja' or a.currency<>'KES' or a.statement_at>now()
    or a.statement_at<now()-make_interval(mins=>p.statement_max_age_minutes) then
    raise exception 'B2C_FUNDING_NEEDED: Current documented disbursable collected custody is missing or stale.';
  end if;
  perform public.manual_payout_evidence_require(a.evidence_id,'custody');
  if not exists(select 1 from public.b2c_custody_bindings where custody_id=a.id and shortcode=p.shortcode
    and funding_evidence=p.funding_reference) then
    raise exception 'B2C_FUNDING_NEEDED: Collected custody is not evidenced as disbursable by this shortcode.';
  end if;
  perform public.manual_payout_evidence_require(p.funding_reference,'policy');
  perform public.manual_payout_evidence_require(p.contract_reference,'policy');
  perform public.manual_payout_evidence_require((select evidence_id from public.manual_payout_recipients where id=p_recipient),'recipient');
  perform public.b2c_destination_require(p_recipient);
  return p;
end $$;

create function public.b2c_request(p_key uuid,p_wedding uuid,p_custody uuid,p_recipient uuid,p_amount bigint) returns uuid
language plpgsql security definer set search_path='' as $$
declare p public.b2c_policy; r public.manual_payout_requests; result uuid;
begin
  perform pg_advisory_xact_lock(71110001);
  if not exists(select 1 from public.weddings where id=p_wedding and client_owner_id=auth.uid()) then
    raise exception 'B2C: Couple account required.'; end if;
  select * into strict p from public.b2c_policy where singleton;
  select * into r from public.manual_payout_requests where request_key=p_key;
  if found then
    if (r.wedding_id,r.custody_id,r.recipient_revision,r.amount_minor,r.requested_by)
      is distinct from (p_wedding,p_custody,p_recipient,p_amount,auth.uid()) then raise exception 'B2C: Idempotency conflict.'; end if;
    return r.id;
  end if;
  perform public.manual_payout_lock(p_custody,p_wedding);
  p:=public.b2c_policy_require(p_custody,p_recipient,p_amount,p.payout_fee_minor);
  perform public.manual_payout_eligible(p_wedding,p_custody,p_recipient,'KES',
    (p_amount::numeric+p.payout_fee_minor)::bigint);
  insert into public.manual_payout_requests(request_key,wedding_id,custody_id,recipient_revision,amount_minor,fee_minor,currency,requested_by)
    values(p_key,p_wedding,p_custody,p_recipient,p_amount,p.payout_fee_minor,'KES',auth.uid()) returning id into result;
  insert into public.manual_payout_events(payout_id,state,actor_id) values(result,'requested',auth.uid());
  insert into public.b2c_request_intents(payout_id) values(result);
  perform public.b2c_audit(p_wedding,result::text,'requested',auth.uid());
  return result;
end $$;
create function public.staff_approve_b2c(p_id uuid) returns boolean
language plpgsql security definer set search_path='' as $$
declare r public.manual_payout_requests; p public.b2c_policy;
begin
  perform public.require_staff('superadmin');
  perform pg_advisory_xact_lock(71110001);
  select * into strict r from public.manual_payout_requests where id=p_id;
  perform public.manual_payout_lock(r.custody_id,r.wedding_id);
  if auth.uid()=r.requested_by or public.manual_payout_state(p_id) not in ('requested','approved')
    or exists(select 1 from public.manual_payout_claims where payout_id=p_id) then
    raise exception 'B2C: Different reviewer and unclaimed requested payout required.';
  end if;
  p:=public.b2c_policy_require(r.custody_id,r.recipient_revision,r.amount_minor,r.fee_minor);
  perform public.manual_payout_eligible(r.wedding_id,r.custody_id,r.recipient_revision,r.currency,
    (r.amount_minor::numeric+r.fee_minor)::bigint,r.id);
  insert into public.b2c_human_reviews(payout_id,policy_revision,reviewer_role,reviewer_id)
    values(r.id,p.revision,public.current_platform_role()::text,auth.uid());
  if (select count(*) from public.b2c_human_reviews v join public.profiles q on q.id=v.reviewer_id
    where v.payout_id=r.id and v.policy_revision=p.revision and q.platform_role::text=v.reviewer_role)=2 then
    insert into public.manual_payout_events(payout_id,state,actor_id) values(r.id,'approved',auth.uid()) on conflict do nothing;
  end if;
  perform public.b2c_audit(r.wedding_id,r.id::text,'human_approved',auth.uid());
  return true;
end $$;

create function public.b2c_claim(p_id uuid,p_key uuid,p_callback_hash text,p_shortcode text,p_command text,p_auto boolean)
returns jsonb language plpgsql security definer set search_path='' as $$
declare r public.manual_payout_requests; p public.b2c_policy; d public.b2c_dispatches; phone text; actor uuid;
begin
  perform public.b2c_require_service();
  perform pg_advisory_xact_lock(71110001);
  select * into strict r from public.manual_payout_requests where id=p_id;
  perform public.manual_payout_lock(r.custody_id,r.wedding_id);
  perform 1 from public.manual_payout_requests where id=p_id for update;
  if not exists(select 1 from public.b2c_request_intents where payout_id=p_id) then
    raise exception 'B2C: Request did not select automated M-Pesa execution.';
  end if;
  if exists(select 1 from public.manual_payout_claims where payout_id=p_id) then
    return jsonb_build_object('claimed',false,'state',public.manual_payout_state(p_id));
  end if;
  p:=public.b2c_policy_require(r.custody_id,r.recipient_revision,r.amount_minor,r.fee_minor);
  if p.shortcode is distinct from p_shortcode or p.command_id is distinct from p_command or p_key is null
    or p_callback_hash is null or p_callback_hash !~ '^[a-f0-9]{64}$' then raise exception 'B2C: Deployment/policy binding mismatch.'; end if;
  if public.manual_payout_state(p_id)='requested' and not p.require_four_eyes and p_auto then
    insert into public.manual_payout_events(payout_id,state,actor_id) values(r.id,'approved',p.updated_by);
    perform public.b2c_audit(r.wedding_id,r.id::text,'auto_approved_policy_'||p.revision,p.updated_by);
  end if;
  if public.manual_payout_state(p_id)<>'approved' then raise exception 'B2C: Four-eyes approval required.'; end if;
  if p.require_four_eyes and (select count(*) from public.b2c_human_reviews v join public.profiles q on q.id=v.reviewer_id
    where v.payout_id=r.id and v.policy_revision=p.revision and q.platform_role::text=v.reviewer_role)<>2 then
    raise exception 'B2C: Different current Owner and SuperAdmin reviews of the exact policy revision required.';
  end if;
  phone:=public.b2c_destination_require(r.recipient_revision);
  perform public.manual_payout_eligible(r.wedding_id,r.custody_id,r.recipient_revision,r.currency,
    (r.amount_minor::numeric+r.fee_minor)::bigint,r.id);
  if (select coalesce(sum(q.amount_minor::numeric+q.fee_minor),0) from public.manual_payout_claims c
    join public.manual_payout_requests q on q.id=c.payout_id
    where c.execution_channel='automatic_b2c' and c.claimed_at>=date_trunc('day',now() at time zone 'UTC') at time zone 'UTC')
    +r.amount_minor+r.fee_minor>p.daily_minor then raise exception 'B2C: Daily dispatch limit exceeded.'; end if;
  insert into public.manual_payout_claims(payout_id,execution_channel,claim_key,sender_id)
    values(r.id,'automatic_b2c',p_key,p.updated_by);
  insert into public.manual_payout_events(payout_id,state,actor_id) values(r.id,'executing',p.updated_by);
  insert into public.b2c_dispatches(payout_id,policy_revision,callback_hash,msisdn,shortcode,command_id)
    values(r.id,p.revision,p_callback_hash,phone,p_shortcode,p_command) returning * into d;
  perform public.b2c_audit(r.wedding_id,r.id::text,'durable_execution_claim',p.updated_by);
  return (to_jsonb(d)-'callback_hash')||jsonb_build_object('claimed',true,'amount_minor',r.amount_minor,'fee_minor',r.fee_minor);
end $$;

create function public.b2c_callback_context(p_id uuid,p_hash text) returns jsonb
language plpgsql stable security definer set search_path='' as $$
begin
  perform public.b2c_require_service();
  return (select to_jsonb(d)-'callback_hash' from public.b2c_dispatches d where id=p_id and callback_hash=p_hash);
end $$;
create function public.b2c_event(p_id uuid,p_hash text,p_kind text,p_key text,p_evidence jsonb) returns text
language plpgsql security definer set search_path='' as $$
declare d public.b2c_dispatches; r public.manual_payout_requests; actor uuid; state text; inserted integer;
begin
  perform public.b2c_require_service();
  perform pg_advisory_xact_lock(71110001);
  select * into strict d from public.b2c_dispatches where id=p_id and callback_hash=p_hash for update;
  select * into strict r from public.manual_payout_requests where id=d.payout_id;
  select sender_id into strict actor from public.manual_payout_claims where payout_id=r.id and execution_channel='automatic_b2c';
  if p_kind not in ('result','timeout','uncertain','accepted','rejected') or p_kind is null
    or p_evidence is null or jsonb_typeof(p_evidence)<>'object' then raise exception 'B2C: Invalid event.'; end if;
  if p_kind='accepted' then
    if coalesce(p_evidence->>'conversation_id','') !~ '^[A-Za-z0-9_-]{1,160}$'
      or coalesce(p_evidence->>'originator_id','') !~ '^[A-Za-z0-9_-]{1,160}$'
      or (d.conversation_id is not null and (d.conversation_id is distinct from p_evidence->>'conversation_id'
        or d.originator_id is distinct from p_evidence->>'originator_id')) then raise exception 'B2C: Invalid provider binding.'; end if;
    if d.conversation_id is null then
      update public.b2c_dispatches set conversation_id=p_evidence->>'conversation_id',
        originator_id=p_evidence->>'originator_id',accepted_at=now() where id=d.id;
    end if;
  elsif p_kind='result' and (d.conversation_id is null
      or d.conversation_id is distinct from p_evidence->>'conversation_id'
      or d.originator_id is distinct from p_evidence->>'originator_id') then
    raise exception 'B2C: Unbound or uncorrelated result.';
  end if;
  insert into public.b2c_callback_events(dispatch_id,event_key,kind,evidence)
    values(d.id,p_key,p_kind,p_evidence) on conflict do nothing;
  get diagnostics inserted=row_count;
  state:=public.manual_payout_state(r.id);
  if inserted=0 then return state; end if;
  -- Neither acceptance, claimed success, failure, nor timeout releases money.
  if p_kind in ('result','timeout','uncertain') and state='executing' then
    insert into public.manual_payout_events(payout_id,state,actor_id) values(r.id,'uncertain',actor);
    state:='uncertain';
  end if;
  perform public.b2c_audit(r.wedding_id,r.id::text,p_kind||'_holds_retained',actor);
  return state;
end $$;
create function public.b2c_mark_stale() returns integer
language plpgsql security definer set search_path='' as $$
declare d record; n integer:=0;
begin
  perform public.b2c_require_service();
  perform pg_advisory_xact_lock(71110001);
  for d in select b.*,c.sender_id from public.b2c_dispatches b join public.manual_payout_claims c on c.payout_id=b.payout_id
    where b.created_at<now()-interval '30 minutes' and public.manual_payout_state(b.payout_id)='executing' loop
    insert into public.manual_payout_events(payout_id,state,actor_id) values(d.payout_id,'uncertain',d.sender_id);
    perform public.b2c_audit(null,d.payout_id::text,'stale_uncertain_no_retry',d.sender_id);
    n:=n+1;
  end loop;
  return n;
end $$;
create function public.b2c_candidates() returns jsonb
language plpgsql stable security definer set search_path='' as $$
begin
  perform public.b2c_require_service();
  return coalesce((select jsonb_agg(r.id) from (select q.id from public.manual_payout_requests q
    join public.b2c_request_intents i on i.payout_id=q.id join public.b2c_policy p on p.singleton
    where q.currency='KES' and public.manual_payout_state(q.id) in ('requested','approved')
    and p.enabled and (not p.require_four_eyes or public.manual_payout_state(q.id)='approved')
    and not exists(select 1 from public.manual_payout_claims c where c.payout_id=q.id)
    order by q.requested_at limit 10) r),'[]'::jsonb);
end $$;
create function public.b2c_status() returns jsonb
language plpgsql stable security definer set search_path='' as $$
begin
  perform public.require_staff('superadmin');
  return coalesce((select jsonb_agg((to_jsonb(d)-array['callback_hash','msisdn'])||
    jsonb_build_object('state',public.manual_payout_state(d.payout_id)))
    from (select * from public.b2c_dispatches order by created_at desc limit 100) d),'[]'::jsonb);
end $$;
create function public.staff_b2c_controls() returns jsonb
language plpgsql stable security definer set search_path='' as $$
begin
  perform public.require_staff('superadmin');
  return (select jsonb_build_object('enabled',enabled,'require_four_eyes',require_four_eyes,'revision',revision)
    from public.b2c_policy where singleton);
end $$;
create function public.b2c_reconcile(p_id uuid,p_evidence uuid,p_reference text,p_actual bigint,p_fee bigint,
  p_msisdn text,p_at timestamptz) returns text
language plpgsql security definer set search_path='' as $$
declare d public.b2c_dispatches; r public.manual_payout_requests; a public.manual_payout_custody; c public.manual_payout_claims;
begin
  perform public.require_staff('superadmin');
  perform pg_advisory_xact_lock(71110001);
  select * into strict d from public.b2c_dispatches where id=p_id;
  select * into strict r from public.manual_payout_requests where id=d.payout_id;
  perform public.manual_payout_lock(r.custody_id,r.wedding_id);
  select * into strict c from public.manual_payout_claims where payout_id=r.id and execution_channel='automatic_b2c';
  if auth.uid() in (r.requested_by,c.sender_id) then raise exception 'B2C: Independent final reconciler required.'; end if;
  perform public.manual_payout_evidence_require(p_evidence,'receipt');
  if public.manual_payout_state(r.id) not in ('executing','uncertain')
    or p_actual is distinct from r.amount_minor or p_fee is distinct from r.fee_minor
    or p_msisdn is distinct from d.msisdn or p_at is null or p_at<c.claimed_at or p_at>now()
    or p_reference is null or upper(btrim(p_reference)) !~ '^[A-Z0-9][A-Z0-9._:-]{0,119}$' then
    raise exception 'B2C: Exact independently checked statement receipt/amount/fee/destination required; retain holds.';
  end if;
  select * into strict a from public.manual_payout_custody where id=r.custody_id;
  insert into public.manual_payout_receipts(payout_id,provider,account_reference,transaction_reference,actual_minor,
    actual_fee_minor,currency,transferred_at,evidence_id)
    values(r.id,a.provider,a.account_reference,upper(btrim(p_reference)),p_actual,p_fee,r.currency,p_at,p_evidence);
  insert into public.manual_payout_events(payout_id,state,actor_id,evidence_id)
    values(r.id,'reported',auth.uid(),p_evidence),(r.id,'paid',auth.uid(),p_evidence);
  perform public.b2c_audit(r.wedding_id,r.id::text,'independent_statement_paid',auth.uid());
  return 'paid';
end $$;

-- Non-transfer onboarding uses the shared evidence/custody ledger even while both
-- execution channels are OFF. No account balance is inferred from collection.
create function public.b2c_intake(p_action text,p_data jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare result uuid; e public.manual_payout_evidence; c public.contributions;
  a public.manual_payout_custody; k public.wedding_kyc; wid uuid;
begin
  perform public.require_staff('superadmin');
  perform pg_advisory_xact_lock(71110001);
  if p_data is null or jsonb_typeof(p_data)<>'object' then raise exception 'B2C: Structured evidence fields required.'; end if;
  if p_action='evidence' then
    if p_data->>'kind'='policy' then perform public.require_staff('owner'); end if;
    insert into public.manual_payout_evidence(kind,external_reference,sha256,submitted_by)
      values(p_data->>'kind',(p_data->>'reference')::uuid,p_data->>'sha256',auth.uid()) returning id into result;
  elsif p_action='check' then
    select * into strict e from public.manual_payout_evidence where id=(p_data->>'evidence')::uuid;
    if e.submitted_by=auth.uid() then raise exception 'B2C: A different leader must check identity, custody and statement evidence.'; end if;
    insert into public.manual_payout_evidence_checks(evidence_id,checked_by) values(e.id,auth.uid());
    result:=e.id;
  elsif p_action='recipient' then
    wid:=(p_data->>'wedding')::uuid;
    perform public.manual_payout_evidence_require((p_data->>'evidence')::uuid,'recipient');
    perform 1 from public.weddings where id=wid and client_owner_id<>auth.uid() for update;
    if not found or not public.kyc_is_complete(wid) then raise exception 'B2C: Independent current couple identity/name/consent review required.'; end if;
    select * into strict k from public.wedding_kyc where wedding_id=wid for share;
    insert into public.manual_payout_recipients(wedding_id,evidence_id,provider,currency,kyc_snapshot_hash,recorded_by)
      values(wid,(p_data->>'evidence')::uuid,'daraja','KES',
        encode(extensions.digest(to_jsonb(k)::text,'sha256'),'hex'),auth.uid()) returning id into result;
  elsif p_action='custody' then
    perform public.require_staff('owner');
    perform public.manual_payout_evidence_require((p_data->>'evidence')::uuid,'custody');
    perform public.manual_payout_evidence_require((p_data->>'fundingEvidence')::uuid,'policy');
    if p_data->>'disbursableCollectedFunds' is distinct from 'true'
      or (p_data->>'statementAt')::timestamptz is null or (p_data->>'statementAt')::timestamptz>now()
      or exists(select 1 from public.payout_records where status<>'cancelled')
      or exists(select 1 from public.expenses) or exists(select 1 from public.payment_adjustments)
      or exists(select 1 from public.financial_adjustment_ledger) then
      raise exception 'B2C_FUNDING_NEEDED: Verified disbursable collected-funds statement and unmapped-commitment resolution required.';
    end if;
    insert into public.manual_payout_custody(provider,account_reference,currency,available_minor,statement_at,evidence_id,recorded_by)
      values('daraja',(p_data->>'account')::uuid,'KES',(p_data->>'availableMinor')::bigint,
        (p_data->>'statementAt')::timestamptz,(p_data->>'evidence')::uuid,auth.uid()) returning id into result;
    insert into public.b2c_custody_bindings(custody_id,shortcode,funding_evidence)
      values(result,p_data->>'shortcode',(p_data->>'fundingEvidence')::uuid);
  elsif p_action='settlement' then
    perform public.require_staff('owner');
    perform public.manual_payout_evidence_require((p_data->>'evidence')::uuid,'settlement');
    select * into strict a from public.manual_payout_custody where id=(p_data->>'custody')::uuid for update;
    select * into strict c from public.contributions where id=(p_data->>'contribution')::uuid for update;
    if a.provider<>'daraja' or a.currency<>'KES' or c.payment_environment<>'live'
      or c.settlement_route<>'platform_wallet' or not c.verified_provider_payment
      or c.payment_status<>'paid' or c.provider_fee_pending or c.provider_fee_minor is null
      or c.provider_name is distinct from a.provider or c.currency<>a.currency
      or c.paid_at is null or c.paid_at>a.statement_at
      or (p_data->>'settledMinor')::bigint is distinct from c.net_paid_minor-c.provider_fee_minor
      or (p_data->>'settledMinor')::bigint<=0 then
      raise exception 'B2C: Only verified live fee-known Daraja receipts allocated from actual disbursable collected custody qualify.';
    end if;
    if (p_data->>'settledMinor')::numeric+coalesce((select sum(settled_minor)
      from public.manual_payout_settlements where custody_id=a.id),0)>a.available_minor then
      raise exception 'B2C: Custody statement would be overallocated.';
    end if;
    insert into public.manual_payout_settlements(contribution_id,custody_id,statement_line_reference,settled_minor,evidence_id,recorded_by)
      values(c.id,a.id,(p_data->>'line')::uuid,(p_data->>'settledMinor')::bigint,(p_data->>'evidence')::uuid,auth.uid());
    result:=c.id;
  else raise exception 'B2C: Unsupported evidence intake action.'; end if;
  perform public.b2c_audit(wid,result::text,'intake_'||p_action,auth.uid());
  return jsonb_build_object('id',result,'recorded',true);
end $$;
create function public.b2c_recipient_context(p_wedding uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
begin
  if auth.uid() is null or not exists(select 1 from public.weddings where id=p_wedding and client_owner_id=auth.uid()) then
    raise exception 'B2C: Couple account required.';
  end if;
  return jsonb_build_object('recipients',coalesce((select jsonb_agg(jsonb_build_object('id',r.id,'revision',r.revision,
    'controlBound',exists(select 1 from public.b2c_destinations d where d.recipient_id=r.id and d.user_id=auth.uid())))
    from public.manual_payout_recipients r where r.wedding_id=p_wedding and r.provider='daraja' and r.currency='KES'),'[]'::jsonb),
    'custodyIds',(select to_jsonb(custody_ids) from public.b2c_policy where singleton),
    'requests',coalesce((select jsonb_agg(jsonb_build_object('id',r.id,'amountMinor',r.amount_minor,
      'state',public.manual_payout_state(r.id))) from public.manual_payout_requests r
      where r.wedding_id=p_wedding),'[]'::jsonb));
end $$;

do $$
declare f record;
begin
  for f in select p.oid::regprocedure as signature,p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and (p.proname like 'b2c_%' or p.proname in ('owner_get_b2c_policy','owner_update_b2c_policy','staff_approve_b2c','staff_b2c_controls')) loop
    execute format('revoke all on function %s from public,anon,authenticated,service_role',f.signature);
    if f.proname in ('owner_get_b2c_policy','owner_update_b2c_policy','staff_approve_b2c','staff_b2c_controls',
      'b2c_phone_start','b2c_bind_destination','b2c_request','b2c_status','b2c_reconcile','b2c_intake','b2c_recipient_context') then
      execute format('grant execute on function %s to authenticated',f.signature);
    elsif f.proname in ('b2c_claim','b2c_callback_context','b2c_event','b2c_mark_stale','b2c_candidates') then
      execute format('grant execute on function %s to service_role',f.signature);
    end if;
  end loop;
end $$;
