-- =============================================================================
-- 01_foundation.sql — admins table + RLS helper functions
-- Marketing Operations Platform. All objects prefixed mkt_. Run first.
-- Existing main-platform tables are NOT touched.
-- =============================================================================

create extension if not exists "pgcrypto";

-- Who may use the AGENCY view (Adrian). Everyone else is a client-portal user.
create table if not exists public.mkt_admins (
  email      text primary key,
  created_at timestamptz default now()
);
alter table public.mkt_admins enable row level security;

-- Is the current authenticated user an agency admin?
-- SECURITY DEFINER so it can read mkt_admins without tripping RLS recursion.
create or replace function public.mkt_is_admin()
returns boolean
language plpgsql stable security definer set search_path = public
as $$
begin
  return exists (
    select 1 from public.mkt_admins
    where email = (auth.jwt() ->> 'email')
  );
end;
$$;

-- The client_ids a (portal) user is allowed to read — via mkt_client_portal_access.
create or replace function public.mkt_user_client_ids()
returns setof uuid
language plpgsql stable security definer set search_path = public
as $$
begin
  return query
    select client_id from public.mkt_client_portal_access
    where email = (auth.jwt() ->> 'email') and active = true;
end;
$$;

-- Admins can read the admin list; writes are service-role/dashboard only.
drop policy if exists "mkt_admins_read" on public.mkt_admins;
create policy "mkt_admins_read" on public.mkt_admins
  for select using (public.mkt_is_admin());
