-- Client-wedding referrals are separate from guest RSVP referrals.
-- No financial liability, funding attestation, transfer or payout is created here.
create table public.referral_policy (
  singleton boolean primary key default true check (singleton),
  enabled boolean not null default false,
  rate_basis_points integer not null default 0 check (rate_basis_points between 0 and 10000),
  revision uuid not null default extensions.gen_random_uuid(),
  feature_shipped_at timestamptz not null default clock_timestamp(),
  first_effective_at timestamptz,
  terms_version text not null default 'client-referrals-v1' check (terms_version = 'client-referrals-v1'),
  updated_by uuid references public.profiles(id) on delete restrict,
  updated_at timestamptz not null default clock_timestamp(),
  check (not enabled or (rate_basis_points > 0 and first_effective_at is not null))
);
insert into public.referral_policy(singleton) values(true);

create table public.referral_policy_history (
  id bigint generated always as identity primary key,
  actor_id uuid not null references public.profiles(id) on delete restrict,
  old_values jsonb not null,
  new_values jsonb not null,
  created_at timestamptz not null default clock_timestamp()
);
create table public.referral_accounts (
  user_id uuid primary key references public.profiles(id) on delete restrict,
  code text not null unique default encode(extensions.gen_random_bytes(16),'hex')
    check (code ~ '^[a-f0-9]{32}$'),
  opted_in boolean not null,
  terms_version text not null check (terms_version = 'client-referrals-v1'),
  consent_at timestamptz not null default clock_timestamp()
);
create table public.referral_consent_history (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.referral_accounts(user_id) on delete restrict,
  opted_in boolean not null,
  terms_version text not null,
  created_at timestamptz not null default clock_timestamp()
);
create table public.referral_intents (
  id uuid primary key default extensions.gen_random_uuid(),
  creator_id uuid not null references public.profiles(id) on delete restrict,
  referrer_id uuid not null references public.referral_accounts(user_id) on delete restrict,
  state text not null default 'pending' check (state in ('pending','consumed','declined')),
  captured_at timestamptz not null default clock_timestamp(),
  consumed_at timestamptz,
  check (creator_id <> referrer_id),
  check ((state='pending') = (consumed_at is null))
);
create unique index referral_first_pending on public.referral_intents(creator_id) where state='pending';
create table public.referral_attributions (
  wedding_id uuid primary key references public.weddings(id) on delete restrict,
  referrer_id uuid not null references public.referral_accounts(user_id) on delete restrict,
  creator_id uuid not null references public.profiles(id) on delete restrict,
  intent_id uuid not null unique references public.referral_intents(id) on delete restrict,
  disclosed_revision uuid not null,
  terms_version text not null,
  eligible boolean not null,
  created_at timestamptz not null default clock_timestamp(),
  check (creator_id <> referrer_id)
);
create table public.referral_contribution_policy (
  contribution_id uuid primary key references public.contributions(id) on delete restrict,
  wedding_id uuid not null references public.referral_attributions(wedding_id) on delete restrict,
  policy_revision uuid not null,
  rate_basis_points integer not null check (rate_basis_points between 0 and 10000),
  currency char(3) not null,
  admitted_at timestamptz not null default clock_timestamp()
);

create function public.referral_immutable() returns trigger language plpgsql set search_path='' as $$
begin raise exception 'Referral history is immutable.'; end $$;
create trigger referral_policy_history_immutable before update or delete on public.referral_policy_history
  for each row execute function public.referral_immutable();
create trigger referral_consent_history_immutable before update or delete on public.referral_consent_history
  for each row execute function public.referral_immutable();
create trigger referral_attribution_immutable before update or delete on public.referral_attributions
  for each row execute function public.referral_immutable();
create trigger referral_snapshot_immutable before update or delete on public.referral_contribution_policy
  for each row execute function public.referral_immutable();

create function public.referral_policy_guard() returns trigger language plpgsql set search_path='' as $$
begin
  if tg_op='DELETE' or new.feature_shipped_at is distinct from old.feature_shipped_at
    or (old.first_effective_at is not null and new.first_effective_at is distinct from old.first_effective_at)
    or (old.first_effective_at is null and new.first_effective_at is not null
      and new.first_effective_at < statement_timestamp()) then
    raise exception 'Referral eligibility cannot be backdated or removed.';
  end if;
  return new;
end $$;
create trigger referral_policy_guard before update or delete on public.referral_policy
  for each row execute function public.referral_policy_guard();

create function public.referral_validate_code(p_code text) returns jsonb
language sql stable security definer set search_path='' set row_security=off as $$
  select jsonb_build_object('valid', exists(select 1 from public.referral_accounts
    where code=p_code and opted_in), 'terms_version','client-referrals-v1')
