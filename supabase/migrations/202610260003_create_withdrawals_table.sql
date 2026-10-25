-- Create withdrawals table for payout requests
create table if not exists public.withdrawals (
  id uuid primary key default gen_random_uuid(),
  wedding_id uuid not null references public.weddings(id) on delete cascade,
  amount_minor integer not null check (amount_minor > 0),
  currency text not null,
  payout_method text not null,
  status text not null default 'pending',
  requested_at timestamp with time zone default now(),
  confirmed_at timestamp with time zone,
  processed_at timestamp with time zone,
  confirmation_token text,
  notes text,
  created_at timestamp with time zone default now(),
  updated_at timestamp with time zone default now()
);

-- Enable RLS
alter table public.withdrawals enable row level security;

-- Owner can request/view their own wedding withdrawals
create policy "owner_withdrawals" on public.withdrawals
  for select using (
    wedding_id in (
      select w.id from public.weddings w 
      where auth.uid() = w.owner_id
    )
  );

create policy "owner_request_withdrawal" on public.withdrawals
  for insert with check (
    wedding_id in (
      select w.id from public.weddings w 
      where auth.uid() = w.owner_id
    )
  );

-- SuperAdmin can view all withdrawals and update status
create policy "admin_all_withdrawals" on public.withdrawals
  for select using (
    exists(
      select 1 from auth.users 
      where auth.uid() = id and raw_user_meta_data->>'role' = 'superadmin'
    )
  );

create policy "admin_update_withdrawal" on public.withdrawals
  for update using (
    exists(
      select 1 from auth.users 
      where auth.uid() = id and raw_user_meta_data->>'role' = 'superadmin'
    )
  );

-- Indexes for performance
create index if not exists idx_withdrawals_wedding on public.withdrawals(wedding_id);
create index if not exists idx_withdrawals_status on public.withdrawals(status);
create index if not exists idx_withdrawals_created on public.withdrawals(created_at desc);
