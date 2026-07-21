-- =============================================================================
-- 56_crhq_nightly_pipeline.sql — CRHQ nightly content pipeline rebuild
--
-- DO NOT APPLY UNTIL crhq-nightly-content AND midnight-cron ARE DEPLOYED.
-- The cron section at the bottom retires the old 22:00 scrape-only job and
-- replaces it with the new one that scrapes + generates + queues in a single
-- run. Applying this before the new function exists live means 22:00 fires
-- against a 404.
--
-- Apply via `supabase db query --linked`, not `db push` (see migration 35's
-- history — the schema_migrations ledger has a pre-existing gap).
-- =============================================================================

-- ── 1. mkt_content_queue.content_source ────────────────────────────────────
-- Written by crhq-nightly-content: 'youtube_scrape' when the post references
-- real scraped video/article content, 'pillar_fallback' when no new content
-- was found in the last 48h and the post came from CRHQ's pillar rotation
-- instead. NULL for every other client/function — this is CRHQ-specific
-- provenance, not a general content-queue field.
ALTER TABLE public.mkt_content_queue ADD COLUMN IF NOT EXISTS content_source text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'mkt_content_queue_content_source_check'
  ) THEN
    ALTER TABLE public.mkt_content_queue
      ADD CONSTRAINT mkt_content_queue_content_source_check
      CHECK (content_source IS NULL OR content_source IN ('youtube_scrape', 'pillar_fallback'));
  END IF;
END $$;

-- ── 2. mkt_cron_log.notes ───────────────────────────────────────────────────
-- A separate channel from `errors` for expected, non-error status messages —
-- e.g. "queue sufficient, skipped" or "no new content, used pillar fallback".
-- Keeping these out of `errors` matters: `errors` non-empty is what triggers
-- an edge_function_errors row (see crhq-nightly-content and midnight-cron),
-- and a queue-cap skip happening most nights is expected behaviour, not a
-- failure — it would be noise in error monitoring, not a signal.
ALTER TABLE public.mkt_cron_log ADD COLUMN IF NOT EXISTS notes text[];

-- ── 3. CRHQ content_pillars — sync with _shared/prompts.ts's CRHQ_PILLARS ──
-- content_pillars (read by nextPillar/pickDiversePillar for the rotation
-- pointer) still held the original 5-topic seed from migration 23. The
-- system prompt's CRHQ_PILLARS block was updated in a later session to a
-- different 6-topic list and the DB column was never brought in line — the
-- rotation pointer and what the model is told the brand covers have been out
-- of sync since. crhq-nightly-content's pillar_fallback path rotates off this
-- column, so it must match.
UPDATE public.mkt_clients
SET content_pillars = ARRAY[
  'UK defence policy and capability',
  'NATO and alliance dynamics',
  'Geopolitical analysis',
  'Military technology and procurement',
  'Veterans and armed forces community',
  'International conflicts and implications for UK security'
]
WHERE slug = 'crhq';

-- ── 4. pg_cron — retire the old scrape-only job, schedule the new one ─────
-- crhq-nightly-content now does its own fresh scrape as step 1 of every run
-- (see _shared/crhqScrape.ts, shared with scrape-crhq-content) rather than
-- depending on this separately-timed job's cached output — running both at
-- 22:00 would double the YouTube API calls and risk a race between the two
-- writing to crhq_scrape_cache. scrape-crhq-content itself is kept deployed
-- for manual/on-demand use, just no longer on a schedule.
SELECT cron.unschedule('crhq-content-scrape')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'crhq-content-scrape');

-- ⚠️ Replace SERVICE_ROLE_KEY below with the real key from
--    Supabase dashboard → Settings → API → service_role key, same convention
--    as every other cron migration in this repo.
SELECT cron.schedule(
  'crhq-nightly-content',
  '0 22 * * *',
  $$
  SELECT net.http_post(
    url := 'https://fvyvtdwsomxfkpxwygpk.supabase.co/functions/v1/crhq-nightly-content',
    headers := '{"Authorization": "Bearer SERVICE_ROLE_KEY", "Content-Type": "application/json"}'::jsonb,
    body := '{}'::jsonb
  );
  $$
);

-- Check scheduled jobs:   select jobid, schedule, jobname from cron.job;
-- Check recent runs:      select * from cron.job_run_details order by start_time desc limit 20;