$$;
create function public.referral_set_consent(p_opted_in boolean,p_terms_version text) returns jsonb
language plpgsql security definer set search_path='' set row_security=off as $$
declare a public.referral_accounts;
begin
  if auth.uid() is null then raise exception 'Referral authentication required.'; end if;
  if p_opted_in is null or p_terms_version is distinct from 'client-referrals-v1' then
    raise exception 'Review the current referral terms.'; end if;
  insert into public.referral_accounts(user_id,opted_in,terms_version)
    values(auth.uid(),p_opted_in,p_terms_version)
    on conflict(user_id) do update set opted_in=excluded.opted_in,terms_version=excluded.terms_version,
      consent_at=clock_timestamp()
    returning * into a;
  insert into public.referral_consent_history(user_id,opted_in,terms_version)
    values(auth.uid(),p_opted_in,p_terms_version);
  return jsonb_build_object('code',a.code,'opted_in',a.opted_in,
    'terms_version',a.terms_version,'consent_at',a.consent_at);
end $$;

create function public.referral_capture(p_code text) returns uuid
language plpgsql security definer set search_path='' set row_security=off as $$
declare r uuid; result uuid;
begin
  if auth.uid() is null then raise exception 'Referral authentication required.'; end if;
  perform 1 from public.profiles where id=auth.uid() for update;
  select id into result from public.referral_intents where creator_id=auth.uid() and state='pending';
  if found then return result; end if;
  select user_id into r from public.referral_accounts where code=p_code and opted_in for share;
  if not found then raise exception 'Invalid or withdrawn referral code.'; end if;
  if r=auth.uid() then raise exception 'Self referral is not allowed.'; end if;
  insert into public.referral_intents(creator_id,referrer_id) values(auth.uid(),r) returning id into result;
  return result;
end $$;

create function public.referral_disclosure() returns jsonb
language plpgsql stable security definer set search_path='' set row_security=off as $$
declare i public.referral_intents; p public.referral_policy; f public.platform_policies;
begin
  if auth.uid() is null then raise exception 'Referral authentication required.'; end if;
  select * into i from public.referral_intents where creator_id=auth.uid() and state='pending';
  select * into p from public.referral_policy where singleton;
  select * into f from public.platform_policies where id;
  return jsonb_build_object('intent_id',i.id,'revision',p.revision,'terms_version',p.terms_version,
    'enabled',p.enabled,'rate_basis_points',p.rate_basis_points,
    'platform_fee_basis_points',f.contribution_fee_basis_points,
    'platform_fixed_fee_minor',f.contribution_fixed_fee_minor::text,
    'platform_fixed_fee_currency',f.contribution_fixed_fee_currency,
    'payable_minor','0','status','held');
end $$;

create function public.referral_create_wedding(
  p_slug text,p_couple_names text,p_wedding_date date,p_location text,p_currency text,
  p_capacity integer,p_palette text[],p_venues jsonb,p_intent_id uuid,
  p_decision text,p_revision uuid,p_terms_version text
) returns uuid language plpgsql security definer set search_path='' set row_security=off as $$
declare i public.referral_intents; p public.referral_policy; w uuid; r public.referral_accounts;
begin
  if auth.uid() is null then raise exception 'Referral authentication required.'; end if;
  perform 1 from public.profiles where id=auth.uid() for update;
  select * into i from public.referral_intents where creator_id=auth.uid() and state='pending' for update;
  if found then
    if p_intent_id is distinct from i.id or p_decision is null or p_decision not in ('accept','decline') then
      raise exception 'REFERRAL_CONFLICT: Review the referral disclosure and choose accept or decline.'; end if;
    select * into p from public.referral_policy where singleton for share;
    if p_revision is distinct from p.revision or p_terms_version is distinct from p.terms_version then
      raise exception 'REFERRAL_CONFLICT: Referral policy changed; review the disclosure again.'; end if;
    if p_decision='accept' then
      select * into r from public.referral_accounts where user_id=i.referrer_id for share;
      if not r.opted_in then raise exception 'Invalid or withdrawn referral code.'; end if;
      if i.referrer_id=auth.uid() then raise exception 'Self referral is not allowed.'; end if;
    end if;
  elsif p_intent_id is not null then
    raise exception 'REFERRAL_CONFLICT: Referral intent was already consumed.';
  end if;
  w:=public.create_wedding_with_venues(p_slug,p_couple_names,p_wedding_date,p_location,
    p_currency,p_capacity,p_palette,p_venues);
  if i.id is not null then
    if p_decision='accept' then
      if exists(select 1 from public.weddings where id=w and client_owner_id=i.referrer_id)
        or exists(select 1 from public.wedding_memberships where wedding_id=w
          and user_id=i.referrer_id and role='client') then
        raise exception 'Self referral is not allowed.';
      end if;
      insert into public.referral_attributions(wedding_id,referrer_id,creator_id,intent_id,
        disclosed_revision,terms_version,eligible)
        values(w,i.referrer_id,auth.uid(),i.id,p.revision,p.terms_version,
          p.first_effective_at is not null and
          clock_timestamp() >= greatest(p.feature_shipped_at,p.first_effective_at));
    end if;
    update public.referral_intents set state=case when p_decision='accept' then 'consumed' else 'declined' end,
      consumed_at=clock_timestamp() where id=i.id;
  end if;
  return w;
