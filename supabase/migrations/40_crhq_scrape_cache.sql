-- =============================================================================
-- 40_crhq_scrape_cache.sql — crhq_scrape_cache: nightly CRHQ content scrape
--
-- Written by scrape-crhq-content (22:00 daily). Read by midnight-cron (00:00)
-- for the Combat Ready HQ client only — see attachCrhqScrapeIfDue in
-- midnight-cron/index.ts, which only uses a row scraped within the last 3
-- hours. Older rows are simply left in place as history; nothing purges them.
--
-- Apply via `supabase db query --linked`, not `db push` (see migration 35's
-- history — the schema_migrations ledger has a pre-existing gap).
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.crhq_scrape_cache (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scraped_at  timestamptz NOT NULL DEFAULT now(),
  videos      jsonb NOT NULL DEFAULT '[]'::jsonb,
  articles    jsonb NOT NULL DEFAULT '[]'::jsonb
);

ALTER TABLE public.crhq_scrape_cache ENABLE ROW LEVEL SECURITY;

-- Agency admins can read it; rows are written by scrape-crhq-content using
-- the service role (which bypasses RLS), so no insert policy is needed —
-- same pattern as mkt_cron_log (migration 10).
DROP POLICY IF EXISTS "crhq_scrape_cache_admin_read" ON public.crhq_scrape_cache;
CREATE POLICY "crhq_scrape_cache_admin_read" ON public.crhq_scrape_cache
  FOR SELECT USING (public.mkt_is_admin());

CREATE INDEX IF NOT EXISTS crhq_scrape_cache_scraped_at
  ON public.crhq_scrape_cache (scraped_at DESC);
