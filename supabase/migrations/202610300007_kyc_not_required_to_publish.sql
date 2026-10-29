-- KYC is an account/payout eligibility requirement, not a wedding-site publishing requirement.
-- Payout and withdrawal KYC gating is unchanged.
create or replace function public.publish_wedding_with_fee(p_wedding_id uuid, p_confirmed boolean)
returns boolean language plpgsql security definer set search_path = ''
as $$
declare
  w public.weddings;
  q jsonb;
  v_fee bigint;
  v_staff boolean := coalesce(public.current_platform_role() in ('owner', 'superadmin', 'admin'), false);
begin
  if not coalesce(p_confirmed, false) then raise exception 'Explicit confirmation is required to publish a wedding.'; end if;
  select * into w from public.weddings where id = p_wedding_id for update;
  if not found then raise exception 'Wedding not found.'; end if;
  if auth.uid() is null or not (v_staff or w.client_owner_id = auth.uid()) then
    raise exception 'Only the Client or platform staff can publish this wedding.';
  end if;
  if w.lifecycle_admin_restricted and not v_staff then
    raise exception 'This wedding was unpublished or suspended by platform staff. Contact an Admin or Owner to republish it.';
  end if;
  if w.archived_at is not null then raise exception 'Restore the archived wedding before publishing.'; end if;
  if w.slug is null then raise exception 'Set a public web address (slug) before publishing.'; end if;
  if w.wedding_date is null then raise exception 'Set the wedding date before publishing.'; end if;
  if not exists (select 1 from public.venues v where v.wedding_id = p_wedding_id
      and v.event_time is not null and v.event_date is not null) then
    raise exception 'Add at least one wedding event with a date and time before publishing.';
  end if;
  q := public.publication_quote_internal(p_wedding_id);
  v_fee := (q->>'fee_minor')::bigint;
  if v_fee > 0 then
    if v_staff then
      insert into public.publication_fees (wedding_id, amount_minor, currency, status, paid_at, provider, reason_code)
      values (p_wedding_id, v_fee, w.currency, 'waived', now(), 'staff-waiver', q->>'code')
      on conflict (wedding_id) do update set status = 'waived', paid_at = now(), provider = 'staff-waiver';
    else
      insert into public.publication_fees (wedding_id, amount_minor, currency, status, reason_code)
      values (p_wedding_id, v_fee, w.currency, 'pending', q->>'code')
      on conflict (wedding_id) do update set amount_minor = excluded.amount_minor, reason_code = excluded.reason_code
        where public.publication_fees.status = 'pending';
      raise exception 'PAYMENT_REQUIRED: %', q->>'reason';
    end if;
  end if;
  update public.weddings set published_at = coalesce(published_at, now()), unpublished_at = null,
    lifecycle_admin_restricted = false, first_published_at = coalesce(first_published_at, now()) where id = p_wedding_id;
  return true;
end $$;
