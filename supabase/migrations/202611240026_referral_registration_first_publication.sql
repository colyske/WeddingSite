alter table public.referral_intents
  add column is_default boolean not null default false,
  add column eligible boolean not null default false;

alter table public.referral_intents
  drop constraint referral_intents_state_check,
  drop constraint referral_intents_check1,
  drop constraint referral_intents_check2,
  add constraint referral_intents_state_check
    check (state in ('pending','accepted','consumed','declined','expired')),
  add constraint referral_intents_consumed_check
    check ((state in ('pending','accepted')) = (consumed_at is null)),
  add constraint referral_intents_disclosure_check
    check ((state='pending' and disclosed_revision is null and disclosed_terms_version is null)
      or (state in ('accepted','consumed','declined') and disclosed_revision is not null
        and disclosed_terms_version is not null and disclosed_terms_version='client-referrals-v1')
      or state='expired');

create function public.referral_register_intent(p_creator uuid,p_code text,p_is_default boolean) returns uuid
language plpgsql security definer set search_path='' set row_security=off as $$
declare r uuid; result uuid;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'Referral registration is server-only.'; end if;
  if p_creator is null or p_is_default is null or p_code !~ '^[a-f0-9]{32}$'
    or (p_is_default and p_code is distinct from '3b79b3fbb32894bf82dbaf21d2765deb') then
    raise exception 'Invalid referral registration.';
  end if;
  perform 1 from public.profiles where id=p_creator for update;
  if not found then raise exception 'Referral registration profile is unavailable.'; end if;
  select id into result from public.referral_intents where creator_id=p_creator
    order by captured_at desc limit 1 for update;
  if found then return result; end if;
  select user_id into r from public.referral_accounts where code=p_code and opted_in for share;
  if not found then raise exception 'Invalid or withdrawn referral code.'; end if;
  if r=p_creator then raise exception 'Self referral is not allowed.'; end if;
  insert into public.referral_intents(creator_id,referrer_id,is_default,eligible)
    values(p_creator,r,p_is_default,true) returning id into result;
  return result;
end $$;

create function public.referral_capture_internal(p_code text,p_is_default boolean) returns uuid
language plpgsql security definer set search_path='' set row_security=off as $$
declare r uuid; existing public.referral_intents;
begin
  if auth.uid() is null then raise exception 'Referral authentication required.'; end if;
  perform 1 from public.profiles where id=auth.uid() for update;
  select * into existing from public.referral_intents
    where creator_id=auth.uid() order by captured_at desc limit 1 for update;
  if found then
    if existing.state='pending' and existing.is_default and not p_is_default then
      select user_id into r from public.referral_accounts where code=p_code and opted_in for share;
      if not found then raise exception 'Invalid or withdrawn referral code.'; end if;
      if r=auth.uid() then raise exception 'Self referral is not allowed.'; end if;
      update public.referral_intents set referrer_id=r,is_default=false
        where id=existing.id and state='pending' and is_default;
    end if;
    return existing.id;
  end if;
  raise exception 'Referral links are only available during new account registration.';
end $$;

create or replace function public.referral_capture(p_code text) returns uuid
language sql security definer set search_path='' set row_security=off as $$
  select public.referral_capture_internal(p_code,false)
$$;

create function public.referral_capture_default(p_code text) returns uuid
language sql security definer set search_path='' set row_security=off as $$
  select public.referral_capture_internal(p_code,true)
$$;

create or replace function public.referral_create_wedding(
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
    raise exception 'REFERRAL_CONFLICT: Referral intent was already consumed.'; end if;
  w:=public.create_wedding_with_venues(p_slug,p_couple_names,p_wedding_date,p_location,
    p_currency,p_capacity,p_palette,p_venues);
  if i.id is not null then
    if p_decision='accept' and
        (exists(select 1 from public.weddings where id=w and client_owner_id=i.referrer_id)
          or exists(select 1 from public.wedding_memberships where wedding_id=w
            and user_id=i.referrer_id and role='client')) then
      raise exception 'Self referral is not allowed.';
    end if;
    update public.referral_intents set
      state=case when p_decision='accept' then 'accepted' else 'declined' end,
      consumed_at=case when p_decision='accept' then null else clock_timestamp() end,
      disclosed_revision=p.revision,disclosed_terms_version=p.terms_version,
      eligible=i.eligible and p_decision='accept' and p.first_effective_at is not null and
        clock_timestamp() >= greatest(p.feature_shipped_at,p.first_effective_at)
      where id=i.id;
  end if;
  return w;
end $$;

create function public.referral_record_first_publication() returns trigger
language plpgsql security definer set search_path='' set row_security=off as $$
declare i public.referral_intents; r public.referral_accounts;
begin
  if new.first_published_at is null or old.first_published_at is not null then return new; end if;
  perform 1 from public.profiles where id=new.client_owner_id for update;
  if exists(select 1 from public.weddings where client_owner_id=new.client_owner_id
      and id<>new.id and first_published_at is not null) then
    update public.referral_intents set state='expired',consumed_at=coalesce(consumed_at,clock_timestamp())
      where creator_id=new.client_owner_id and state in ('pending','accepted');
    return new;
  end if;
  select * into i from public.referral_intents where creator_id=new.client_owner_id
    and state='accepted' for update;
  if found then
    select * into r from public.referral_accounts where user_id=i.referrer_id for share;
    if r.opted_in and r.user_id<>new.client_owner_id and
        not exists(select 1 from public.wedding_memberships where wedding_id=new.id
          and user_id=r.user_id and role='client') then
      insert into public.referral_attributions(wedding_id,referrer_id,creator_id,intent_id,
        disclosed_revision,terms_version,eligible)
        values(new.id,r.user_id,new.client_owner_id,i.id,i.disclosed_revision,
          i.disclosed_terms_version,i.eligible);
    end if;
    update public.referral_intents set state='consumed',consumed_at=clock_timestamp() where id=i.id;
  else
    update public.referral_intents set state='expired',consumed_at=clock_timestamp()
      where creator_id=new.client_owner_id and state='pending';
  end if;
  return new;
end $$;
create trigger referral_record_first_publication
  after update of first_published_at on public.weddings
  for each row execute function public.referral_record_first_publication();

revoke all on function public.referral_capture_internal(text,boolean) from public,anon,authenticated,service_role;
revoke all on function public.referral_record_first_publication() from public,anon,authenticated,service_role;
revoke all on function public.referral_capture(text),public.referral_capture_default(text)
  from public,anon,authenticated,service_role;
grant execute on function public.referral_capture(text),public.referral_capture_default(text) to authenticated;
revoke all on function public.referral_register_intent(uuid,text,boolean) from public,anon,authenticated,service_role;
grant execute on function public.referral_register_intent(uuid,text,boolean) to service_role;
