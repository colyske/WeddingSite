create or replace function public.place_dj_bid(
  p_wedding_id uuid, p_song_title text, p_artist_name text,
  p_bid_amount_minor bigint, p_bidder_name text
) returns table (status text, message text) language plpgsql security definer set search_path = '' set row_security = off
as $$
declare
  v_currency char(3);
  v_max bigint;
  v_song_title text := regexp_replace(trim(coalesce(p_song_title, '')), '[[:space:]]+', ' ', 'g');
  v_artist_name text := regexp_replace(trim(coalesce(p_artist_name, '')), '[[:space:]]+', ' ', 'g');
begin
  if auth.role() <> 'service_role' then raise exception 'Verified payment processing required.'; end if;
  if length(v_song_title) not between 1 and 160
     or length(v_artist_name) not between 1 and 100
     or length(coalesce(p_bidder_name, '')) > 100 then
    return query select 'invalid'::text, 'Please enter a song title and artist.'::text;
    return;
  end if;
  if not public.is_published_wedding(p_wedding_id) then
    return query select 'unavailable'::text, 'This wedding is not accepting song bids.'::text;
    return;
  end if;
  select w.currency, pp.max_contribution_minor into v_currency, v_max
    from public.weddings w, public.platform_policies pp where w.id = p_wedding_id and pp.id;
  if p_bid_amount_minor is null or p_bid_amount_minor < 1 or p_bid_amount_minor > v_max then
    return query select 'invalid'::text, 'Enter a valid bid amount.'::text;
    return;
  end if;
  insert into public.dj_song_bids (wedding_id, song_title, artist_name, bid_amount_minor, currency, bidder_name, status, payment_status)
    values (p_wedding_id, v_song_title, v_artist_name, p_bid_amount_minor, v_currency,
      coalesce(nullif(trim(p_bidder_name), ''), 'Guest'), 'submitted', 'paid');
  perform public.rank_dj_bids_for_wedding(p_wedding_id);
  return query select 'placed'::text, 'Your paid bid is on the leaderboard and supports the wedding fund.'::text;
end;
$$;
revoke all on function public.place_dj_bid(uuid, text, text, bigint, text) from public, anon, authenticated;
grant execute on function public.place_dj_bid(uuid, text, text, bigint, text) to service_role;

create or replace function public.get_dj_leaderboard(p_wedding_id uuid)
returns table (rank_position integer, song_title text, artist_name text, bid_amount_minor bigint, bid_count bigint, currency char(3))
language sql stable security definer set search_path = '' set row_security = off
as $$
  with normalized as (
    select b.song_title, b.artist_name, b.bid_amount_minor, b.currency,
      lower(regexp_replace(trim(b.song_title), '[[:space:]]+', ' ', 'g')) as title_key,
      lower(regexp_replace(trim(b.artist_name), '[[:space:]]+', ' ', 'g')) as artist_key
    from public.dj_song_bids b
    where b.wedding_id = p_wedding_id and b.payment_status = 'paid'
      and public.is_published_wedding(p_wedding_id)
  ), totals as (
    select min(song_title) as song_title, min(artist_name) as artist_name,
      sum(bid_amount_minor)::bigint as bid_amount_minor, min(currency) as currency,
      count(*)::bigint as bid_count, title_key, artist_key
    from normalized
    group by title_key, artist_key
  )
  select row_number() over (order by t.bid_amount_minor desc, t.title_key, t.artist_key)::integer,
    t.song_title, t.artist_name, t.bid_amount_minor, t.bid_count, t.currency
  from totals t order by t.bid_amount_minor desc, t.title_key, t.artist_key limit 25;
$$;
revoke all on function public.get_dj_leaderboard(uuid) from public;
grant execute on function public.get_dj_leaderboard(uuid) to anon, authenticated, service_role;
