-- =============================================================================
-- 20260901120000_fix_mkt_post_performance_upsert_arbiter.sql
--
-- mkt_post_performance has NEVER held a single row. Every monthly-performance-
-- pull run since at least 8 Aug 2026 logged, for every brand:
--
--   "mkt_post_performance upsert failed — there is no unique or exclusion
--    constraint matching the ON CONFLICT specification"
--
-- Cause: mkt_post_performance_uniq is a PARTIAL unique index
--   (client_id, metricool_post_id, month_year) WHERE metricool_post_id IS NOT NULL
-- Postgres will only use a partial index as an ON CONFLICT arbiter when the
-- statement itself repeats the index predicate. PostgREST's upsert sends only
-- the column list, so the arbiter never matched and every insert was rejected.
--
-- The function's own comment reasoned this was safe because the code filters
-- out rows with no metricool_post_id before inserting — true, but irrelevant:
-- the requirement is on the STATEMENT carrying the predicate, not on the rows
-- satisfying it. That reasoning is why the bug survived in-code review.
--
-- Fix: replace it with a plain (non-partial) unique index on the same three
-- columns. Postgres treats NULLs as distinct in a unique index, so a row with
-- a null metricool_post_id is still permitted exactly as before — the partial
-- predicate was never actually buying anything the plain index doesn't.
--
-- Safe to run against the live table: it is empty (0 rows, confirmed), so
-- there are no existing duplicates that could block index creation.
-- =============================================================================

drop index if exists public.mkt_post_performance_uniq;

create unique index if not exists mkt_post_performance_uniq
  on public.mkt_post_performance (client_id, metricool_post_id, month_year);

comment on index public.mkt_post_performance_uniq is
  'Upsert arbiter for monthly-performance-pull. Deliberately NOT partial — a partial index cannot serve as an ON CONFLICT arbiter through PostgREST, which is what left this table empty from Aug 2026 until 1 Sep 2026.';
