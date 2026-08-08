-- =============================================================================
-- 93_content_queue_rejection_feedback_used_to_text.sql
--
-- Corrects migration 91: mkt_content_queue.rejection_feedback_used shipped
-- as a boolean ("was the feedback loop active for this post"), but the
-- actual scoping need was the resolved feedback STRING itself — the exact
-- text recentRejectionFeedback() fed into this post's prompt, or null when
-- there was none. Storing only a boolean threw away the one thing that
-- makes it useful: send-rejected-digest's recurring-pattern section can now
-- show what feedback was supposedly already in the model's hands when a
-- rejection reason kept recurring anyway, instead of just "this happened
-- 3 times".
--
-- Converts the column in place (not a second column) — safe with no real
-- data loss: at the time this runs, zero rows have rejection_feedback_used
-- = true (migration 91 only just shipped and no generation run has fired
-- since), so every existing value collapses to NULL, which is exactly what
-- "no feedback was available for this post" should read as under the new
-- text semantics anyway. Guarded so it only runs once — if some future
-- rerun finds the column already text, it's a no-op rather than wiping
-- real feedback text that was written after this migration first applied.
-- =============================================================================

DO $$
BEGIN
  IF (
    SELECT data_type FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'mkt_content_queue' AND column_name = 'rejection_feedback_used'
  ) = 'boolean' THEN
    ALTER TABLE public.mkt_content_queue ALTER COLUMN rejection_feedback_used DROP DEFAULT;
    ALTER TABLE public.mkt_content_queue ALTER COLUMN rejection_feedback_used DROP NOT NULL;
    ALTER TABLE public.mkt_content_queue ALTER COLUMN rejection_feedback_used TYPE text USING NULL::text;
  END IF;
END $$;
