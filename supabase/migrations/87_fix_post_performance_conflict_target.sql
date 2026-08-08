-- =============================================================================
-- 87_fix_post_performance_conflict_target.sql
--
-- Bug: mkt_post_performance_uniq (migration 57) is a PARTIAL unique index
-- (WHERE metricool_post_id IS NOT NULL). monthly-performance-pull's upsert
-- targets it via a plain column list (onConflict: 'client_id,
-- metricool_post_id,month_year'), which PostgREST/Postgres can only resolve
-- against a full (non-partial) unique index or exclusion constraint — there
-- is no way to express the partial predicate through supabase-js's onConflict
-- option. Every run since deployment has failed on every client with:
--   "there is no unique or exclusion constraint matching the ON CONFLICT
--   specification"
-- (confirmed live in mkt_cron_log — 100% failure rate, table has 0 rows).
--
-- Fix: drop the partial index, replace with a full unique index on the same
-- three columns. Safe to drop the NOT NULL predicate — pullClientPosts
-- already filters out any post with no recoverable metricool_post_id before
-- building the upsert rows (see monthly-performance-pull/index.ts), so a
-- null metricool_post_id never actually reaches this table today. If that
-- upstream guarantee ever changes, this index will need to change with it.
--
-- Low risk: table has zero rows (this bug has fired on every run since the
-- table existed), and nothing currently reads from mkt_post_performance —
-- mkt_monthly_reports and mkt_client_optimisation are populated from the
-- same function's in-memory data, not by querying this table back.
-- =============================================================================

DROP INDEX IF EXISTS public.mkt_post_performance_uniq;

CREATE UNIQUE INDEX IF NOT EXISTS mkt_post_performance_uniq
  ON public.mkt_post_performance (client_id, metricool_post_id, month_year);
