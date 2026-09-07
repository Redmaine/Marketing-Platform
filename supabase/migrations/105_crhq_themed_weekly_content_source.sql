-- =============================================================================
-- 105_crhq_themed_weekly_content_source.sql
--
-- Adds 'themed_weekly' to mkt_content_queue.content_source's allowed values,
-- for CRHQ's new Tuesday shop/coffee and Thursday intelligence-subscription
-- posts (crhq-nightly-content's generateThemedWeeklyPost) — layered on top
-- of the existing daily scrape-driven post ('youtube_scrape'), which is a
-- genuinely different content type: fixed by day-of-week/theme, not derived
-- from the nightly YouTube/news scrape.
--
-- Caught by a real test invocation of the deployed function, not assumed:
-- the first live run after deploying the new code failed with
-- "violates check constraint mkt_content_queue_content_source_check"
-- because this value didn't exist yet. This migration is that fix.
-- =============================================================================

alter table public.mkt_content_queue drop constraint mkt_content_queue_content_source_check;

alter table public.mkt_content_queue add constraint mkt_content_queue_content_source_check
  check (content_source is null or content_source = any (array['youtube_scrape', 'pillar_fallback', 'themed_weekly']));
