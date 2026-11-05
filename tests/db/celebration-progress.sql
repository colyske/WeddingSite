-- Isolated local CI only; never run fixtures against production.
begin;
insert into auth.users(id, email, email_confirmed_at)
values ('60000000-0000-4000-8000-000000000221', 'cake@example.test', now());
insert into public.profiles(id, display_name)
values ('60000000-0000-4000-8000-000000000221', 'Cake fixture') on conflict do nothing;
insert into public.weddings(id, slug, client_owner_id, couple_names, welcome_story,
  guest_instructions, currency, wedding_date, public_location)
values ('61000000-0000-4000-8000-000000000221', 'cake-progress',
  '60000000-0000-4000-8000-000000000221', 'Cake fixture', 'Together, a little at a time.',
  'Please reply before the celebration.', 'KES', current_date + 30, 'Sample location');
insert into public.venues(wedding_id, name, event_date, event_time, address)
values ('61000000-0000-4000-8000-000000000221', 'Garden', current_date + 30, '12:00', 'Sample address');
insert into public.wedding_collection_capabilities(wedding_id, provider, currency, market)
values ('61000000-0000-4000-8000-000000000221', 'daraja', 'KES', 'KE');
update public.weddings set published_at = now() where slug = 'cake-progress';
insert into public.fundraising_streams(id, wedding_id, name, purpose, goal_minor, currency, sort_order, enabled, created_at)
values
  ('62000000-0000-4000-8000-000000000221', '61000000-0000-4000-8000-000000000221', 'Celebration', 'Together', 300000, 'KES', 0, true, '2026-01-01'),
  ('62000000-0000-4000-8000-000000000222', '61000000-0000-4000-8000-000000000221', 'Another fundraiser', 'Together', 100000, 'KES', 0, true, '2026-01-01'),
  ('62000000-0000-4000-8000-000000000223', '61000000-0000-4000-8000-000000000221', 'Disabled first', 'Together', 100000, 'KES', -1, false, '2026-01-01'),
  ('62000000-0000-4000-8000-000000000224', '61000000-0000-4000-8000-000000000221', 'Foreign first', 'Together', 100000, 'USD', -2, true, '2026-01-01');
insert into public.fundraising_milestones(id, wedding_id, stream_id, name, target_minor)
values ('64000000-0000-4000-8000-000000000221', '61000000-0000-4000-8000-000000000221',
  '62000000-0000-4000-8000-000000000221', 'Garden', 200000);

alter table public.contributions disable trigger user;
insert into public.contributions(id, wedding_id, stream_name, stream_id, milestone_id, pledged_amount_minor,
  paid_amount_minor, platform_fee_minor, net_paid_minor, currency, payment_status, display_name,
  provider_name, payment_environment, verified_provider_payment, paid_at, action_completed_at, purchase_action)
