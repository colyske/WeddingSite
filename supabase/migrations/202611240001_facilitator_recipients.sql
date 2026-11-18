-- Facilitator-provided recipient snapshots and review only. This does not
-- establish provider identity, create payout balances, or authorize transfers.
create table public.facilitator_recipient_versions (
  revision_id uuid primary key default extensions.gen_random_uuid(),
  sequence bigint generated always as identity unique,
  user_id uuid not null references public.profiles(id) on delete restrict,
  request_key uuid not null,
  full_name text not null check (length(btrim(full_name)) between 2 and 120),
  phone text not null check (phone ~ '^254[17][0-9]{8}$'),
  ownership_attested boolean not null check (ownership_attested),
  consent_version text not null check (consent_version = 'facilitator-mpesa-recipient-v1'),
  consented_at timestamptz not null default clock_timestamp(),
  created_at timestamptz not null default clock_timestamp(),
  unique(user_id, request_key)
);

-- Only opaque references and digests are retained here, never uploaded documents.
create table public.facilitator_recipient_evidence (
  id uuid primary key default extensions.gen_random_uuid(),
  revision_id uuid not null unique references public.facilitator_recipient_versions(revision_id) on delete restrict,
  external_reference uuid not null unique,
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  submitted_by uuid not null references public.profiles(id) on delete restrict,
  submitted_at timestamptz not null default clock_timestamp()
);

create table public.facilitator_recipient_checks (
  revision_id uuid primary key references public.facilitator_recipient_versions(revision_id) on delete restrict,
  evidence_id uuid not null unique references public.facilitator_recipient_evidence(id) on delete restrict,
  checked_by uuid not null references public.profiles(id) on delete restrict,
  owner_solo boolean not null,
  checked_at timestamptz not null default clock_timestamp()
);

create table public.facilitator_recipient_audit (
  id bigint generated always as identity primary key,
  actor_id uuid not null references public.profiles(id) on delete restrict,
  subject_user_id uuid not null references public.profiles(id) on delete restrict,
  revision_id uuid not null references public.facilitator_recipient_versions(revision_id) on delete restrict,
  action text not null check (action in
    ('registered','self_reveal','owner_reveal','evidence_recorded','verified','payout_snapshot')),
  created_at timestamptz not null default clock_timestamp()
);

create function public.facilitator_recipient_immutable() returns trigger
language plpgsql set search_path='' as $$
begin
  raise exception 'Facilitator recipient history is immutable.';
end $$;
create trigger facilitator_recipient_versions_immutable before update or delete
  on public.facilitator_recipient_versions for each row execute function public.facilitator_recipient_immutable();
create trigger facilitator_recipient_evidence_immutable before update or delete
  on public.facilitator_recipient_evidence for each row execute function public.facilitator_recipient_immutable();
create trigger facilitator_recipient_checks_immutable before update or delete
  on public.facilitator_recipient_checks for each row execute function public.facilitator_recipient_immutable();
create trigger facilitator_recipient_audit_immutable before update or delete
  on public.facilitator_recipient_audit for each row execute function public.facilitator_recipient_immutable();

alter table public.facilitator_recipient_versions enable row level security;
alter table public.facilitator_recipient_evidence enable row level security;
alter table public.facilitator_recipient_checks enable row level security;
alter table public.facilitator_recipient_audit enable row level security;
revoke all on public.facilitator_recipient_versions, public.facilitator_recipient_evidence,
  public.facilitator_recipient_checks, public.facilitator_recipient_audit
  from public, anon, authenticated, service_role;

