-- Add venues table and payout_details; auto-waive fees for testing
create table if not exists public.venues (
  id uuid primary key default extensions.gen_random_uuid(),
  wedding_id uuid not null references public.weddings(id) on delete cascade,
  name text not null check (length(name) between 1 and 100),
  event_time time,
  map_link text check (map_link is null or map_link ~ '^https?://'),
  description text check (description is null or length(description) <= 500),
  is_main boolean not null default false,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_venues_wedding on public.venues(wedding_id, sort_order);

-- Payout receiving details (e.g. M-Pesa, bank, Paystack account)
create table if not exists public.payout_preferences (
  wedding_id uuid primary key references public.weddings(id) on delete cascade,
  method text not null check (method in ('mpesa', 'bank_transfer', 'stripe', 'paystack', 'other')),
  details_encrypted text,
  display_mask text not null default '',
  verified boolean not null default false,
  verification_completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Enable RLS
alter table public.venues enable row level security;
create policy venues_select_owner on public.venues
  for select using (
    auth.uid() is not null and (
      public.current_platform_role() in ('owner', 'superadmin')
      or exists (select 1 from public.weddings w where w.id = wedding_id and w.client_owner_id = auth.uid())
    )
  );
create policy venues_insert_owner on public.venues
  for insert with check (
    auth.uid() is not null and (
      public.current_platform_role() in ('owner', 'superadmin')
      or exists (select 1 from public.weddings w where w.id = wedding_id and w.client_owner_id = auth.uid())
    )
  );
create policy venues_update_owner on public.venues
  for update using (
    auth.uid() is not null and (
      public.current_platform_role() in ('owner', 'superadmin')
      or exists (select 1 from public.weddings w where w.id = wedding_id and w.client_owner_id = auth.uid())
    )
  );
create policy venues_delete_owner on public.venues
  for delete using (
    auth.uid() is not null and (
      public.current_platform_role() in ('owner', 'superadmin')
      or exists (select 1 from public.weddings w where w.id = wedding_id and w.client_owner_id = auth.uid())
    )
  );

alter table public.payout_preferences enable row level security;
create policy payout_pref_owner on public.payout_preferences
  for all using (
    auth.uid() is not null and (
      public.current_platform_role() in ('owner', 'superadmin')
      or exists (select 1 from public.weddings w where w.id = wedding_id and w.client_owner_id = auth.uid())
    )
  );

-- Update publish_wedding_with_fee to handle missing/pending fees more gracefully
create or replace function public.publish_wedding_with_fee(p_wedding_id uuid, p_confirmed boolean)
returns boolean language plpgsql security definer set search_path = ''
as $$
declare
  v_fee bigint;
  v_currency char(3);
  v_slug text;
  v_status text;
begin
  if not coalesce(p_confirmed, false) then
    raise exception 'Explicit confirmation is required to publish a wedding.';
  end if;
  if auth.uid() is null or not (
    public.current_platform_role() in ('owner', 'superadmin')
    or exists (select 1 from public.weddings w where w.id = p_wedding_id and w.client_owner_id = auth.uid())
  ) then
    raise exception 'Only the Client or platform staff can publish this wedding.';
  end if;

  select pp.publication_fee_minor, w.currency, w.slug into v_fee, v_currency, v_slug
  from public.platform_policies pp, public.weddings w
  where pp.id and w.id = p_wedding_id for update of w;
  if v_currency is null then raise exception 'Wedding not found.'; end if;
  if v_slug is null then raise exception 'Set a public web address (slug) before publishing.'; end if;

  select pf.status into v_status from public.publication_fees pf where pf.wedding_id = p_wedding_id;
  if v_fee > 0 and coalesce(v_status, 'pending') not in ('paid', 'waived') then
    if public.current_platform_role() in ('owner', 'superadmin') then
      insert into public.publication_fees (wedding_id, amount_minor, currency, status, paid_at)
      values (p_wedding_id, v_fee, v_currency, 'waived', now())
      on conflict (wedding_id) do update set status = 'waived', paid_at = now();
    else
      insert into public.publication_fees (wedding_id, amount_minor, currency, status)
      values (p_wedding_id, v_fee, v_currency, 'pending') on conflict do nothing;
      raise exception 'The publication fee must be paid or waived by platform staff before publishing.';
    end if;
  end if;

  update public.weddings set published_at = coalesce(published_at, now()) where id = p_wedding_id;
  return true;
end;
$$;

grant execute on function public.publish_wedding_with_fee(uuid, boolean) to authenticated;
