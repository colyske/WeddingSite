-- Organizers save FAQ and travel info through RLS-protected updates; column grants are required.
grant update (faq, travel_info) on public.weddings to authenticated;
