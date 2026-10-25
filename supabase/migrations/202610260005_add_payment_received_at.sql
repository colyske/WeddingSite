-- Add payment_received_at field to track when funds actually arrived (Paystack: 2-3 days)
alter table if exists public.contributions add column if not exists payment_received_at timestamp with time zone;

-- Add comment explaining the delay
comment on column public.contributions.payment_received_at is 'When funds actually arrived in account (Paystack takes 2-3 business days after payment_status becomes paid)';
