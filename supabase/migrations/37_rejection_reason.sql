-- =============================================================================
-- 37_rejection_reason.sql — capture why a post was rejected
--
-- Backs two fixes: (1) a separate Rejected tab in the content queue instead
-- of rejected posts cluttering the main view, and (2) a daily 07:00 email
-- digest of everything rejected in the last 24 hours — which needs an
-- actual reason to report, and a timestamp to know what's "last 24 hours".
--
-- Apply via `supabase db query --linked`, not `db push`.
-- =============================================================================

ALTER TABLE public.mkt_content_queue
  ADD COLUMN IF NOT EXISTS rejection_reason text,
  ADD COLUMN IF NOT EXISTS rejected_at timestamptz;

CREATE INDEX IF NOT EXISTS mkt_content_queue_rejected_at
  ON public.mkt_content_queue (rejected_at) WHERE status = 'rejected';