create function public.facilitator_recipient_submit(
  p_request_key uuid, p_full_name text, p_phone text, p_consent boolean, p_consent_version text
) returns jsonb language plpgsql security definer set search_path='' set row_security=off as $$
declare prior public.facilitator_recipient_versions; added public.facilitator_recipient_versions;
begin
  if auth.uid() is null then raise exception 'FACILITATOR_RECIPIENT_AUTH: Sign in required.'; end if;
  if p_request_key is null or p_full_name is null or length(btrim(p_full_name)) not between 2 and 120
    or p_phone is null or p_phone !~ '^254[17][0-9]{8}$'
    or p_consent is distinct from true
    or p_consent_version is distinct from 'facilitator-mpesa-recipient-v1' then
    raise exception 'FACILITATOR_RECIPIENT_INPUT: Provide your own name and valid M-Pesa phone and explicitly consent.';
  end if;
  perform 1 from public.profiles where id=auth.uid() for update;
  if not exists(select 1 from public.referral_accounts where user_id=auth.uid()) then
    raise exception 'FACILITATOR_RECIPIENT_CONFLICT: Register for facilitator referrals before registering recipient details.';
  end if;
  select * into prior from public.facilitator_recipient_versions
    where user_id=auth.uid() and request_key=p_request_key;
  if found then
    if (prior.full_name,prior.phone,prior.ownership_attested,prior.consent_version)
      is distinct from (btrim(p_full_name),p_phone,true,p_consent_version) then
      raise exception 'FACILITATOR_RECIPIENT_CONFLICT: This request key was already used for different recipient details.';
    end if;
    return jsonb_build_object('revision',prior.revision_id,'status',
      case when prior.revision_id is distinct from
        (select latest.revision_id from public.facilitator_recipient_versions latest
          where latest.user_id=auth.uid() order by latest.sequence desc limit 1) then 'superseded'
        when public.facilitator_payout_recipient_ready(auth.uid(),prior.revision_id) then 'verified' else 'pending' end,
      'idempotent',true);
  end if;
  insert into public.facilitator_recipient_versions(user_id,request_key,full_name,phone,ownership_attested,consent_version)
    values(auth.uid(),p_request_key,btrim(p_full_name),p_phone,true,p_consent_version) returning * into added;
  insert into public.facilitator_recipient_audit(actor_id,subject_user_id,revision_id,action)
    values(auth.uid(),auth.uid(),added.revision_id,'registered');
  return jsonb_build_object('revision',added.revision_id,'status','pending','idempotent',false);
end $$;

-- This private read reveals the user's own stored details and always records that reveal.
create function public.facilitator_recipient_mine() returns jsonb
language plpgsql security definer set search_path='' set row_security=off as $$
declare v public.facilitator_recipient_versions; e public.facilitator_recipient_evidence;
begin
  if auth.uid() is null then raise exception 'FACILITATOR_RECIPIENT_AUTH: Sign in required.'; end if;
  select * into v from public.facilitator_recipient_versions
    where user_id=auth.uid() order by sequence desc limit 1;
  if not found then return jsonb_build_object('recipient',null); end if;
  select * into e from public.facilitator_recipient_evidence where revision_id=v.revision_id;
  insert into public.facilitator_recipient_audit(actor_id,subject_user_id,revision_id,action)
    values(auth.uid(),auth.uid(),v.revision_id,'self_reveal');
  return jsonb_build_object('recipient',jsonb_build_object(
    'revision',v.revision_id,'full_name',v.full_name,'phone',v.phone,'consent_version',v.consent_version,
    'consented_at',v.consented_at,'created_at',v.created_at,
    'status',case when public.facilitator_payout_recipient_ready(v.user_id,v.revision_id) then 'verified'
      when e.id is null then 'evidence_required' else 'review_pending' end,
    'evidence_submitted',e.id is not null));
end $$;

