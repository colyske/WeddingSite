-- Allow anonymous browsing without granting direct access to private wedding rows.
create or replace function public.list_published_weddings_paginated(
  p_offset integer default 0,
  p_limit integer default 12
)
returns table(
  id uuid,
  slug text,
  couple_names text,
  wedding_date timestamptz,
  currency text,
  palette text[],
  published_at timestamptz,
  created_at timestamptz
)
language sql
stable
security definer
set search_path = ''
set row_security = off
as $$
  select
    w.id,
    w.slug,
    w.couple_names,
    w.wedding_date::timestamptz,
    w.currency,
    w.palette,
    w.published_at,
    w.created_at
  from public.weddings as w
  where w.published_at is not null
  order by w.wedding_date asc nulls last, w.published_at desc
  offset greatest(coalesce(p_offset, 0), 0)
  limit least(greatest(coalesce(p_limit, 12), 1), 50);
$$;

revoke all on function public.list_published_weddings_paginated(integer, integer) from public;
grant execute on function public.list_published_weddings_paginated(integer, integer) to anon, authenticated;
