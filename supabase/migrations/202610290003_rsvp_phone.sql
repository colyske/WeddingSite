-- RSVP phone capture (optional, private: visible to wedding managers only via existing RLS).
alter table public.guest_rsvps add column if not exists phone text check (phone is null or phone ~ '^\+?[0-9 ()\-]{7,20}$');
create index if not exists guest_rsvps_wedding_phone_idx on public.guest_rsvps (wedding_id, phone) where phone is not null;
do $$ begin
  execute 'grant select (phone) on public.guest_rsvps to authenticated';
exception when others then null; end $$;
