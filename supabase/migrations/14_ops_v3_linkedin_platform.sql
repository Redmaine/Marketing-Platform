-- =============================================================================
-- 14_ops_v3_linkedin_platform.sql — allow 'linkedin' as a content platform
-- ADDITIVE. The v3 generate modal offers Facebook and LinkedIn; the existing
-- mkt_content_queue.platform CHECK didn't include linkedin. Safe to re-run.
-- =============================================================================

alter table public.mkt_content_queue
  drop constraint if exists mkt_content_queue_platform_check;
alter table public.mkt_content_queue
  add constraint mkt_content_queue_platform_check
  check (platform in (
    'facebook','instagram','linkedin','google_business','blog','ad_facebook','ad_google'
  ));
