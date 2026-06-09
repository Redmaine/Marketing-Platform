-- =============================================================================
-- 08_invites.sql — mkt_invites (+ RLS). For the invite-send Edge Function.
-- =============================================================================

create table if not exists public.mkt_invites (
  id              uuid primary key default gen_random_uuid(),
  created_at      timestamptz default now(),
  token           text unique not null default encode(gen_random_bytes(16), 'hex'),
  recipient_name  text,
  business_name   text,
  recipient_email text,
  channel         text check (channel in ('email','whatsapp','both')) default 'email',
  status          text check (status in ('sent','accepted','expired')) default 'sent',
  sent_at         timestamptz
);

alter table public.mkt_invites enable row level security;

drop policy if exists "mkt_invites_admin_all" on public.mkt_invites;
create policy "mkt_invites_admin_all" on public.mkt_invites
  for all using (public.mkt_is_admin()) with check (public.mkt_is_admin());
