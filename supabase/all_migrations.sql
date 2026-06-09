-- ALL MIGRATIONS — YCA Marketing Operations. Run once in the Supabase SQL editor.
-- mkt_-prefixed tables only; existing tables untouched.


-- ===== migrations/01_foundation.sql =====
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


-- ===== migrations/02_clients.sql =====
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


-- ===== migrations/03_content.sql =====
-- =============================================================================
-- 03_content.sql — mkt_content_queue, mkt_scheduled_posts, mkt_published_posts
-- =============================================================================

create table if not exists public.mkt_content_queue (
  id              uuid primary key default gen_random_uuid(),
  created_at      timestamptz default now(),
  client_id       uuid references public.mkt_clients(id) on delete cascade,
  platform        text check (platform in ('facebook','instagram','google_business','blog','ad_facebook','ad_google')),
  content_type    text check (content_type in ('post','review_response','ad','blog')),
  pillar          text,
  body            text not null,
  status          text check (status in ('pending','approved','scheduled','published','rejected')) default 'pending',
  scheduled_for   timestamptz,
  buffer_update_id text,
  approved_at     timestamptz,
  approved_by     text,
  generated_by    text check (generated_by in ('ai','human','cron'))
);

create table if not exists public.mkt_scheduled_posts (
  id               uuid primary key default gen_random_uuid(),
  created_at       timestamptz default now(),
  client_id        uuid references public.mkt_clients(id) on delete cascade,
  content_queue_id uuid references public.mkt_content_queue(id),
  platform         text,
  body             text,
  scheduled_for    timestamptz,
  buffer_update_id text,
  status           text check (status in ('scheduled','sent','failed'))
);

create table if not exists public.mkt_published_posts (
  id               uuid primary key default gen_random_uuid(),
  published_at     timestamptz,
  client_id        uuid references public.mkt_clients(id) on delete cascade,
  platform         text,
  body             text,
  reach            integer,
  impressions      integer,
  engagement       integer,
  clicks           integer,
  buffer_update_id text
);

-- RLS: admin full; client read-only of their own rows.
do $$
declare t text;
begin
  foreach t in array array['mkt_content_queue','mkt_scheduled_posts','mkt_published_posts']
  loop
    execute format('alter table public.%I enable row level security;', t);
    execute format('drop policy if exists "%s_admin_all" on public.%I;', t, t);
    execute format('create policy "%s_admin_all" on public.%I for all using (public.mkt_is_admin()) with check (public.mkt_is_admin());', t, t);
    execute format('drop policy if exists "%s_client_read" on public.%I;', t, t);
    execute format('create policy "%s_client_read" on public.%I for select using (client_id in (select public.mkt_user_client_ids()));', t, t);
  end loop;
end $$;


-- ===== migrations/04_reviews_tasks.sql =====
-- =============================================================================
-- 04_reviews_tasks.sql — mkt_reviews, mkt_tasks
-- =============================================================================

create table if not exists public.mkt_reviews (
  id              uuid primary key default gen_random_uuid(),
  created_at      timestamptz default now(),
  client_id       uuid references public.mkt_clients(id) on delete cascade,
  platform        text check (platform in ('google','facebook','trustpilot')),
  reviewer_name   text,
  rating          integer check (rating between 1 and 5),
  body            text,
  review_date     date,
  response_body   text,
  response_status text check (response_status in ('pending','drafted','published')) default 'pending',
  gbp_review_id   text
);

create table if not exists public.mkt_tasks (
  id           uuid primary key default gen_random_uuid(),
  created_at   timestamptz default now(),
  client_id    uuid references public.mkt_clients(id) on delete cascade,
  task         text not null,
  task_type    text check (task_type in ('generate_posts','review_response','schedule_posts','ads_check','report_due','gbp_post')),
  priority     integer default 2,
  overdue      boolean default false,
  due_date     date,
  completed    boolean default false,
  completed_at timestamptz
);

do $$
declare t text;
begin
  foreach t in array array['mkt_reviews','mkt_tasks']
  loop
    execute format('alter table public.%I enable row level security;', t);
    execute format('drop policy if exists "%s_admin_all" on public.%I;', t, t);
    execute format('create policy "%s_admin_all" on public.%I for all using (public.mkt_is_admin()) with check (public.mkt_is_admin());', t, t);
    execute format('drop policy if exists "%s_client_read" on public.%I;', t, t);
    execute format('create policy "%s_client_read" on public.%I for select using (client_id in (select public.mkt_user_client_ids()));', t, t);
  end loop;
end $$;


-- ===== migrations/05_reports_performance.sql =====
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


-- ===== migrations/06_portal_access.sql =====
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


