-- =============================================================================
-- 20260810_mkt_post_performance_uniq.sql
--
-- monthly-performance-pull/index.ts upserts to mkt_post_performance with
-- onConflict: 'client_id,metricool_post_id,month_year', and its own comment
-- says this targets a partial unique index called mkt_post_performance_uniq
-- (WHERE metricool_post_id IS NOT NULL). That index was never actually
-- created — confirmed via pg_constraint, only the primary key and the
-- client_id foreign key exist — so every client's pull has been failing with
-- "no unique or exclusion constraint matching the ON CONFLICT specification".
--
-- Partial (WHERE metricool_post_id IS NOT NULL) because metricool_post_id is
-- nullable; a plain unique index would treat every NULL as distinct anyway
-- (standard Postgres NULL-in-unique-index behaviour), but the partial form
-- matches exactly what the existing code comment already describes.
--
-- Applied directly via `supabase db query --linked` (this project's
-- established pattern — see review_schema.sql's equivalent note in
-- yca-platform). This file is the record.
--
-- Gotcha hit while applying this: piping this file in via
-- `supabase db query --linked < file.sql` silently dropped the WHERE
-- clause — the index was created as a full (non-partial) unique index with
-- no error. Passing the same CREATE UNIQUE INDEX statement as a single
-- inline string argument (`supabase db query --linked "CREATE UNIQUE
-- INDEX ..."`) applied it correctly, confirmed via
-- `pg_index.indpred IS NOT NULL`. Worth checking indpred after any
-- future partial-index migration applied by piping a file through this
-- CLI, rather than trusting a clean exit code.
-- =============================================================================

CREATE UNIQUE INDEX IF NOT EXISTS mkt_post_performance_uniq
  ON public.mkt_post_performance (client_id, metricool_post_id, month_year)
  WHERE metricool_post_id IS NOT NULL;

-- ─── VERIFY ─────────────────────────────────────────────────────────────────
-- SELECT indexname FROM pg_indexes WHERE tablename = 'mkt_post_performance' AND indexname = 'mkt_post_performance_uniq';
