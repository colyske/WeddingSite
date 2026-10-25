-- Sponsorship tiers: corporate contribution levels with perks
create table if not exists public.sponsor_tiers (
  id uuid primary key default gen_random_uuid(),
  wedding_id uuid not null references public.weddings(id) on delete cascade,
  name text not null check (length(name) between 1 and 60),
  min_amount_minor bigint not null check (min_amount_minor > 0),
  perks text not null check (length(perks) between 1 and 240),
  sort_order integer not null default 0,
  created_at timestamptz not null default now()
);
alter table public.sponsor_tiers enable row level security;
create policy sponsor_tiers_owner on public.sponsor_tiers
  for all using (exists(select 1 from public.weddings w where w.id = wedding_id and w.client_owner_id = auth.uid()))
  with check (exists(select 1 from public.weddings w where w.id = wedding_id and w.client_owner_id = auth.uid()));
create index idx_sponsor_tiers_wedding on public.sponsor_tiers(wedding_id);

-- VIP seating offerings: limited seats at premium price
create table if not exists public.vip_offers (
  id uuid primary key default gen_random_uuid(),
  wedding_id uuid not null references public.weddings(id) on delete cascade unique,
  title text not null check (length(title) between 1 and 80),
  description text check (description is null or length(description) <= 240),
  seats_total integer not null check (seats_total between 1 and 500),
  seats_sold integer not null default 0,
  price_minor bigint not null check (price_minor > 0),
  created_at timestamptz not null default now()
);
alter table public.vip_offers enable row level security;
create policy vip_offers_owner on public.vip_offers
  for all using (exists(select 1 from public.weddings w where w.id = wedding_id and w.client_owner_id = auth.uid()))
  with check (exists(select 1 from public.weddings w where w.id = wedding_id and w.client_owner_id = auth.uid()));

-- VIP seat reservations
create table if not exists public.vip_reservations (
  id uuid primary key default gen_random_uuid(),
  vip_offer_id uuid not null references public.vip_offers(id) on delete cascade,
  guest_name text not null check (length(guest_name) between 1 and 100),
  guest_email text,
  amount_minor bigint not null,
  contribution_id uuid references public.contributions(id) on delete set null,
  created_at timestamptz not null default now()
);
alter table public.vip_reservations enable row level security;
create policy vip_reservations_public on public.vip_reservations
  for select using (exists(select 1 from public.vip_offers vo where vo.id = vip_offer_id and public.is_published_wedding(vo.wedding_id)));

-- Corporate sponsors and their contributions
create table if not exists public.sponsors (
  id uuid primary key default gen_random_uuid(),
  wedding_id uuid not null references public.weddings(id) on delete cascade,
  company_name text not null check (length(company_name) between 1 and 100),
  contact_email text check (contact_email is null or length(contact_email) <= 200),
  contact_phone text check (contact_phone is null or length(contact_phone) <= 20),
  website text check (website is null or length(website) <= 300),
  amount_minor bigint not null check (amount_minor > 0),
  tier_id uuid references public.sponsor_tiers(id) on delete set null,
  contribution_id uuid references public.contributions(id) on delete set null,
  status text not null default 'active' check (status in ('active', 'hidden', 'removed')),
  created_at timestamptz not null default now()
);
alter table public.sponsors enable row level security;
create policy sponsors_owner on public.sponsors
  for all using (exists(select 1 from public.weddings w where w.id = wedding_id and w.client_owner_id = auth.uid()))
  with check (exists(select 1 from public.weddings w where w.id = wedding_id and w.client_owner_id = auth.uid()));
create policy sponsors_public on public.sponsors
  for select using (status = 'active' and exists(select 1 from public.weddings w where w.id = wedding_id and w.published_at is not null));
create index idx_sponsors_wedding on public.sponsors(wedding_id);
create index idx_sponsors_tier on public.sponsors(tier_id);