-- ===== migrations/07_seed.sql =====
-- =============================================================================
-- 07_seed.sql — admin + first two clients + sample tasks/performance
-- Run last. Safe to re-run (guarded by NOT EXISTS).
-- =============================================================================

-- AGENCY ADMIN — the email Adrian logs in with (magic link).
-- Add more admin emails here if needed.
insert into public.mkt_admins (email) values ('adrian@yourcompanyai.co.uk')
on conflict (email) do nothing;

-- ---- Client 1: Your Company AI ----
insert into public.mkt_clients (name, short_name, industry, location, website, contact_name, contact_email,
  tier, monthly_fee, billing_day, tone_of_voice, key_services, target_customer,
  content_pillars, post_days, post_time, google_rating, review_count, traffic_light, next_task,
  brand_primary_color, brand_secondary_color, website_score, website_score_breakdown, active)
select 'Your Company AI', 'YCA', 'Marketing & Software', 'Littlehampton, West Sussex', 'https://yourcompanyai.co.uk',
  'Adrian Fielding', 'adrian@yourcompanyai.co.uk', 'accelerate', 1500, 1,
  'Direct, plain-spoken, confident. No corporate fluff.',
  'Marketing automation, websites, AI tools for small UK businesses',
  'Small UK trades and service businesses who want more customers without the agency price tag',
  array['Behind the scenes','Customer wins','Practical tips','Local'],
  array['Monday','Wednesday','Friday'], '09:00', 4.9, 27, 'green', 'Approve 3 posts',
  '#E84B35', '#1C2B3A', 86, '{"mobile":90,"copy":88,"cta":80,"trust":86}'::jsonb, true
where not exists (select 1 from public.mkt_clients where name = 'Your Company AI');

-- ---- Client 2: Problem. Solution. ----
insert into public.mkt_clients (name, short_name, industry, location, website, contact_name, contact_email,
  tier, monthly_fee, billing_day, tone_of_voice, key_services, target_customer,
  content_pillars, post_days, post_time, google_rating, review_count, traffic_light, next_task,
  brand_primary_color, brand_secondary_color, website_score, website_score_breakdown, active)
select 'Problem. Solution.', 'Problem. Solution.', 'Business Consultancy', 'Brighton, East Sussex', 'https://problemsolution.co.uk',
  'Sam Reed', 'sam@problemsolution.co.uk', 'growth', 750, 15,
  'Warm, sharp, a little witty. Speaks human.',
  'Operations consultancy and process fixes for growing SMEs',
  'Founders of 10–50 person businesses feeling the growing pains',
  array['Problems we solve','Client stories','Frameworks','Hot takes'],
  array['Tuesday','Thursday'], '08:30', 4.7, 14, 'amber', 'Reply to 2 reviews',
  '#2E4057', '#F59E0B', 72, '{"mobile":74,"copy":80,"cta":62,"trust":70}'::jsonb, true
where not exists (select 1 from public.mkt_clients where name = 'Problem. Solution.');

-- ---- Sample tasks (today) ----
insert into public.mkt_tasks (client_id, task, task_type, priority, overdue, due_date, completed)
select c.id, 'Approve 3 Facebook posts', 'generate_posts', 1, false, current_date, false
from public.mkt_clients c where c.short_name = 'YCA'
and not exists (select 1 from public.mkt_tasks t where t.client_id = c.id and t.task = 'Approve 3 Facebook posts');

insert into public.mkt_tasks (client_id, task, task_type, priority, overdue, due_date, completed)
select c.id, 'Reply to 2 new Google reviews', 'review_response', 1, true, current_date - 1, false
from public.mkt_clients c where c.name = 'Problem. Solution.'
and not exists (select 1 from public.mkt_tasks t where t.client_id = c.id and t.task = 'Reply to 2 new Google reviews');

insert into public.mkt_tasks (client_id, task, task_type, priority, overdue, due_date, completed)
select c.id, 'June report due', 'report_due', 2, false, current_date + 2, false
from public.mkt_clients c where c.short_name = 'YCA'
and not exists (select 1 from public.mkt_tasks t where t.client_id = c.id and t.task = 'June report due');

-- ---- Sample performance (last 6 weeks per client) ----
insert into public.mkt_performance (client_id, week_start, reach, impressions, engagement, new_reviews, avg_rating, posts_published, ad_spend)
select c.id, (current_date - (w * 7))::date,
  (2000 + w*350)::int, (5200 + w*600)::int, (180 + w*22)::int, (w % 3), 4.8, 3, 0
from public.mkt_clients c
cross join generate_series(0,5) as w
where c.active = true
and not exists (
  select 1 from public.mkt_performance p
  where p.client_id = c.id and p.week_start = (current_date - (w * 7))::date
);


-- ===== migrations/08_invites.sql =====
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