-- Owner review queue: only each user's latest snapshot is returned, and each
-- full-name/phone reveal is explicitly audited. Payout processing is not included.
create function public.facilitator_recipient_workspace() returns jsonb
language plpgsql volatile security definer set search_path='' set row_security=off as $$
declare actor uuid; result jsonb;
begin
  perform public.require_staff('superadmin');
  actor:=auth.uid();
  with latest as (
    select distinct on (user_id) * from public.facilitator_recipient_versions order by user_id,sequence desc
  ), logged as (
    insert into public.facilitator_recipient_audit(actor_id,subject_user_id,revision_id,action)
      select actor,l.user_id,l.revision_id,'owner_reveal' from latest l
      returning revision_id
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'user_id',l.user_id,'revision',l.revision_id,'full_name',l.full_name,'phone',l.phone,
    'consent_version',l.consent_version,'consented_at',l.consented_at,'created_at',l.created_at,
    'evidence_id',e.id,'evidence_reference',e.external_reference,'evidence_sha256',e.sha256,
    'evidence_submitted_by',e.submitted_by,'checked_by',c.checked_by,'owner_solo',c.owner_solo,
    'checked_at',c.checked_at,
    'status',case when public.facilitator_payout_recipient_ready(l.user_id,l.revision_id) then 'verified'
      when e.id is not null then 'review_pending' else 'evidence_required' end
  ) order by l.sequence desc),'[]'::jsonb) into result
  from latest l
  join logged x on x.revision_id=l.revision_id
  left join public.facilitator_recipient_evidence e on e.revision_id=l.revision_id
  left join public.facilitator_recipient_checks c on c.revision_id=l.revision_id;
  return result;
end $$;

create function public.facilitator_recipient_evidence_add(
  p_revision uuid,p_reference uuid,p_sha256 text,p_confirmed boolean
) returns uuid language plpgsql security definer set search_path='' set row_security=off as $$
declare actor uuid; v public.facilitator_recipient_versions; existing public.facilitator_recipient_evidence; result uuid;
begin
  perform public.require_staff('superadmin');
  if p_confirmed is distinct from true or p_revision is null or p_reference is null
    or p_sha256 is null or p_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception 'FACILITATOR_RECIPIENT_INPUT: Confirm an external evidence reference and SHA-256 digest.';
  end if;
  actor:=auth.uid();
  select * into v from public.facilitator_recipient_versions where revision_id=p_revision;
  if not found or v.revision_id is distinct from
    (select revision_id from public.facilitator_recipient_versions where user_id=v.user_id order by sequence desc limit 1) then
    raise exception 'FACILITATOR_RECIPIENT_CONFLICT: Recipient revision is stale; reload the latest revision.';
  end if;
  select * into existing from public.facilitator_recipient_evidence where revision_id=p_revision;
  if found then
    if (existing.external_reference,existing.sha256) is distinct from (p_reference,p_sha256) then
      raise exception 'FACILITATOR_RECIPIENT_CONFLICT: Evidence is already attached to this immutable revision.';
    end if;
    return existing.id;
  end if;
  insert into public.facilitator_recipient_evidence(revision_id,external_reference,sha256,submitted_by)
    values(p_revision,p_reference,p_sha256,actor) returning id into result;
  insert into public.facilitator_recipient_audit(actor_id,subject_user_id,revision_id,action)
    values(actor,v.user_id,p_revision,'evidence_recorded');
  return result;
end $$;

create function public.facilitator_recipient_verify(
  p_revision uuid,p_evidence uuid,p_owner_solo boolean,p_confirmed boolean
) returns boolean language plpgsql security definer set search_path='' set row_security=off as $$
declare actor uuid; role_name public.platform_role; v public.facilitator_recipient_versions;
  e public.facilitator_recipient_evidence; c public.facilitator_recipient_checks;
