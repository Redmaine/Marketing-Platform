-- =============================================================================
-- 57_monthly_performance_pipeline.sql — monthly performance reporting +
-- content optimisation loop.
--
-- DO NOT APPLY UNTIL monthly-performance-pull, weekly-content-prompt,
-- midnight-cron and crhq-nightly-content ARE DEPLOYED with the code that
-- reads/writes these tables — see the functions' own headers.
--
-- Apply via `supabase db query --linked`, not `db push` (see migration 35's
-- history — the schema_migrations ledger has a pre-existing gap).
-- =============================================================================

-- ── 1. mkt_post_performance ─────────────────────────────────────────────────
-- One row per post pulled from Metricool for a given calendar month. Written
-- by monthly-performance-pull on the 1st of each month, for posts published
-- in the PREVIOUS month. `content_type` intentionally duplicates `platform`
-- (both hold 'facebook'/'instagram') — matches the brief's exact column
-- list rather than assuming it's a mistake.
--
-- follower_change is brand-level (followers at end of month minus start), not
-- truly per-post, but the brief lists it as a mkt_post_performance column —
-- every row for a given client_id + month_year carries the same value,
-- deliberately, rather than being split out into its own table.
CREATE TABLE IF NOT EXISTS public.mkt_post_performance (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at        timestamptz NOT NULL DEFAULT now(),
  client_id         uuid NOT NULL REFERENCES public.mkt_clients(id) ON DELETE CASCADE,
  metricool_post_id text,
  platform          text NOT NULL,
  published_at      timestamptz,
  content_type      text,
  pillar            text,
  reach             integer,
  impressions       integer,
  likes             integer,
  comments          integer,
  shares            integer,
  engagement_rate   numeric,
  follower_change   integer,
  month_year        text NOT NULL
);

-- Re-running the pull for a month (e.g. after fixing an error) upserts rather
-- than duplicating — one row per post per month per client. Metricool posts
-- with no recoverable id (see the function's defensive extraction) fall
-- outside this unique index and can duplicate on re-run; that's an accepted
-- edge case flagged in the function's own logging, not silently hidden.
CREATE UNIQUE INDEX IF NOT EXISTS mkt_post_performance_uniq
  ON public.mkt_post_performance (client_id, metricool_post_id, month_year)
  WHERE metricool_post_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS mkt_post_performance_client_month_idx
  ON public.mkt_post_performance (client_id, month_year);

ALTER TABLE public.mkt_post_performance ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "mkt_post_performance_admin_read" ON public.mkt_post_performance;
CREATE POLICY "mkt_post_performance_admin_read" ON public.mkt_post_performance
  FOR SELECT USING (public.mkt_is_admin());

-- ── 2. mkt_monthly_reports ──────────────────────────────────────────────────
-- One row per client per month — the Claude-generated performance report and
-- the summary figures it was built from.
CREATE TABLE IF NOT EXISTS public.mkt_monthly_reports (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at          timestamptz NOT NULL DEFAULT now(),
  client_id           uuid NOT NULL REFERENCES public.mkt_clients(id) ON DELETE CASCADE,
  month_year          text NOT NULL,
  report_text         text,
  top_performers      jsonb,
  bottom_performers   jsonb,
  avg_engagement_rate numeric,
  follower_change     integer,
  generated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS mkt_monthly_reports_client_month_uniq
  ON public.mkt_monthly_reports (client_id, month_year);

ALTER TABLE public.mkt_monthly_reports ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "mkt_monthly_reports_admin_read" ON public.mkt_monthly_reports;
CREATE POLICY "mkt_monthly_reports_admin_read" ON public.mkt_monthly_reports
  FOR SELECT USING (public.mkt_is_admin());

-- ── 3. mkt_client_optimisation ──────────────────────────────────────────────
-- One row per client per month — the content-generation weighting derived
-- from that month's performance. midnight-cron and crhq-nightly-content read
-- the LATEST row per client (see _shared/optimisation.ts) and fold
-- content_notes into the system prompt. A separate table (not columns on
-- mkt_clients) so history accumulates month over month rather than being
-- overwritten — useful for seeing whether notes/weighting are actually
-- changing behaviour over time, and matches how mkt_monthly_reports is
-- already one-row-per-client-per-month.
CREATE TABLE IF NOT EXISTS public.mkt_client_optimisation (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at               timestamptz NOT NULL DEFAULT now(),
  client_id                uuid NOT NULL REFERENCES public.mkt_clients(id) ON DELETE CASCADE,
  month_year               text NOT NULL,
  top_performing_pillars   text[],
  underperforming_pillars  text[],
  best_post_time           text,
  best_post_day            text,
  content_notes            text
);

CREATE UNIQUE INDEX IF NOT EXISTS mkt_client_optimisation_client_month_uniq
  ON public.mkt_client_optimisation (client_id, month_year);

ALTER TABLE public.mkt_client_optimisation ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "mkt_client_optimisation_admin_read" ON public.mkt_client_optimisation;
CREATE POLICY "mkt_client_optimisation_admin_read" ON public.mkt_client_optimisation
  FOR SELECT USING (public.mkt_is_admin());

-- ── 4. mkt_clients.auto_approve ─────────────────────────────────────────────
-- Set manually by Adrian per brand via SQL once he trusts that brand's
-- output quality — never auto-set by any function based on rejection rate or
-- any other signal. When true, fillClientGap / crhq-nightly-content insert
-- new posts with status='approved' instead of 'draft', skipping manual
-- review before scheduling.
ALTER TABLE public.mkt_clients ADD COLUMN IF NOT EXISTS auto_approve boolean NOT NULL DEFAULT false;

-- ── 5. pg_cron — monthly pull (1st @ 06:00) + weekly prompt (Mon @ 08:00) ──
-- ⚠️ Replace SERVICE_ROLE_KEY below with the real key from
--    Supabase dashboard → Settings → API → service_role key, same convention
--    as every other cron migration in this repo.
SELECT cron.schedule(
  'monthly-performance-pull',
  '0 6 1 * *',
  $$
  SELECT net.http_post(
    url := 'https://fvyvtdwsomxfkpxwygpk.supabase.co/functions/v1/monthly-performance-pull',
    headers := '{"Authorization": "Bearer SERVICE_ROLE_KEY", "Content-Type": "application/json"}'::jsonb,
    body := '{}'::jsonb
  );
  $$
);

SELECT cron.schedule(
  'weekly-content-prompt',
  '0 8 * * 1',
  $$
  SELECT net.http_post(
    url := 'https://fvyvtdwsomxfkpxwygpk.supabase.co/functions/v1/weekly-content-prompt',
    headers := '{"Authorization": "Bearer SERVICE_ROLE_KEY", "Content-Type": "application/json"}'::jsonb,
    body := '{}'::jsonb
  );
  $$
);

-- Check scheduled jobs:   select jobid, schedule, jobname from cron.job;
-- Check recent runs:      select * from cron.job_run_details order by start_time desc limit 20;
