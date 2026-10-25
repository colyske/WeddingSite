-- List published weddings for browsing
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
as $$
  select
    id,
    slug,
    couple_names,
    wedding_date,
    currency,
    palette,
    published_at,
    created_at
  from public.weddings
  where published_at is not null
  order by 
    wedding_date asc nulls last,
    published_at desc
  offset p_offset
  limit p_limit;
$$;

grant execute on function public.list_published_weddings_paginated(integer, integer) to anon, authenticated;
