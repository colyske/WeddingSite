-- Add enabled_payment_methods column to weddings table to store list of payment methods guests can use
alter table if exists public.weddings add column if not exists enabled_payment_methods text[] default '{"mpesa", "stripe", "paystack"}';

-- Create index for faster queries
create index if not exists idx_weddings_enabled_payment_methods on public.weddings using gin(enabled_payment_methods);
