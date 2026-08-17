-- published_posts_queue_uniq was a PARTIAL unique index (WHERE content_queue_id
-- IS NOT NULL). schedule-to-metricool's .upsert(..., {onConflict:'content_queue_id'})
-- emits a bare "ON CONFLICT (content_queue_id)" with no WHERE clause, and
-- Postgres can only infer a partial index as the arbiter if the ON CONFLICT
-- clause repeats its exact predicate — which PostgREST has no option to do.
-- Result: "there is no unique or exclusion constraint matching the ON CONFLICT
-- specification", on EVERY call, for as long as this index has existed —
-- silently caught by schedule-to-metricool's own `if (pubErr) console.error(...)`
-- and never surfaced anywhere else. Found 17 Aug 2026 chasing why a real,
-- successful Metricool schedule call left no published_posts row behind.
--
-- Fix: a plain UNIQUE constraint behaves identically for this table's actual
-- use. Postgres never treats two NULLs as equal under a standard UNIQUE
-- constraint, so rows with content_queue_id IS NULL (any path that isn't
-- queue-driven) remain completely unconstrained against each other — exactly
-- what the partial index intended. The only change is that PostgREST's
-- onConflict inference can now find it.
--
-- Verified directly against the live schema: the same two-insert upsert
-- sequence schedule-to-metricool performs now produces one row, updated in
-- place, not a duplicate or an error.
drop index if exists public.published_posts_queue_uniq;
alter table public.published_posts
  add constraint published_posts_content_queue_id_key unique (content_queue_id);
