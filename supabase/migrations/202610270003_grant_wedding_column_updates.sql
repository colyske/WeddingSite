-- Allow organizers (RLS still restricts rows to their own weddings) to update the new columns.
grant update (time_zone, attire_notes, background_music_url) on public.weddings to authenticated;
