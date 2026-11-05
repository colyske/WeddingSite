-- Public raised is adjusted gross, not withdrawable net. Reuse the same refund,
-- dispute and hold treatment as public sponsor/song placement.
create or replace function public.get_public_celebration_progress(p_slug text)
returns jsonb language sql stable security definer set search_path = '' set row_security = off
as $$
  with wedding as (
    select w.id, w.currency from public.weddings w
    where w.slug = lower(p_slug) and w.published_at is not null and w.archived_at is null
      and (w.revenue_features->>'giving')::boolean
  ), campaign as (
    select s.id, s.goal_minor, s.currency, w.id as wedding_id
    from wedding w join public.fundraising_streams s on s.wedding_id = w.id
    where s.enabled and s.currency = w.currency
    order by s.sort_order, s.created_at, s.id limit 1
  ), payments as materialized (
    select case c.purchase_action
      when 'fundraiser' then 'gifts'
      when 'song_bid' then 'songs'
      when 'registry' then 'registry'
      when 'sponsor' then 'sponsors'
      when 'sponsor_featured_bid' then 'sponsors'
      when 'vip' then 'vip'
    end as source, public.displayable_contribution_amount(c.id) as amount
    from campaign p join public.contributions c on c.wedding_id = p.wedding_id and c.currency = p.currency
    where c.payment_status = 'paid' and c.verified_provider_payment
      and c.payment_environment = 'live' and c.action_completed_at is not null
      and c.purchase_action in ('fundraiser', 'song_bid', 'registry', 'sponsor', 'sponsor_featured_bid', 'vip')
  ), sources as (
    select k.key, k.position, coalesce(sum(p.amount), 0)::bigint as amount_minor
    from (values ('gifts', 1), ('songs', 2), ('registry', 3), ('sponsors', 4), ('vip', 5)) k(key, position)
    left join payments p on p.source = k.key
    group by k.key, k.position
  ), totals as (
    select sum(s.amount_minor)::bigint as raised,
      jsonb_agg(jsonb_build_object('key', s.key, 'amount_minor', s.amount_minor) order by s.position) as sources
    from sources s
  )
  select jsonb_build_object(
    'campaign_id', p.id, 'currency', p.currency, 'goal_minor', p.goal_minor,
    'raised_minor', t.raised, 'remaining_minor', greatest(0, p.goal_minor - t.raised),
    'completion_percent', case when p.goal_minor > 0 then round(100.0 * t.raised / p.goal_minor, 1) else 0 end,
    'sources', t.sources
  ) from campaign p cross join totals t;
$$;
revoke all on function public.get_public_celebration_progress(text) from public;
grant execute on function public.get_public_celebration_progress(text) to anon, authenticated, service_role;
