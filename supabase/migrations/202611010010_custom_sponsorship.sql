-- Paid-only custom sponsorship for weddings without sponsor packages.
-- A separate BEFORE trigger (alphabetically before finalize_paid_checkout_action) completes
-- only purchase_data.custom sponsor rows; the existing finalizer and action constraint are unchanged.

create or replace function public.custom_sponsor_minimum_minor(p_currency text, p_fx_snapshot_id uuid, p_at timestamptz)
returns bigint language plpgsql stable security definer set search_path = '' set row_security = off
as $$
declare
  fx public.publication_fx_snapshots;
  v_target numeric;
  v_origin numeric;
begin
  if p_currency = 'KES' then return 500000; end if;
  select * into fx from public.publication_fx_snapshots where id = p_fx_snapshot_id;
  if not found or fx.published_at < p_at - interval '36 hours' or fx.published_at > p_at + interval '5 minutes' then
    return null;
  end if;
  v_target := nullif(fx.rates->>p_currency, '')::numeric;
  v_origin := nullif(fx.rates->>'KES', '')::numeric;
  if v_target is null or v_target <= 0 or v_origin is null or v_origin <= 0 then return null; end if;
  return ceil(round(5000 * v_target / v_origin, 6))::bigint * 100;
end $$;
revoke all on function public.custom_sponsor_minimum_minor(text, uuid, timestamptz) from public, anon, authenticated;

create or replace function public.finalize_custom_sponsorship()
returns trigger language plpgsql security definer set search_path = '' set row_security = off
as $$
declare
  d jsonb := coalesce(new.purchase_data, '{}'::jsonb);
  v_minimum bigint;
  v_company text := left(trim(coalesce(d->>'companyName', '')), 100);
  v_sponsor uuid;
begin
  if new.payment_status <> 'paid' or old.payment_status = 'paid'
      or new.purchase_action is distinct from 'sponsor' or coalesce(d->>'custom', '') <> 'true'
      or new.action_completed_at is not null then
    return new;
  end if;

  begin
    v_minimum := public.custom_sponsor_minimum_minor(new.currency, nullif(d->>'fxSnapshotId', '')::uuid, new.created_at);
    if v_minimum is null or nullif(d->>'customMinimumMinor', '')::bigint is distinct from v_minimum
        or new.paid_amount_minor < v_minimum or new.paid_amount_minor <> new.pledged_amount_minor
        or v_company = '' or d ? 'refId'
        or exists (select 1 from public.sponsor_tiers t where t.wedding_id = new.wedding_id) then
      raise exception 'custom_sponsorship_unavailable';
    end if;
    insert into public.sponsors (wedding_id, company_name, contact_email, contact_phone, website, amount_minor,
      tier_id, contribution_id, location, offer, public_contact, status)
    values (new.wedding_id, v_company, nullif(left(d->>'email', 200), ''),
      nullif(left(d->>'phone', 30), ''), nullif(left(d->>'website', 300), ''),
      new.paid_amount_minor, null, new.id,
      nullif(left(trim(d->>'location'), 160), ''), nullif(left(trim(d->>'offer'), 360), ''),
      coalesce((d->>'publicContact')::boolean, false), 'active')
    returning id into v_sponsor;
    new.action_result := jsonb_build_object('completed', true, 'kind', 'sponsor', 'custom', true, 'sponsorId', v_sponsor);
    new.action_completed_at := now();
  exception when others then
    -- Keep the verified payment; route the listing to the existing review queue.
    new.action_result := jsonb_build_object('completed', false, 'status', 'review_required');
    new.action_completed_at := null;
    insert into public.payment_action_reviews (contribution_id, wedding_id, reason_code)
      values (new.id, new.wedding_id, 'custom_sponsorship_review_required')
      on conflict (contribution_id) do nothing;
  end;
  return new;
end $$;
revoke all on function public.finalize_custom_sponsorship() from public, anon, authenticated;

drop trigger if exists finalize_custom_sponsorship on public.contributions;
create trigger finalize_custom_sponsorship
  before update of payment_status on public.contributions
  for each row execute function public.finalize_custom_sponsorship();