begin
  role_name:=public.require_staff('superadmin');
  actor:=auth.uid();
  if p_confirmed is distinct from true or p_owner_solo is null
    or (p_owner_solo and role_name<>'owner') then
    raise exception 'FACILITATOR_RECIPIENT_INPUT: Confirm the review; only the protected Owner may explicitly attest solo review.';
  end if;
  select * into v from public.facilitator_recipient_versions where revision_id=p_revision;
  if not found or v.revision_id is distinct from
    (select revision_id from public.facilitator_recipient_versions where user_id=v.user_id order by sequence desc limit 1) then
    raise exception 'FACILITATOR_RECIPIENT_CONFLICT: Recipient revision is stale; only the current revision can be verified.';
  end if;
  select * into e from public.facilitator_recipient_evidence where id=p_evidence and revision_id=p_revision;
  if not found then raise exception 'FACILITATOR_RECIPIENT_CONFLICT: Checked external evidence for this exact revision is required.'; end if;
  select * into c from public.facilitator_recipient_checks where revision_id=p_revision;
  if found then
    if (c.evidence_id,c.checked_by,c.owner_solo) is distinct from (p_evidence,actor,p_owner_solo) then
      raise exception 'FACILITATOR_RECIPIENT_CONFLICT: This revision was already verified by another review.';
    end if;
    return true;
  end if;
  if e.submitted_by=actor and not (p_owner_solo and role_name='owner') then
    raise exception 'FACILITATOR_RECIPIENT_CONFLICT: A different leader must check the evidence or the protected Owner must explicitly select solo review.';
  end if;
  insert into public.facilitator_recipient_checks(revision_id,evidence_id,checked_by,owner_solo)
    values(p_revision,p_evidence,actor,p_owner_solo);
  insert into public.facilitator_recipient_audit(actor_id,subject_user_id,revision_id,action)
    values(actor,v.user_id,p_revision,'verified');
  return true;
end $$;

-- Internal non-PII predicate for later payout work. Historical revisions never pass.
create function public.facilitator_payout_recipient_ready(p_user uuid,p_revision uuid) returns boolean
language sql stable security definer set search_path='' set row_security=off as $$
  select exists(
    select 1 from public.facilitator_recipient_versions v
    join public.facilitator_recipient_evidence e on e.revision_id=v.revision_id
    join public.facilitator_recipient_checks c on c.revision_id=v.revision_id and c.evidence_id=e.id
    join public.profiles checker on checker.id=c.checked_by and checker.platform_role in ('owner','superadmin')
    where v.user_id=p_user and v.revision_id=p_revision
      and v.revision_id=(select latest.revision_id from public.facilitator_recipient_versions latest
        where latest.user_id=p_user order by latest.sequence desc limit 1)
      and (c.checked_by<>e.submitted_by or (c.owner_solo and checker.platform_role='owner'))
  )
$$;

-- For future payout use only. Any returned name/phone is audit logged and
-- requires the recipient's own JWT or a leadership JWT; this records no transfer
-- and makes no provider call.
create function public.facilitator_payout_recipient_details(p_user uuid,p_revision uuid) returns jsonb
language plpgsql volatile security definer set search_path='' set row_security=off as $$
declare v public.facilitator_recipient_versions;
begin
  if auth.uid() is null or auth.uid() is distinct from p_user then
    perform public.require_staff('superadmin');
  end if;
  if not public.facilitator_payout_recipient_ready(p_user,p_revision) then return null; end if;
  select * into v from public.facilitator_recipient_versions where user_id=p_user and revision_id=p_revision;
  insert into public.facilitator_recipient_audit(actor_id,subject_user_id,revision_id,action)
    values(auth.uid(),p_user,p_revision,'payout_snapshot');
  return jsonb_build_object('revision',v.revision_id,'expected_name',v.full_name,'phone',v.phone);
end $$;

do $$
declare f record;
begin
  for f in select p.oid::regprocedure signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname like 'facilitator_recipient_%' loop
    execute format('revoke all on function %s from public,anon,authenticated,service_role',f.signature);
  end loop;
end $$;
revoke all on function public.facilitator_payout_recipient_ready(uuid,uuid),
  public.facilitator_payout_recipient_details(uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function public.facilitator_recipient_submit(uuid,text,text,boolean,text),
  public.facilitator_recipient_mine(),public.facilitator_recipient_workspace(),
  public.facilitator_recipient_evidence_add(uuid,uuid,text,boolean),
  public.facilitator_recipient_verify(uuid,uuid,boolean,boolean) to authenticated;
