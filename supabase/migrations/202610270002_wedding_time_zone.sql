-- Adds an IANA time zone to each wedding (existing rows default to Africa/Nairobi). Idempotent and additive.
alter table public.weddings add column if not exists time_zone text not null default 'Africa/Nairobi';
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'weddings_time_zone_format') then
    alter table public.weddings add constraint weddings_time_zone_format check (time_zone ~ '^[A-Za-z0-9_+\-]+(/[A-Za-z0-9_+\-]+){0,2}$' and length(time_zone) <= 64);
  end if;
end $$;
create or replace function public.get_public_wedding_site(p_slug text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'id', w.id,
    'slug', w.slug,
    'couple_names', w.couple_names,
    'welcome_story', w.welcome_story,
    'wedding_date', w.wedding_date,
    'public_location', w.public_location,
    'currency', w.currency,
    'max_guest_capacity', w.max_guest_capacity,
    'palette', to_jsonb(w.palette),
    'attire_notes', w.attire_notes,
    'time_zone', w.time_zone,
    'background_music_url', w.background_music_url,
    'accepting_rsvps', (
      select coalesce(sum(1 + r.plus_one_count), 0) < w.max_guest_capacity
      from public.guest_rsvps r
      where r.wedding_id = w.id and r.attendance_status = 'yes'
    ),
    'venues', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', v.id, 'name', v.name, 'event_time', v.event_time,
        'map_link', v.map_link, 'description', v.description, 'is_main', v.is_main
      ) order by v.sort_order, v.created_at)
      from public.venues v where v.wedding_id = w.id
    ), '[]'::jsonb),
    'registry', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', ri.id, 'name', ri.name, 'description', ri.description,
        'category', ri.category, 'target_amount_minor', ri.target_amount_minor,
        'notes', ri.notes, 'amount_raised_minor', coalesce((
          select sum(c.paid_amount_minor)
          from public.contributions c
          where c.wedding_id = w.id and c.stream_name = ri.name and c.payment_status = 'paid'
        ), 0)
      ) order by ri.sort_order, ri.created_at)
      from public.registry_items ri where ri.wedding_id = w.id
    ), '[]'::jsonb)
  )
  from public.weddings w
  where w.slug = lower(p_slug) and w.published_at is not null;
$$;

grant execute on function public.get_public_wedding_site(text) to anon, authenticated;

