-- Optional fundraising campaigns: several named streams per wedding, each with ordered milestones.
-- Additive and idempotent. Money rows still live in public.contributions.
alter table public.fundraising_streams add column if not exists sort_order integer not null default 0;

create table if not exists public.fundraising_milestones (
  id uuid primary key default extensions.gen_random_uuid(),
  stream_id uuid not null references public.fundraising_streams(id) on delete cascade,
  wedding_id uuid not null references public.weddings(id) on delete cascade,
  name text not null check (length(name) between 1 and 100),
  description text check (description is null or length(description) <= 240),
  target_minor bigint not null check (target_minor > 0),
  sort_order integer not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists idx_fund_milestones_stream on public.fundraising_milestones(stream_id, sort_order);
alter table public.fundraising_milestones enable row level security;
-- No direct client access: all reads and writes go through the security-definer functions below.

alter table public.contributions add column if not exists stream_id uuid references public.fundraising_streams(id) on delete set null;
alter table public.contributions add column if not exists milestone_id uuid references public.fundraising_milestones(id) on delete set null;
create index if not exists idx_contributions_stream on public.contributions(stream_id);

-- Organizer save (service role; the API verifies wedding ownership first).
-- Campaigns omitted from the payload are disabled, never deleted, so the ledger stays intact.
create or replace function public.save_fundraising_campaigns(p_wedding_id uuid, p_payload jsonb)
returns void language plpgsql security definer set search_path = ''
as $$
declare
  w public.weddings;
  c jsonb; m jsonb;
  v_stream uuid;
  v_keep uuid[] := '{}';
  v_mkeep uuid[];
  v_mid uuid;
  si integer := 0; mi integer;
begin
  if auth.role() <> 'service_role' then raise exception 'Service role required.'; end if;
  select * into w from public.weddings where id = p_wedding_id;
  if not found then raise exception 'Wedding not found.'; end if;
  if jsonb_typeof(p_payload) <> 'array' then raise exception 'Invalid campaigns.'; end if;
  if jsonb_array_length(p_payload) > 6 then raise exception 'At most 6 campaigns.'; end if;

  for c in select * from jsonb_array_elements(p_payload) loop
    v_stream := null;
    if (c->>'id') ~* '^[0-9a-f-]{36}$' then
      select id into v_stream from public.fundraising_streams where id = (c->>'id')::uuid and wedding_id = p_wedding_id;
    end if;
    if v_stream is null then
      insert into public.fundraising_streams (wedding_id, name, purpose, goal_minor, currency, enabled, sort_order)
      values (p_wedding_id, left(trim(c->>'name'), 100), left(coalesce(nullif(trim(c->>'purpose'), ''), trim(c->>'name')), 240),
              (c->>'goal_minor')::bigint, w.currency, coalesce((c->>'enabled')::boolean, true), si)
      returning id into v_stream;
    else
      update public.fundraising_streams set name = left(trim(c->>'name'), 100),
        purpose = left(coalesce(nullif(trim(c->>'purpose'), ''), trim(c->>'name')), 240),
        goal_minor = (c->>'goal_minor')::bigint, enabled = coalesce((c->>'enabled')::boolean, true), sort_order = si
      where id = v_stream;
    end if;
    v_keep := v_keep || v_stream;
    v_mkeep := '{}'; mi := 0;
    for m in select * from jsonb_array_elements(coalesce(c->'milestones', '[]'::jsonb)) loop
      v_mid := null;
      if (m->>'id') ~* '^[0-9a-f-]{36}$' then
        select id into v_mid from public.fundraising_milestones where id = (m->>'id')::uuid and stream_id = v_stream;
      end if;
      if v_mid is null then
        insert into public.fundraising_milestones (stream_id, wedding_id, name, description, target_minor, sort_order)
        values (v_stream, p_wedding_id, left(trim(m->>'name'), 100), nullif(left(trim(coalesce(m->>'description', '')), 240), ''),
                (m->>'target_minor')::bigint, mi) returning id into v_mid;
      else
        update public.fundraising_milestones set name = left(trim(m->>'name'), 100),
          description = nullif(left(trim(coalesce(m->>'description', '')), 240), ''),
          target_minor = (m->>'target_minor')::bigint, sort_order = mi where id = v_mid;
      end if;
      v_mkeep := v_mkeep || v_mid; mi := mi + 1;
    end loop;
    update public.contributions set milestone_id = null
      where stream_id = v_stream and milestone_id is not null and not (milestone_id = any(v_mkeep));
    delete from public.fundraising_milestones where stream_id = v_stream and not (id = any(v_mkeep));
    si := si + 1;
  end loop;
  update public.fundraising_streams set enabled = false where wedding_id = p_wedding_id and not (id = any(v_keep));
end $$;
revoke all on function public.save_fundraising_campaigns(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.save_fundraising_campaigns(uuid, jsonb) to service_role;

-- Public view: enabled campaigns with raised totals and milestone completion (no donor data).
create or replace function public.get_public_campaigns(p_slug text)
returns jsonb language sql stable security definer set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', s.id, 'name', s.name, 'purpose', s.purpose, 'goal_minor', s.goal_minor, 'currency', s.currency,
    'raised_minor', r.raised,
    'milestones', coalesce((
      select jsonb_agg(jsonb_build_object('id', m.id, 'name', m.name, 'description', m.description,
        'target_minor', m.target_minor, 'reached', r.raised >= m.target_minor) order by m.sort_order, m.created_at)
      from public.fundraising_milestones m where m.stream_id = s.id), '[]'::jsonb)
  ) order by s.sort_order, s.created_at), '[]'::jsonb)
  from public.weddings w
  join public.fundraising_streams s on s.wedding_id = w.id and s.enabled
  cross join lateral (
    select coalesce(sum(c.paid_amount_minor), 0)::bigint as raised
    from public.contributions c where c.stream_id = s.id and c.payment_status = 'paid'
  ) r
  where w.slug = lower(p_slug) and w.published_at is not null and w.archived_at is null;
