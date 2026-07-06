-- =============================================================================
-- 27_content_queue_error_message.sql — capture why a post failed to schedule
-- Run in Supabase SQL Editor (project fvyvtdwsomxfkpxwygpk).
--
-- "Failed to schedule" on the dashboard was previously purely inferred
-- (approved + no metricool_post_id + past due) with no reason ever stored.
-- This adds a place for schedule-to-metricool to persist the actual error
-- so the failed-posts view can show it.
-- =============================================================================

ALTER TABLE public.mkt_content_queue
  ADD COLUMN IF NOT EXISTS error_message TEXT;
