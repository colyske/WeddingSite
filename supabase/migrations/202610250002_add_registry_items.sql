-- Add registry table for crowdfunding milestones and gift items
create table if not exists public.registry_items (
  id uuid primary key default extensions.gen_random_uuid(),
  wedding_id uuid not null references public.weddings(id) on delete cascade,
  name text not null check (length(name) between 1 and 100),
  description text check (description is null or length(description) <= 240),
  category text check (category is null or length(category) <= 50),
  target_amount_minor bigint not null check (target_amount_minor > 0),
  notes text check (notes is null or length(notes) <= 240),
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_registry_wedding on public.registry_items(wedding_id, sort_order);

-- RLS for registry items
alter table public.registry_items enable row level security;
create policy registry_select_owner on public.registry_items
  for select using (
    auth.uid() is not null and (
      public.current_platform_role() in ('owner', 'superadmin')
      or exists (select 1 from public.weddings w where w.id = wedding_id and w.client_owner_id = auth.uid())
    )
  );
create policy registry_insert_owner on public.registry_items
  for insert with check (
    auth.uid() is not null and (
      public.current_platform_role() in ('owner', 'superadmin')
      or exists (select 1 from public.weddings w where w.id = wedding_id and w.client_owner_id = auth.uid())
    )
  );
create policy registry_update_owner on public.registry_items
  for update using (
    auth.uid() is not null and (
      public.current_platform_role() in ('owner', 'superadmin')
      or exists (select 1 from public.weddings w where w.id = wedding_id and w.client_owner_id = auth.uid())
    )
  );
create policy registry_delete_owner on public.registry_items
  for delete using (
    auth.uid() is not null and (
      public.current_platform_role() in ('owner', 'superadmin')
      or exists (select 1 from public.weddings w where w.id = wedding_id and w.client_owner_id = auth.uid())
    )
  );

-- RPC to get registry with totals (guests see only gross amounts, not fees)
create or replace function public.get_registry_with_totals(p_wedding_id uuid)
returns table (
  id uuid,
  name text,
  description text,
  category text,
  target_amount_minor bigint,
  notes text,
  raised_amount_minor bigint,
  raised_count integer,
  progress_percent numeric,
  currency char(3)
) language plpgsql security definer set search_path = ''
as $$
declare
  v_currency char(3);
begin
  select currency into v_currency from public.weddings where id = p_wedding_id;
  if v_currency is null then return; end if;

  return query
  select
    ri.id,
    ri.name,
    ri.description,
    ri.category,
    ri.target_amount_minor,
    ri.notes,
    coalesce(sum(c.paid_amount_minor) filter (where c.payment_status = 'paid'), 0)::bigint as raised_amount_minor,
    count(c.id) filter (where c.payment_status = 'paid')::integer as raised_count,
    case when ri.target_amount_minor > 0
      then round(100.0 * coalesce(sum(c.paid_amount_minor) filter (where c.payment_status = 'paid'), 0) / ri.target_amount_minor, 1)
      else 0
    end as progress_percent,
    v_currency
  from public.registry_items ri
  left join public.contributions c on c.wedding_id = ri.wedding_id 
    and c.stream_name = ri.name 
    and c.payment_status = 'paid'
  where ri.wedding_id = p_wedding_id
  group by ri.id, ri.name, ri.description, ri.category, ri.target_amount_minor, ri.notes
  order by ri.sort_order asc, ri.created_at asc;
end;
$$;

grant execute on function public.get_registry_with_totals(uuid) to authenticated, anon;
