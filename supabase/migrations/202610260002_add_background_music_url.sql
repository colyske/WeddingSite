-- Add background_music_url column to weddings table for ceremony/ambient music
alter table if exists public.weddings add column if not exists background_music_url text;
