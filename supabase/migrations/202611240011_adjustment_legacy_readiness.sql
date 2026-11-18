-- Legacy adjustment writers can still record observations after an inbox
-- item is processed. A later facilitator admission must not ignore an
-- incompatible observation just because the inbox item is no longer pending.
-- Callers must hold accounting lock 71110001 and inbox lock 71110002 in order.
create or replace function public.verified_adjustment_inbox_clear_for_payout() returns boolean
language sql stable security definer set search_path='' set row_security=off as $$
  select not exists(select 1 from public.verified_adjustment_inbox_conflicts)
    and not exists(select 1 from public.verified_adjustment_inbox i
      where not exists(select 1 from public.verified_adjustment_inbox_processed p where p.inbox_id=i.id))
    and not exists(
      select 1 from public.verified_adjustment_inbox i
      join public.provider_adjustment_events e on e.provider=i.provider
        and (e.provider_event_id=i.event_id or
          (e.provider_adjustment_id=i.adjustment_id
           and (e.event_type like 'refund.%' or e.event_type like 'charge.refund.%'
             or e.event_type='charge.refunded')
             = (i.event_type like 'refund.%' or i.event_type like 'charge.refund.%'
               or i.event_type='charge.refunded')))
      where (e.provider_event_id=i.event_id and
        (e.event_type,e.provider_adjustment_id,e.provider_payment_reference,e.amount_minor,
          e.currency::text,e.provider_state,e.occurred_at)
          is distinct from (i.event_type,i.adjustment_id,i.payment_reference,i.amount_minor,
            i.currency,i.provider_state,i.occurred_at))
        or (e.provider_adjustment_id=i.adjustment_id
          and (e.event_type like 'refund.%' or e.event_type like 'charge.refund.%'
            or e.event_type='charge.refunded')
            = (i.event_type like 'refund.%' or i.event_type like 'charge.refund.%'
              or i.event_type='charge.refunded')
          and (e.provider_payment_reference,e.amount_minor,e.currency::text)
            is distinct from (i.payment_reference,i.amount_minor,i.currency))
    )
$$;
