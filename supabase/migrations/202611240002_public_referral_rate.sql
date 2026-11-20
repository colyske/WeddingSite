create function public.referral_public_rate() returns jsonb
language sql stable security definer set search_path='' set row_security=off as $$
  select jsonb_build_object(
    'enabled', p.enabled and p.first_effective_at is not null
      and p.first_effective_at <= statement_timestamp(),
    'rate_basis_points', case
      when p.enabled and p.first_effective_at is not null
        and p.first_effective_at <= statement_timestamp()
      then p.rate_basis_points
      else null
    end
  )
  from public.referral_policy p
  where p.singleton
$$;

revoke all on function public.referral_public_rate() from public, anon, authenticated, service_role;
grant execute on function public.referral_public_rate() to anon, authenticated;
