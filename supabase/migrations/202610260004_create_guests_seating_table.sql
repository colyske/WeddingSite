-- Create guests and seating table for persisting imported guest lists
create table if not exists public.guests (
  id uuid primary key default gen_random_uuid(),
  wedding_id uuid not null references public.weddings(id) on delete cascade,
  name text not null,
  email text,
  dietary_preference text,
  table_number text,
  rsvp_status text default 'invited',
  plus_ones integer default 0,
  created_at timestamp with time zone default now(),
  updated_at timestamp with time zone default now()
);

-- Enable RLS
alter table public.guests enable row level security;

-- Owner can view/manage their wedding's guests
create policy "owner_guests" on public.guests
  for select using (
    wedding_id in (
      select w.id from public.weddings w 
      where auth.uid() = w.owner_id
    )
  );

create policy "owner_manage_guests" on public.guests
  for insert with check (
    wedding_id in (
      select w.id from public.weddings w 
      where auth.uid() = w.owner_id
    )
  );

create policy "owner_update_guests" on public.guests
  for update using (
    wedding_id in (
      select w.id from public.weddings w 
      where auth.uid() = w.owner_id
    )
  );

-- Guests can see their own record if they've RSVPed
create policy "guest_own_record" on public.guests
  for select using (
    email = auth.jwt() ->> 'email'
  );

-- Indexes
create index if not exists idx_guests_wedding on public.guests(wedding_id);
create index if not exists idx_guests_email on public.guests(email);
create index if not exists idx_guests_table on public.guests(table_number);
