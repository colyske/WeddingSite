-- Public amounts are confirmed paid minor units; preserve consent and anonymity.
alter table public.platform_policies add column enabled_payment_providers text[] not null
  default array['stripe','paystack','daraja']::text[]
  check (enabled_payment_providers <@ array['stripe','paystack','daraja']::text[]
    and array_position(enabled_payment_providers, null) is null);

create function public.admin_get_payment_controls() returns text[]
language plpgsql stable security definer set search_path = '' set row_security = off as $$
begin
  perform public.require_staff();
  return (select enabled_payment_providers from public.platform_policies where id);
end $$;
revoke all on function public.admin_get_payment_controls() from public, anon;
grant execute on function public.admin_get_payment_controls() to authenticated;

create function public.admin_set_payment_controls(p_enabled text[], p_confirmed boolean default false) returns boolean
language plpgsql security definer set search_path = '' set row_security = off as $$
declare previous jsonb;
begin
  perform public.require_staff();
  if not coalesce(p_confirmed, false) or p_enabled is null
    or not (p_enabled <@ array['stripe','paystack','daraja']::text[])
    or array_position(p_enabled, null) is not null then
    raise exception 'Choose valid payment methods and confirm the change.';
  end if;
  select to_jsonb(p) into previous from public.platform_policies p where id for update;
  update public.platform_policies set enabled_payment_providers = p_enabled, updated_by = auth.uid(), updated_at = now() where id;
  if not found then raise exception 'Platform payment policy is unavailable.'; end if;
  insert into public.platform_policy_history (changed_by, old_values, new_values)
    select auth.uid(), previous - 'updated_by', to_jsonb(p) - 'updated_by' from public.platform_policies p where id;
  insert into public.audit_events (actor_id, source, action, table_name, record_id, changed_fields)
    values (auth.uid(), 'user', 'payment_methods_changed', 'platform_policies', 'true', array['enabled_payment_providers']);
  return true;
end $$;
revoke all on function public.admin_set_payment_controls(text[], boolean) from public, anon;
grant execute on function public.admin_set_payment_controls(text[], boolean) to authenticated;

create function public.guard_new_checkout_provider() returns trigger
language plpgsql security definer set search_path = '' set row_security = off as $$
declare enabled text[];
begin
  if new.payment_status = 'pending' and new.provider_name in ('stripe','paystack','daraja') then
    select enabled_payment_providers into enabled from public.platform_policies where id for share;
    if enabled is null or not (new.provider_name = any(enabled)) then
      raise exception 'This payment method has been disabled. Reload the payment options.' using errcode = '23514';
    end if;
  end if;
  return new;
end $$;
create trigger guard_new_checkout_provider before insert on public.contributions
  for each row execute function public.guard_new_checkout_provider();

drop function public.get_published_contributions_page(uuid, integer, integer);
create function public.get_published_contributions_page(
  p_wedding_id uuid, p_offset integer default 0, p_limit integer default 10
) returns table (
  guest_display_name text, pledged_amount_minor bigint, paid_amount_minor bigint,
  currency char(3), payment_status text, created_at timestamptz, contribution_type text
) language sql stable security definer set search_path = ''
as $$
  select case when c.visibility = 'anonymous' then 'Anonymous' else c.display_name end,
    c.paid_amount_minor, c.paid_amount_minor, c.currency, 'paid'::text, coalesce(c.paid_at, c.created_at),
    case c.purchase_action when 'song_bid' then 'Song bid' when 'rsvp' then 'RSVP'
      when 'vip' then 'VIP reservation' when 'sponsor' then 'Sponsorship'
      when 'sponsor_featured_bid' then 'Featured sponsorship' when 'registry' then 'Registry gift'
      when 'fundraiser' then c.stream_name else coalesce(c.stream_name, 'Contribution') end
  from public.contributions c
  where c.wedding_id = p_wedding_id and c.payment_status = 'paid'
    and public.is_published_wedding(p_wedding_id)
    and c.visibility in ('name', 'anonymous') and c.public_consent_at is not null
  order by c.paid_at desc nulls last limit least(greatest(coalesce(p_limit, 10), 1), 50)
  offset greatest(coalesce(p_offset, 0), 0);
$$;

-- Reserve the virtual sample outside all real wedding/finance tables.
alter table public.weddings add constraint weddings_reserved_showcase_slug
  check (lower(slug) <> 'showcase-wedding') not valid;

create function public.free_text_has_contact(p_text text) returns boolean
language plpgsql immutable set search_path = '' as $$
declare normalized text := lower(coalesce(p_text, '')); candidate text; digits text;
  words text[] := array['zero','one','two','three','four','five','six','seven','eight','nine'];
  i integer;
