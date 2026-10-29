-- KYC completeness follows the existing both-partner submission/consent model.
-- Publishing remains independent; no existing payout records are modified.
create or replace function public.request_payout(
  p_wedding_id uuid, p_amount_minor bigint, p_currency text, p_note text, p_confirmed boolean
) returns uuid language plpgsql security definer set search_path = '' set row_security = off
as $$
declare result_id uuid; available_minor bigint; workspace_currency char(3); minimum_minor bigint; maximum_minor bigint;
begin
  if not coalesce(p_confirmed, false) then raise exception 'Explicit confirmation is required to request a payout.'; end if;
  if not public.has_wedding_role(p_wedding_id, array['client']::public.workspace_role[]) then
    raise exception 'Only the Client or protected Owner may request a payout.';
  end if;
  if p_amount_minor < 1 or p_amount_minor > 100000000000 or p_currency !~ '^[A-Z]{3}$' then
    raise exception 'Invalid payout amount or currency.';
  end if;
  select currency into workspace_currency from public.weddings where id = p_wedding_id for update;
  if not found or workspace_currency <> upper(p_currency) then raise exception 'Payout currency must match the wedding currency.'; end if;
  perform 1 from public.wedding_kyc where wedding_id = p_wedding_id for share;
  if not public.kyc_is_complete(p_wedding_id) then
    raise exception 'PAYOUT_KYC_REQUIRED: Complete KYC to receive your payout.';
  end if;
  select min_payout_minor, max_payout_minor into minimum_minor, maximum_minor from public.platform_policies where id;
  if p_amount_minor < minimum_minor or p_amount_minor > maximum_minor then
    raise exception 'Payout request is outside the configured minimum or maximum.';
  end if;
  select coalesce(sum(c.net_paid_minor - c.provider_fee_minor)
      filter (where c.provider_fee_pending = false and (c.funds_available_at is null or c.funds_available_at <= now())), 0)
    + coalesce((select sum(l.couple_net_delta_minor) from public.financial_adjustment_ledger l
      where l.wedding_id = p_wedding_id and l.currency = upper(p_currency)), 0)
    - coalesce((select sum(a.hold_minor) from public.payment_adjustments a
      where a.wedding_id = p_wedding_id and a.currency = upper(p_currency)), 0)
    - coalesce((select sum(p.amount_minor) from public.payout_records p
      where p.wedding_id = p_wedding_id and p.currency = upper(p_currency)
        and p.status in ('requested', 'approved', 'sent')), 0)
    - coalesce((select sum(e.amount_minor) from public.expenses e
      where e.wedding_id = p_wedding_id and e.currency = upper(p_currency) and e.status in ('approved', 'paid')), 0)
  into available_minor
  from public.contributions c
  where c.wedding_id = p_wedding_id and c.currency = upper(p_currency)
    and c.payment_status = 'paid' and c.verified_provider_payment;
  if p_amount_minor > greatest(available_minor, 0) then
    raise exception 'Payout exceeds the settled net balance after provider fees, refunds, disputes and holds.';
  end if;
  insert into public.payout_records (wedding_id, amount_minor, currency, requested_by, note)
    values (p_wedding_id, p_amount_minor, p_currency, auth.uid(), left(p_note, 240))
    returning id into result_id;
  return result_id;
end $$;
revoke all on function public.request_payout(uuid, bigint, text, text, boolean) from public, anon;
grant execute on function public.request_payout(uuid, bigint, text, text, boolean) to authenticated;

create or replace function public.admin_set_payout_status(p_payout_id uuid, p_status text, p_note text default null)
returns boolean language plpgsql security definer set search_path = '' set row_security = off
as $$
declare p public.payout_records;
begin
  perform public.require_staff();
  if p_status not in ('approved', 'sent', 'cancelled') then raise exception 'Invalid payout status.'; end if;
  select * into p from public.payout_records where id = p_payout_id for update;
  if not found then raise exception 'Payout not found.'; end if;
  if p.requested_by = auth.uid() and p_status in ('approved', 'sent') then
    raise exception 'Another staff member must approve a payout you requested.';
  end if;
  if not ((p.status = 'requested' and p_status in ('approved', 'cancelled'))
       or (p.status = 'approved' and p_status in ('sent', 'cancelled'))) then
    raise exception 'A % payout cannot move to %.', p.status, p_status;
  end if;
  if p_status in ('approved', 'sent') then
    perform 1 from public.wedding_kyc where wedding_id = p.wedding_id for share;
    if not public.kyc_is_complete(p.wedding_id) then
      raise exception 'PAYOUT_KYC_REQUIRED: Complete KYC to receive your payout.';
    end if;
  end if;
  update public.payout_records set status = p_status::public.payout_status, confirmed_by = auth.uid(),
    confirmed_at = now(), note = coalesce(left(p_note, 240), note) where id = p_payout_id;
  insert into public.audit_events (wedding_id, actor_id, source, action, table_name, record_id, changed_fields)
  values (p.wedding_id, auth.uid(), 'user', 'payout_' || p_status, 'payout_records', p_payout_id::text, array['status']);
  return true;
end $$;
revoke all on function public.admin_set_payout_status(uuid, text, text) from public, anon;
grant execute on function public.admin_set_payout_status(uuid, text, text) to authenticated;
