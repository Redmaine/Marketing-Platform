-- =============================================================================
-- 02_clients.sql — mkt_clients (+ RLS)
-- =============================================================================

create table if not exists public.mkt_clients (
  id                       uuid primary key default gen_random_uuid(),
  created_at               timestamptz default now(),
  name                     text not null,
  short_name               text,
  industry                 text,
  location                 text,
  website                  text,
  contact_name             text,
  contact_email            text,
  tier                     text check (tier in ('visibility','growth','accelerate')),
  monthly_fee              numeric,
  billing_day              integer,
  tone_of_voice            text,
  key_services             text,
  target_customer          text,
  content_pillars          text[],
  post_days                text[],
  post_time                time,
  google_rating            numeric,
  review_count             integer,
  traffic_light            text check (traffic_light in ('green','amber','red')),
  next_task                text,
  buffer_profile_ids       jsonb,
  gbp_location_id          text,
  brand_primary_color      text,
  brand_secondary_color    text,
  logo_url                 text,
  website_score            integer,
  website_score_breakdown  jsonb,
  client_can_approve       boolean default false, -- portal approve/reject toggle
  active                   boolean default true
);

alter table public.mkt_clients enable row level security;

drop policy if exists "mkt_clients_admin_all" on public.mkt_clients;
create policy "mkt_clients_admin_all" on public.mkt_clients
  for all using (public.mkt_is_admin()) with check (public.mkt_is_admin());

drop policy if exists "mkt_clients_client_read" on public.mkt_clients;
create policy "mkt_clients_client_read" on public.mkt_clients
  for select using (id in (select public.mkt_user_client_ids()));
