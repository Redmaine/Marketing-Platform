-- =============================================================================
-- 62_metricool_weekly_pull_schema.sql
--
-- Schema for the Metricool weekly pull (metricool-weekly-pull edge function).
-- Apply directly via the Supabase SQL editor (or `supabase db query -f`,
-- which runs against the linked project without going through migration
-- history — same convention already used for 61_*) — NOT `supabase db push`.
--
-- Three tables, exactly as specified:
--   metricool_post_performance    — one row per (post_id, platform), upserted
--                                    on every pull so metrics stay current as
--                                    they accrue after publish.
--   metricool_account_performance — one row PER PULL RUN (no unique
--                                    constraint given, so this is an
--                                    accumulating snapshot history — every
--                                    Monday adds a new row per brand+platform
--                                    rather than overwriting last week's).
--   metricool_top_posts           — same accumulating-snapshot shape,
--                                    dated by pull_date.
-- =============================================================================

create table if not exists public.metricool_post_performance (
  id uuid primary key default gen_random_uuid(),
  brand text not null,
  blog_id text not null,
  platform text not null,
  post_id text not null,
  published_at timestamptz,
  reach integer default 0,
  impressions integer default 0,
  engagements integer default 0,
  likes integer default 0,
  comments integer default 0,
  shares integer default 0,
  clicks integer default 0,
  engagement_rate numeric default 0,
  pulled_at timestamptz default now(),
  unique(post_id, platform)
);

create table if not exists public.metricool_account_performance (
  id uuid primary key default gen_random_uuid(),
  brand text not null,
  blog_id text not null,
  platform text not null,
  followers integer default 0,
  follower_change_7d integer default 0,
  follower_change_30d integer default 0,
  reach_7d integer default 0,
  impressions_7d integer default 0,
  engagements_7d integer default 0,
  avg_engagement_rate_30d numeric default 0,
  pulled_at timestamptz default now()
);

create table if not exists public.metricool_top_posts (
  id uuid primary key default gen_random_uuid(),
  brand text not null,
  platform text not null,
  post_preview text,
  engagement_rate numeric default 0,
  published_at timestamptz,
  pull_date date default current_date
);

-- Read-heavy reporting tables, written only by the weekly-pull edge function
-- (service key, bypasses RLS) — same access pattern as every other mkt_*
-- table in this project (RLS on, no policies; only Netlify/edge functions
-- with the service key ever touch them).
alter table public.metricool_post_performance enable row level security;
alter table public.metricool_account_performance enable row level security;
alter table public.metricool_top_posts enable row level security;

create index if not exists metricool_post_performance_brand_idx on public.metricool_post_performance (brand);
create index if not exists metricool_post_performance_platform_idx on public.metricool_post_performance (platform);
create index if not exists metricool_account_performance_brand_idx on public.metricool_account_performance (brand);
create index if not exists metricool_account_performance_pulled_at_idx on public.metricool_account_performance (pulled_at desc);
create index if not exists metricool_top_posts_brand_pull_date_idx on public.metricool_top_posts (brand, pull_date desc);
