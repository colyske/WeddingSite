-- Optional featured sponsor campaign. Bid amounts are paid contributions to the
-- wedding fund; a sponsor only receives a featured slot after provider verification.
alter table public.contributions drop constraint if exists contributions_purchase_action_check;
alter table public.contributions add constraint contributions_purchase_action_check
  check (purchase_action is null or purchase_action in
    ('rsvp', 'song_bid', 'vip', 'sponsor', 'fundraiser', 'registry', 'sponsor_featured_bid'));

create table if not exists public.sponsor_featured_campaigns (
  wedding_id uuid primary key references public.weddings(id) on delete cascade,
  enabled boolean not null default false,
  starts_at timestamptz not null,
  closes_at timestamptz not null,
  slot_count integer not null check (slot_count between 1 and 20),
  minimum_bid_minor bigint not null check (minimum_bid_minor between 1 and 100000000000),
  bid_increment_minor bigint not null check (bid_increment_minor between 1 and 100000000000),
  updated_by uuid references public.profiles(id) on delete set null,
  updated_at timestamptz not null default now(),
  check (closes_at > starts_at)
);
alter table public.sponsor_featured_campaigns enable row level security;
revoke all on public.sponsor_featured_campaigns from anon, authenticated;

create table if not exists public.sponsor_featured_bids (
  contribution_id uuid primary key references public.contributions(id) on delete restrict,
  wedding_id uuid not null references public.weddings(id) on delete restrict,
  sponsor_id uuid not null references public.sponsors(id) on delete restrict,
  campaign_id uuid not null references public.sponsor_featured_campaigns(wedding_id) on delete restrict,
  company_name text not null check (length(company_name) between 1 and 100),
  amount_minor bigint not null check (amount_minor between 1 and 100000000000),
  currency char(3) not null check (currency ~ '^[A-Z]{3}$'),
  created_at timestamptz not null default now()
);
alter table public.sponsor_featured_bids enable row level security;
revoke all on public.sponsor_featured_bids from anon, authenticated;
create index if not exists sponsor_featured_bids_wedding_company_idx
  on public.sponsor_featured_bids(wedding_id, lower(company_name));

create or replace function public.save_sponsor_featured_campaign(p_wedding_id uuid, p_data jsonb)
returns boolean language plpgsql security definer set search_path = '' set row_security = off
as $$
declare
  v_start timestamptz;
  v_close timestamptz;
  v_enabled boolean;
  v_slots integer;
  v_minimum bigint;
  v_increment bigint;
  v_old public.sponsor_featured_campaigns;
