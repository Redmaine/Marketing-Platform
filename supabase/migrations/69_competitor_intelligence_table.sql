-- =============================================================================
-- 69_competitor_intelligence_table.sql
--
-- Table for the weekly-competitor-search edge function (Part 5 of the SEO/
-- content task). Stores one row per search query per run — six rows every
-- Monday, one per tracked market.
--
-- Per explicit instruction: this is a migration FILE ONLY. Do NOT apply via
-- `supabase db query -f` / `db push` / the CLI. Leave unapplied until Adrian
-- (or a future task) explicitly asks for it to be run — this deviates from
-- every other migration in this repo, which are normally applied directly
-- against the linked project as part of the same task that adds them.
-- =============================================================================

create table if not exists public.competitor_intelligence (
  id uuid primary key default gen_random_uuid(),
  search_query text not null,
  result_summary text not null,
  source_url text,
  run_date date not null,
  created_at timestamptz default now()
);

create index if not exists competitor_intelligence_run_date_idx on public.competitor_intelligence (run_date desc);

-- Same access pattern as every other mkt_*/metricool_* reporting table in
-- this project: RLS on, no policies — only the service-role key (used by
-- weekly-competitor-search and send-digest) ever reads or writes it.
alter table public.competitor_intelligence enable row level security;
