-- =============================================================================
-- 06_portal_access.sql — mkt_client_portal_access (+ RLS)
-- Maps a client-portal user's email to the client they may view.
-- =============================================================================

create table if not exists public.mkt_client_portal_access (
  id                  uuid primary key default gen_random_uuid(),
  client_id           uuid references public.mkt_clients(id) on delete cascade,
  email               text not null,
  magic_link_sent_at  timestamptz,
  last_login          timestamptz,
  active              boolean default true
);

alter table public.mkt_client_portal_access enable row level security;

drop policy if exists "mkt_cpa_admin_all" on public.mkt_client_portal_access;
create policy "mkt_cpa_admin_all" on public.mkt_client_portal_access
  for all using (public.mkt_is_admin()) with check (public.mkt_is_admin());

-- A portal user can see only their own access row(s).
drop policy if exists "mkt_cpa_self_read" on public.mkt_client_portal_access;
create policy "mkt_cpa_self_read" on public.mkt_client_portal_access
  for select using (email = (auth.jwt() ->> 'email'));