begin
  if not public.has_wedding_role(p_wedding_id, array['client']::public.workspace_role[]) then
    raise exception 'Only the wedding owner can manage featured sponsor bidding.';
  end if;
  if jsonb_typeof(p_data) is distinct from 'object' then raise exception 'Campaign settings are invalid.'; end if;
  v_enabled := coalesce((p_data->>'enabled')::boolean, false);
  if not v_enabled then
    update public.sponsor_featured_campaigns set enabled = false, updated_by = auth.uid(), updated_at = now()
      where wedding_id = p_wedding_id;
    if not found then
      insert into public.sponsor_featured_campaigns (
        wedding_id, enabled, starts_at, closes_at, slot_count, minimum_bid_minor, bid_increment_minor, updated_by
      ) values (p_wedding_id, false, now(), now() + interval '1 day', 1, 100, 100, auth.uid());
    end if;
    insert into public.audit_events (wedding_id, actor_id, source, action, table_name, record_id, changed_fields)
    values (p_wedding_id, auth.uid(), 'user', 'sponsor_featured_campaign_disabled',
      'sponsor_featured_campaigns', p_wedding_id::text, array['enabled']);
    return true;
  end if;
  begin
    v_start := (p_data->>'starts_at')::timestamptz;
    v_close := (p_data->>'closes_at')::timestamptz;
    v_slots := (p_data->>'slot_count')::integer;
    v_minimum := (p_data->>'minimum_bid_minor')::bigint;
    v_increment := (p_data->>'bid_increment_minor')::bigint;
  exception when others then
    raise exception 'Enter valid dates, slot count, minimum bid and bid increment.';
  end;
  if v_start is null or v_close <= v_start or v_slots not between 1 and 20
      or v_minimum not between 1 and 100000000000 or v_increment not between 1 and 100000000000 then
    raise exception 'Campaign window, slots and bid amounts are outside allowed limits.';
  end if;
  select * into v_old from public.sponsor_featured_campaigns
    where wedding_id = p_wedding_id for update;
  if found and exists (select 1 from public.sponsor_featured_bids b where b.wedding_id = p_wedding_id)
      and (v_old.starts_at is distinct from v_start or v_old.closes_at is distinct from v_close
        or v_old.slot_count is distinct from v_slots or v_old.minimum_bid_minor is distinct from v_minimum
        or v_old.bid_increment_minor is distinct from v_increment) then
    raise exception 'Campaign terms cannot change after a paid bid. Disable this campaign instead.';
  end if;
  insert into public.sponsor_featured_campaigns (
    wedding_id, enabled, starts_at, closes_at, slot_count, minimum_bid_minor,
    bid_increment_minor, updated_by, updated_at
  ) values (p_wedding_id, true, v_start, v_close, v_slots, v_minimum, v_increment, auth.uid(), now())
  on conflict (wedding_id) do update set enabled = excluded.enabled, starts_at = excluded.starts_at,
    closes_at = excluded.closes_at, slot_count = excluded.slot_count,
    minimum_bid_minor = excluded.minimum_bid_minor, bid_increment_minor = excluded.bid_increment_minor,
    updated_by = excluded.updated_by, updated_at = excluded.updated_at;
  insert into public.audit_events (wedding_id, actor_id, source, action, table_name, record_id, changed_fields)
  values (p_wedding_id, auth.uid(), 'user', 'sponsor_featured_campaign_update',
    'sponsor_featured_campaigns', p_wedding_id::text,
    array['enabled', 'starts_at', 'closes_at', 'slot_count', 'minimum_bid_minor', 'bid_increment_minor']);
  return true;
end $$;
revoke all on function public.save_sponsor_featured_campaign(uuid, jsonb) from public, anon;
grant execute on function public.save_sponsor_featured_campaign(uuid, jsonb) to authenticated;

create or replace function public.get_public_sponsor_auction(p_slug text)
returns jsonb language plpgsql stable security definer set search_path = '' set row_security = off
as $$
declare
  v_wedding public.weddings;
  v_campaign public.sponsor_featured_campaigns;
  v_leaders jsonb;
  v_next bigint;
begin
  select * into v_wedding from public.weddings w
    where w.slug = p_slug and w.published_at is not null and w.archived_at is null;
  if not found then return null; end if;
  select * into v_campaign from public.sponsor_featured_campaigns c where c.wedding_id = v_wedding.id;
  if not found or not v_campaign.enabled then return jsonb_build_object('enabled', false); end if;
  select coalesce(jsonb_agg(to_jsonb(r) order by r.total_minor desc, lower(r.company_name)), '[]'::jsonb)
    into v_leaders
  from (
    select min(b.company_name) as company_name, sum(b.amount_minor)::bigint as total_minor,
      count(*)::integer as bid_count, min(b.currency)::text as currency
    from public.sponsor_featured_bids b
    join public.contributions c on c.id = b.contribution_id
    where b.wedding_id = v_wedding.id and c.payment_status = 'paid'
      and c.verified_provider_payment and c.action_completed_at is not null
    group by lower(b.company_name)
    order by sum(b.amount_minor) desc limit 20
  ) r;
  select coalesce(max(t.total_minor), 0) + v_campaign.bid_increment_minor
    into v_next
  from (
    select lower(b.company_name) company_key, sum(b.amount_minor)::bigint total_minor
    from public.sponsor_featured_bids b
    join public.contributions c on c.id = b.contribution_id
    where b.wedding_id = v_wedding.id and c.payment_status = 'paid'
      and c.verified_provider_payment and c.action_completed_at is not null
    group by lower(b.company_name)
  ) t;
  return jsonb_build_object(
    'enabled', true,
    'status', case when now() < v_campaign.starts_at then 'scheduled'
      when now() < v_campaign.closes_at then 'open' else 'closed' end,
    'starts_at', v_campaign.starts_at, 'closes_at', v_campaign.closes_at,
    'slot_count', v_campaign.slot_count, 'minimum_bid_minor', v_campaign.minimum_bid_minor,
    'bid_increment_minor', v_campaign.bid_increment_minor,
    'next_bid_minor', greatest(v_campaign.minimum_bid_minor, v_next),
    'leaders', v_leaders
  );