$$;
revoke all on function public.get_public_campaigns(text) from public;
grant execute on function public.get_public_campaigns(text) to anon, authenticated;

-- Organizer ledger by campaign (service role; API verifies ownership). Display names only.
create or replace function public.get_campaign_ledger(p_wedding_id uuid)
returns jsonb language sql stable security definer set search_path = ''
as $$
  select jsonb_build_object(
    'campaigns', coalesce((
      select jsonb_agg(jsonb_build_object('id', s.id, 'name', s.name, 'goal_minor', s.goal_minor, 'enabled', s.enabled,
        'raised_minor', coalesce((select sum(c.paid_amount_minor) from public.contributions c
          where c.stream_id = s.id and c.payment_status = 'paid'), 0),
        'pledges', (select count(*) from public.contributions c where c.stream_id = s.id and c.payment_status = 'paid'))
        order by s.sort_order, s.created_at)
      from public.fundraising_streams s where s.wedding_id = p_wedding_id), '[]'::jsonb),
    'rows', coalesce((
      select jsonb_agg(x order by x.created_at desc) from (
        select c.id, c.display_name as guest, c.paid_amount_minor as amount_minor, c.stream_name as campaign,
               m.name as milestone, c.payment_status as status, c.provider_name as provider, c.created_at
        from public.contributions c left join public.fundraising_milestones m on m.id = c.milestone_id
        where c.wedding_id = p_wedding_id and c.stream_id is not null
        order by c.created_at desc limit 200) x), '[]'::jsonb)
  );
$$;
revoke all on function public.get_campaign_ledger(uuid) from public, anon, authenticated;
grant execute on function public.get_campaign_ledger(uuid) to service_role;

-- Test-mode pledge to a campaign; auto-attributes to the first unreached milestone unless one is chosen.
create or replace function public.record_test_campaign_pledge(
  p_wedding_id uuid, p_stream_id uuid, p_milestone_id uuid, p_name text, p_amount_minor bigint, p_visibility text
) returns uuid language plpgsql security definer set search_path = ''
as $$
declare
  w public.weddings; s public.fundraising_streams;
  bps integer; fee bigint; v_id uuid := extensions.gen_random_uuid();
  v_vis text := coalesce(p_visibility, 'hidden');
  v_ms uuid := null; v_raised bigint;
begin
  if auth.role() <> 'service_role' then raise exception 'Service role required.'; end if;
  select * into w from public.weddings where id = p_wedding_id;
  if not found or w.published_at is null or w.archived_at is not null then raise exception 'This wedding is not accepting payments.'; end if;
  if w.wedding_date < (now() at time zone w.time_zone)::date then raise exception 'This wedding has taken place; contributions are closed.'; end if;
  select * into s from public.fundraising_streams where id = p_stream_id and wedding_id = p_wedding_id and enabled;
  if not found then raise exception 'Fundraiser not found.'; end if;
  if v_vis not in ('name', 'anonymous', 'hidden') then v_vis := 'hidden'; end if;
  select contribution_fee_basis_points into bps from public.platform_policies where id;
  select coalesce(sum(paid_amount_minor), 0) into v_raised from public.contributions where stream_id = s.id and payment_status = 'paid';
  if p_milestone_id is not null then
    select id into v_ms from public.fundraising_milestones where id = p_milestone_id and stream_id = s.id;
  end if;
  if v_ms is null then
    select id into v_ms from public.fundraising_milestones where stream_id = s.id and target_minor > v_raised
      order by sort_order, created_at limit 1;
  end if;
  fee := round(p_amount_minor::numeric * bps / 10000)::bigint;
  insert into public.contributions (id, wedding_id, stream_id, milestone_id, stream_name, pledged_amount_minor, paid_amount_minor,
    platform_fee_basis_points, platform_fee_minor, net_paid_minor, currency, payment_status, display_name,
    visibility, public_consent_at, provider_name, provider_reference, paid_at, funds_available_at)
  values (v_id, p_wedding_id, s.id, v_ms, left(s.name, 100), p_amount_minor, p_amount_minor, bps, fee, p_amount_minor - fee, w.currency,
    'paid', coalesce(nullif(left(trim(p_name), 100), ''), 'Anonymous guest'),
    v_vis, case when v_vis <> 'hidden' then now() end, 'test-simulator', 'TEST-' || v_id::text, now(), now());
  return v_id;
end $$;
revoke all on function public.record_test_campaign_pledge(uuid, uuid, uuid, text, bigint, text) from public, anon, authenticated;
grant execute on function public.record_test_campaign_pledge(uuid, uuid, uuid, text, bigint, text) to service_role;