begin
  normalized := regexp_replace(normalized, '\s*(\[at\]|\(at\)|\s+at\s+)\s*', '@', 'g');
  normalized := regexp_replace(normalized, '\s*(\[dot\]|\(dot\)|\s+dot\s+)\s*', '.', 'g');
  if normalized ~ '[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}' then return true; end if;
  for i in 1..10 loop
    normalized := regexp_replace(normalized, '\m' || words[i] || '\M', (i - 1)::text, 'g');
  end loop;
  for candidate in select m[1] from regexp_matches(normalized, '(\+?[0-9][0-9 ().-]{7,}[0-9])', 'g') m loop
    digits := regexp_replace(candidate, '[^0-9]', '', 'g');
    if length(digits) between 9 and 15 and (candidate like '+%' or digits like '0%' or digits like '254%') then
      return true;
    end if;
  end loop;
  return false;
end $$;

create function public.content_has_contact(p_value jsonb, p_check boolean default false) returns boolean
language plpgsql immutable set search_path = '' as $$
declare k text; v jsonb; check_child boolean;
begin
  if jsonb_typeof(p_value) = 'string' then return p_check and public.free_text_has_contact(p_value #>> '{}'); end if;
  if jsonb_typeof(p_value) = 'array' then
    for v in select value from jsonb_array_elements(p_value) loop
      if public.content_has_contact(v, p_check) then return true; end if;
    end loop;
  elsif jsonb_typeof(p_value) = 'object' then
    for k, v in select key, value from jsonb_each(p_value) loop
      if lower(k) in ('sociallinks', 'social_links') then continue; end if;
      check_child := replace(replace(lower(k), '_', ''), '-', '') = any(array[
        'name','displayname','couplenames','guestname','companyname','contactname','authorname','songtitle',
        'artist','artistname','title','description','message','notes','note','welcomestory','storydraft','story',
        'attirenotes','dietarynotes','partynames','location','publiclocation','address','offer','purpose','perks',
        'travel','travelnotes','travelinfo','question','answer','q','a','label','palettenames','task','minutes',
        'announcement','content','details','nextofkinname','relation','category','campaign','milestone','vendor',
        'vendorname','tablename','subject','reason']);
      if public.content_has_contact(v, check_child) then return true; end if;
    end loop;
  end if;
  return false;
end $$;

create function public.guard_content_contacts() returns trigger
language plpgsql set search_path = '' as $$
declare changed jsonb := to_jsonb(new);
begin
  if tg_op = 'UPDATE' then
    select coalesce(jsonb_object_agg(n.key, n.value), '{}'::jsonb) into changed
      from jsonb_each(changed) n where n.value is distinct from to_jsonb(old)->n.key;
  end if;
  if public.content_has_contact(changed) then
    raise exception 'Use the designated contact fields for phone numbers and email addresses.' using errcode = '23514';
  end if;
  return new;
end $$;

do $$
declare table_name text;
begin
  foreach table_name in array array['weddings','guest_site_content','guest_rsvps','dj_song_bids',
    'guest_wishes','sponsors','sponsor_enquiries','sponsor_tiers','vip_offers','registry_items','venues',
    'fundraising_streams','fundraising_milestones','tasks','budget_lines','expenses','contributions','guests'] loop
    execute format('create trigger guard_content_contacts before insert or update on public.%I for each row execute function public.guard_content_contacts()', table_name);
  end loop;
end $$;
revoke all on function public.get_published_contributions_page(uuid, integer, integer) from public;
grant execute on function public.get_published_contributions_page(uuid, integer, integer) to anon, authenticated;

drop function public.admin_ledger(integer);
create function public.admin_ledger(p_limit integer default 200) returns table (
  id uuid, couple_names text, stream_name text, amount_minor bigint, fee_minor bigint, net_minor bigint,
  currency text, status text, provider text, created_at timestamptz, contributor text
) language plpgsql stable security definer set search_path = '' set row_security = off
as $$
begin
  perform public.require_staff();
  return query select c.id, w.couple_names, c.stream_name,
    case when c.payment_status in ('paid', 'refunded') then c.paid_amount_minor else c.pledged_amount_minor end,
    c.platform_fee_minor, c.net_paid_minor, c.currency::text, c.payment_status::text,
    c.provider_name, c.created_at, coalesce(c.display_name, 'Anonymous')
  from public.contributions c join public.weddings w on w.id = c.wedding_id
  order by c.created_at desc limit least(greatest(coalesce(p_limit, 200), 1), 500);
end $$;
revoke all on function public.admin_ledger(integer) from public, anon;
grant execute on function public.admin_ledger(integer) to authenticated;

alter table public.sponsors add column if not exists social_links jsonb not null default '{}'::jsonb
  check (jsonb_typeof(social_links) = 'object');
alter table public.sponsor_enquiries add column if not exists social_links jsonb not null default '{}'::jsonb
  check (jsonb_typeof(social_links) = 'object');

create function public.sponsor_social_links_from_payment() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.contribution_id is not null then
    select coalesce(c.purchase_data->'socialLinks', '{}'::jsonb) into new.social_links
    from public.contributions c where c.id = new.contribution_id;
  end if;
  return new;
end $$;
create trigger sponsor_social_links_from_payment before insert on public.sponsors
  for each row execute function public.sponsor_social_links_from_payment();

create or replace function public.review_sponsor_enquiry(p_enquiry_id uuid, p_approved boolean)
returns boolean language plpgsql security definer set search_path = '' set row_security = off
as $$
declare enquiry public.sponsor_enquiries; allow_in_kind boolean;
begin
  select * into enquiry from public.sponsor_enquiries where id = p_enquiry_id for update;
  if not found then raise exception 'Sponsor enquiry not found.'; end if;
  if not public.has_wedding_role(enquiry.wedding_id, array['client']::public.workspace_role[]) then
    raise exception 'Only this wedding organizer can review the enquiry.';
  end if;
  if enquiry.status <> 'pending' then raise exception 'This sponsor enquiry has already been reviewed.'; end if;
  select w.allow_in_kind_sponsorship into allow_in_kind from public.weddings w where w.id = enquiry.wedding_id for update;
  if p_approved and not coalesce(allow_in_kind, false) then raise exception 'In-kind sponsor enquiries are currently disabled for this wedding.'; end if;
  update public.sponsor_enquiries set status = case when p_approved then 'approved' else 'declined' end where id = enquiry.id;
  if p_approved then
    insert into public.sponsors (wedding_id, company_name, contact_email, contact_phone, amount_minor,
      location, offer, public_contact, in_kind, status, social_links)
    values (enquiry.wedding_id, enquiry.company_name, enquiry.contact_email, enquiry.contact_phone, 0,
      enquiry.location, enquiry.offer, enquiry.public_contact, true, 'active', enquiry.social_links);
  end if;
  insert into public.audit_events (wedding_id, actor_id, source, action, table_name, record_id, changed_fields)
    values (enquiry.wedding_id, auth.uid(), 'user',
      case when p_approved then 'sponsor_enquiry_approved' else 'sponsor_enquiry_declined' end,
      'sponsor_enquiries', enquiry.id::text, array['status']);
  return true;
end $$;

create or replace function public.get_public_fundraising(p_slug text)
returns jsonb language sql stable security definer set search_path = ''
as $$
  select jsonb_build_object(
    'tiers', coalesce((select jsonb_agg(jsonb_build_object(
      'id', t.id, 'name', t.name, 'min_amount_minor', t.min_amount_minor, 'perks', t.perks
    ) order by t.sort_order, t.created_at) from public.sponsor_tiers t where t.wedding_id = w.id), '[]'::jsonb),
    'vip', (select jsonb_build_object('id', v.id, 'title', v.title, 'description', v.description,
      'seats_total', v.seats_total, 'seats_sold', (select count(*) from public.vip_reservations vr
        join public.contributions c on c.id = vr.contribution_id
        where vr.vip_offer_id = v.id and vr.payment_status = 'paid' and c.payment_status = 'paid' and c.verified_provider_payment),
      'price_minor', v.price_minor) from public.vip_offers v where v.wedding_id = w.id limit 1),
    'sponsors', coalesce((select jsonb_agg(jsonb_build_object(
      'id', s.id, 'company_name', s.company_name, 'location', s.location, 'offer', s.offer,
      'website', s.website, 'social_links', s.social_links, 'amount_minor', s.amount_minor,
      'in_kind', s.in_kind, 'public_contact', s.public_contact,
      'contact_email', case when s.public_contact then s.contact_email else null end,
      'contact_phone', case when s.public_contact then s.contact_phone else null end
    ) order by s.amount_minor desc, s.created_at) from public.sponsors s
      left join public.contributions c on c.id = s.contribution_id
      where s.wedding_id = w.id and s.status = 'active'
        and (s.in_kind and s.contribution_id is null or c.payment_status = 'paid' and c.verified_provider_payment)), '[]'::jsonb)
  ) from public.weddings w where w.slug = lower(p_slug) and w.published_at is not null and w.archived_at is null;
$$;
