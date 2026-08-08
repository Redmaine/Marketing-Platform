-- =============================================================================
-- 91_content_queue_rejection_feedback_used.sql
--
-- Adds mkt_content_queue.rejection_feedback_used — a boolean recording
-- whether THIS post was generated with the content-quality feedback loop
-- active (i.e. _shared/rejectionFeedback.ts's recentRejectionFeedback()
-- returned a non-null string that was folded into the prompt for this
-- brand at generation time). Lets us later measure whether feeding a
-- brand's own recent rejection reasons back into generation actually
-- reduces its rejection rate, which the loop's own output can't tell us
-- on its own.
--
-- Populated at insert time by both fill.ts (fillClientGap, the shared
-- cron/backfill path) and crhq-nightly-content/index.ts (CRHQ's own
-- pipeline) — the two places that call recentRejectionFeedback() and
-- insert into mkt_content_queue.
-- =============================================================================

ALTER TABLE public.mkt_content_queue
  ADD COLUMN IF NOT EXISTS rejection_feedback_used boolean NOT NULL DEFAULT false;