select ('63000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid,
  '61000000-0000-4000-8000-000000000221', 'Private payer sentinel',
  case when n = 1 then '62000000-0000-4000-8000-000000000221'::uuid
       when n = 7 then '62000000-0000-4000-8000-000000000222'::uuid end,
  case when n = 1 then '64000000-0000-4000-8000-000000000221'::uuid end,
  a, case when n = 12 then 0 else a end, 0,
  case when n in (11, 12) then 0 else a end,
  case when n = 8 then 'USD' else 'KES' end,
  case when n = 11 then 'refunded' when n = 12 then 'pending' else 'paid' end,
  'Never expose this payer', 'paystack', case when n = 10 then 'test' else 'live' end,
  n <> 9, now(), case when n <> 13 then now() end, action
from (values
  (1, 10000, 'fundraiser'), (2, 20000, 'registry'), (3, 30000, 'song_bid'),
  (4, 40000, 'sponsor'), (5, 50000, 'sponsor_featured_bid'), (6, 60000, 'vip'),
  (7, 5000, 'fundraiser'), (8, 999999, 'fundraiser'), (9, 999999, 'fundraiser'),
  (10, 999999, 'fundraiser'), (11, 999999, 'fundraiser'), (12, 999999, 'fundraiser'),
  (13, 999999, 'fundraiser'), (14, 999999, 'rsvp'), (15, 999999, null)
) f(n, a, action);
alter table public.contributions enable trigger user;

-- Assertions (also run after a populated predecessor upgrade).
do $$
declare payload jsonb := public.get_public_celebration_progress('cake-progress'); total bigint;
begin
  if payload->>'campaign_id' <> '62000000-0000-4000-8000-000000000221'
    or (payload->>'raised_minor')::bigint <> 215000
    or (payload->>'remaining_minor')::bigint <> 85000
    or (payload->>'completion_percent')::numeric <> 71.7
    or payload->>'currency' <> 'KES' then raise exception 'Authoritative aggregate/selection failed: %', payload; end if;
  if payload->'sources' <> '[{"key":"gifts","amount_minor":15000},{"key":"songs","amount_minor":30000},{"key":"registry","amount_minor":20000},{"key":"sponsors","amount_minor":90000},{"key":"vip","amount_minor":60000}]'::jsonb then
    raise exception 'Source attribution or exactly-once milestone failed: %', payload; end if;
  select sum((s->>'amount_minor')::bigint) into total from jsonb_array_elements(payload->'sources') s;
  if total <> (payload->>'raised_minor')::bigint or payload::text ~* 'payer|phone|email|reference|stream_name' then
    raise exception 'Sources do not reconcile or expose payer data'; end if;
  if public.get_public_celebration_progress('missing-wedding') is not null then raise exception 'Missing wedding exposed'; end if;
  if not has_function_privilege('anon', 'public.get_public_celebration_progress(text)', 'EXECUTE')
    or has_function_privilege('anon', 'public.displayable_contribution_amount(uuid)', 'EXECUTE') then
    raise exception 'Aggregate/private helper grants changed'; end if;
end $$;
set local role anon;
select public.get_public_celebration_progress('cake-progress');
reset role;

insert into public.payment_adjustments(provider, adjustment_kind, provider_adjustment_id, contribution_id,
  wedding_id, amount_minor, currency, status, hold_minor)
select 'paystack', kind, 'cake-adjustment-' || n,
  ('63000000-0000-4000-8000-' || lpad(payment::text, 12, '0'))::uuid,
  '61000000-0000-4000-8000-000000000221', amount, currency, status, hold
from (values
  (1, 1, 'refund', 2000, 'KES', 'processed', 0),
  (2, 1, 'dispute', 1000, 'KES', 'open', 1000),
  (3, 2, 'dispute', 3000, 'KES', 'lost', 0),
  (4, 3, 'refund', 500, 'KES', 'pending', 500),
  (5, 6, 'refund', 800, 'KES', 'review', 800),
  (6, 4, 'refund', 10000, 'KES', 'failed', 0),
  (7, 5, 'dispute', 10000, 'KES', 'won', 0),
  (8, 1, 'refund', 1000, 'EUR', 'processed', 0)
) f(n, payment, kind, amount, currency, status, hold);
do $$ begin
  if (public.get_public_celebration_progress('cake-progress')->>'raised_minor')::bigint <> 207700 then
    raise exception 'Refund/dispute/hold currency semantics differ from public contracts'; end if;
end $$;
update public.payment_adjustments set status = case when adjustment_kind = 'dispute' then 'won' else 'failed' end,
  hold_minor = 0 where provider_adjustment_id in ('cake-adjustment-2','cake-adjustment-3','cake-adjustment-4','cake-adjustment-5');
do $$ begin
  if (public.get_public_celebration_progress('cake-progress')->>'raised_minor')::bigint <> 213000 then
    raise exception 'Won/reinstated disputes or failed/reversed holds did not restore progress'; end if;
end $$;

-- Overlapping holds cannot make raised negative.
update public.payment_adjustments set status = 'review', hold_minor = 999999 where provider_adjustment_id = 'cake-adjustment-5';
do $$ begin
  if (public.get_public_celebration_progress('cake-progress')->>'raised_minor')::bigint <> 153000 then
    raise exception 'Adjusted gross must floor each payment at zero'; end if;
end $$;
update public.payment_adjustments set status = 'failed', hold_minor = 0 where provider_adjustment_id = 'cake-adjustment-5';
update public.fundraising_streams set goal_minor = 100000 where id = '62000000-0000-4000-8000-000000000221';
do $$ declare p jsonb := public.get_public_celebration_progress('cake-progress'); begin
  if (p->>'completion_percent')::numeric <> 213 or (p->>'remaining_minor')::bigint <> 0 then raise exception 'Over-goal total was clipped'; end if;
end $$;
alter table public.contributions disable trigger user;
update public.contributions set payment_status = 'refunded', net_paid_minor = 0 where wedding_id = '61000000-0000-4000-8000-000000000221';
alter table public.contributions enable trigger user;
do $$ declare p jsonb := public.get_public_celebration_progress('cake-progress'); begin
  if (p->>'raised_minor')::bigint <> 0 or (p->>'remaining_minor')::bigint <> 100000
    or exists(select 1 from jsonb_array_elements(p->'sources') s where (s->>'amount_minor')::bigint <> 0) then
    raise exception 'Zero aggregate was seeded'; end if;
end $$;
update public.weddings set revenue_features = jsonb_set(revenue_features, '{giving}', 'false') where slug = 'cake-progress';
do $$ begin
  if public.get_public_celebration_progress('cake-progress') is not null then raise exception 'Disabled giving exposed'; end if;
end $$;
update public.weddings set revenue_features = jsonb_set(revenue_features, '{giving}', 'true'), archived_at = now() where slug = 'cake-progress';
do $$ begin
  if public.get_public_celebration_progress('cake-progress') is not null then raise exception 'Archived wedding exposed'; end if;
end $$;
update public.weddings set archived_at = null, published_at = null where slug = 'cake-progress';
do $$ begin
  if public.get_public_celebration_progress('cake-progress') is not null then raise exception 'Draft wedding exposed'; end if;
end $$;
rollback;
