-- Group RSVP: optional names of the people in a guest's party (visible to wedding managers only).
alter table public.guest_rsvps add column if not exists party_names text check (party_names is null or char_length(party_names) <= 400);
do $$ begin
  execute 'grant select (party_names) on public.guest_rsvps to authenticated';
exception when others then null; end $$;
-- Seating lookup matches on the guest-list email.
create index if not exists guests_wedding_email_idx on public.guests (wedding_id, lower(email)) where email is not null;
