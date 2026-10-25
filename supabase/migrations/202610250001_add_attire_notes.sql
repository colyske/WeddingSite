-- Add attire_notes field to weddings table for dress code and attire guidance
alter table public.weddings add column if not exists attire_notes text check (attire_notes is null or length(attire_notes) <= 300) default '';

-- Index for updated_at to support ordering
create index if not exists idx_weddings_updated_at on public.weddings(updated_at desc);
