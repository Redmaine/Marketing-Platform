-- =============================================================================
-- 05_reports_performance.sql — mkt_reports, mkt_performance
-- =============================================================================

create table if not exists public.mkt_reports (
  id              uuid primary key default gen_random_uuid(),
  created_at      timestamptz default now(),
  client_id       uuid references public.mkt_clients(id) on delete cascade,
  month           text,
  narrative       text,
  pdf_url         text,
  sent_to_client  boolean default false,
  sent_at         timestamptz,
  status          text check (status in ('draft','approved','sent')) default 'draft'
);

create table if not exists public.mkt_performance (
  id              uuid primary key default gen_random_uuid(),
  recorded_at     timestamptz default now(),
  client_id       uuid references public.mkt_clients(id) on delete cascade,
  week_start      date,
  reach           integer,
  impressions     integer,
  engagement      integer,
  new_reviews     integer,
  avg_rating      numeric,
  posts_published integer,
  ad_spend        numeric default 0
);

do $$
declare t text;
begin
  foreach t in array array['mkt_reports','mkt_performance']
  loop
    execute format('alter table public.%I enable row level security;', t);
    execute format('drop policy if exists "%s_admin_all" on public.%I;', t, t);
    execute format('create policy "%s_admin_all" on public.%I for all using (public.mkt_is_admin()) with check (public.mkt_is_admin());', t, t);
    execute format('drop policy if exists "%s_client_read" on public.%I;', t, t);
    execute format('create policy "%s_client_read" on public.%I for select using (client_id in (select public.mkt_user_client_ids()));', t, t);
  end loop;
end $$;