end $$;

create function public.referral_snapshot_contribution() returns trigger
language plpgsql security definer set search_path='' set row_security=off as $$
declare a public.referral_attributions; p public.referral_policy;
begin
  select * into a from public.referral_attributions where wedding_id=new.wedding_id;
  if not found then return new; end if;
  select * into p from public.referral_policy where singleton for share;
  insert into public.referral_contribution_policy(contribution_id,wedding_id,policy_revision,rate_basis_points,currency)
    values(new.id,new.wedding_id,p.revision,
      case when a.eligible and p.enabled and exists(select 1 from public.referral_accounts
        where user_id=a.referrer_id and opted_in) then p.rate_basis_points else 0 end,new.currency);
  return new;
end $$;
create trigger referral_snapshot_contribution after insert on public.contributions
  for each row execute function public.referral_snapshot_contribution();

create function public.referral_admin_policy() returns jsonb
language plpgsql stable security definer set search_path='' set row_security=off as $$
begin
  perform public.require_staff('superadmin');
  return (select to_jsonb(p) from public.referral_policy p where singleton);
end $$;
create function public.referral_owner_policy(p_enabled boolean,p_rate_basis_points integer,p_revision uuid,p_confirmed boolean)
returns jsonb language plpgsql security definer set search_path='' set row_security=off as $$
declare p public.referral_policy; next_p public.referral_policy;
begin
  perform public.require_staff('owner');
  if not coalesce(p_confirmed,false) or p_enabled is null or p_rate_basis_points is null
    or p_rate_basis_points not between 0 and 10000 or (p_enabled and p_rate_basis_points=0) then
    raise exception 'Confirm a valid referral policy.'; end if;
  select * into p from public.referral_policy where singleton for update;
  if p_revision is distinct from p.revision then raise exception 'REFERRAL_CONFLICT: Referral policy changed; reload.'; end if;
  update public.referral_policy set enabled=p_enabled,rate_basis_points=p_rate_basis_points,
    first_effective_at=case when p_enabled then coalesce(first_effective_at,clock_timestamp()) else first_effective_at end,
    revision=extensions.gen_random_uuid(),updated_by=auth.uid(),updated_at=clock_timestamp()
    where singleton returning * into next_p;
  insert into public.referral_policy_history(actor_id,old_values,new_values)
    values(auth.uid(),to_jsonb(p),to_jsonb(next_p));
  return to_jsonb(next_p);
end $$;
create function public.referral_admin_history() returns jsonb
language plpgsql stable security definer set search_path='' set row_security=off as $$
begin
  perform public.require_staff('superadmin');
  return coalesce((select jsonb_agg(to_jsonb(h) order by h.id desc) from
    (select * from public.referral_policy_history order by id desc limit 100) h),'[]'::jsonb);
end $$;

do $$
declare t text; fn record;
begin
  foreach t in array array['referral_policy','referral_policy_history','referral_accounts',
    'referral_consent_history','referral_intents','referral_attributions','referral_contribution_policy'] loop
    execute format('alter table public.%I enable row level security',t);
    execute format('revoke all on public.%I from public,anon,authenticated,service_role',t);
  end loop;
  for fn in select p.oid::regprocedure signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname like 'referral_%' loop
    execute format('revoke all on function %s from public,anon,authenticated,service_role',fn.signature);
  end loop;
end $$;
grant execute on function public.referral_validate_code(text) to anon,authenticated;
grant execute on function public.referral_set_consent(boolean,text),public.referral_capture(text),
  public.referral_disclosure(),public.referral_admin_policy(),public.referral_admin_history(),
  public.referral_owner_policy(boolean,integer,uuid,boolean),
  public.referral_create_wedding(text,text,date,text,text,integer,text[],jsonb,uuid,text,uuid,text) to authenticated;