end $$;
revoke all on function public.get_public_sponsor_auction(text) from public;
grant execute on function public.get_public_sponsor_auction(text) to anon, authenticated;

create or replace function public.finalize_featured_sponsor_bid()
returns trigger language plpgsql security definer set search_path = '' set row_security = off
as $$
declare
  d jsonb := coalesce(new.purchase_data, '{}'::jsonb);
  campaign public.sponsor_featured_campaigns;
  sponsor_id uuid;
  company text := left(trim(coalesce(d->>'companyName', '')), 100);
  quoted_minimum bigint := nullif(d->>'minimumBidAtCheckout', '')::bigint;
begin
  if new.payment_status <> 'paid' or not new.verified_provider_payment
      or new.purchase_action <> 'sponsor_featured_bid' then return new; end if;

  select * into campaign from public.sponsor_featured_campaigns
    where wedding_id = new.wedding_id and enabled for update;
  if not found or new.paid_at < campaign.starts_at or new.paid_at > campaign.closes_at or company = '' then
    update public.contributions set action_completed_at = null,
      action_result = jsonb_build_object('completed', false, 'status', 'review_required')
      where id = new.id;
    insert into public.payment_action_reviews (contribution_id, wedding_id, reason_code)
      values (new.id, new.wedding_id, 'sponsor_featured_bid_review_required')
      on conflict (contribution_id) do nothing;
    return new;
  end if;

  if quoted_minimum is null or quoted_minimum < campaign.minimum_bid_minor
      or new.paid_amount_minor < quoted_minimum then
    update public.contributions set action_completed_at = null,
      action_result = jsonb_build_object('completed', false, 'status', 'review_required')
      where id = new.id;
    insert into public.payment_action_reviews (contribution_id, wedding_id, reason_code)
      values (new.id, new.wedding_id, 'sponsor_featured_bid_increment_changed')
      on conflict (contribution_id) do nothing;
    return new;
  end if;

  insert into public.sponsors (wedding_id, company_name, contact_email, contact_phone, website, amount_minor,
    contribution_id, location, offer, public_contact, status)
  values (new.wedding_id, company, nullif(left(d->>'email', 200), ''),
    nullif(left(d->>'phone', 30), ''), nullif(left(d->>'website', 300), ''),
    new.paid_amount_minor, new.id, nullif(left(trim(d->>'location'), 160), ''),
    nullif(left(trim(d->>'offer'), 360), ''), coalesce((d->>'publicContact')::boolean, false), 'active')
  returning id into sponsor_id;
  insert into public.sponsor_featured_bids (
    contribution_id, wedding_id, sponsor_id, campaign_id, company_name, amount_minor, currency
  ) values (new.id, new.wedding_id, sponsor_id, new.wedding_id, company, new.paid_amount_minor, new.currency);
  update public.contributions set action_result = jsonb_build_object(
    'completed', true, 'kind', 'sponsor_featured_bid', 'sponsorId', sponsor_id)
    where id = new.id;
  return new;
exception when others then
  update public.contributions set action_completed_at = null,
    action_result = jsonb_build_object('completed', false, 'status', 'review_required')
    where id = new.id;
  insert into public.payment_action_reviews (contribution_id, wedding_id, reason_code)
    values (new.id, new.wedding_id, 'sponsor_featured_bid_finalize_failed')
    on conflict (contribution_id) do nothing;
  return new;
end $$;
drop trigger if exists finalize_featured_sponsor_bid on public.contributions;
create trigger finalize_featured_sponsor_bid
  after update of payment_status on public.contributions
  for each row execute function public.finalize_featured_sponsor_bid();
revoke all on function public.finalize_featured_sponsor_bid() from public, anon, authenticated;
