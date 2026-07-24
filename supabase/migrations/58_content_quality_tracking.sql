-- =============================================================================
-- 58_content_quality_tracking.sql — nightly content-quality feedback loop
--
-- Two parts, both idempotent:
--
--   1. mkt_clients.approval_rate_30d (numeric, nullable) — each brand's
--      approval rate over the trailing 30 days, refreshed nightly by
--      midnight-cron for EVERY active brand (CRHQ included). Defined as
--      approved_at-in-window / (approved_at-in-window + rejected_at-in-window),
--      read off the timestamps rather than current status (an approved post's
--      status later mutates to 'scheduled'/'published'). NULL when a brand had
--      no terminal decisions in the window.
--
--   2. mkt_content_queue.rejection_reason — ALREADY added in 37_rejection_reason.
--      Re-asserted here with IF NOT EXISTS only so this file is a complete,
--      self-contained description of the content-quality columns; it is a
--      no-op on any database where 37 was already applied. midnight-cron and
--      crhq-nightly-content now read the last 30 days of these reasons per
--      brand (excluding the generic one-tap 'Rejected by Adrian') and fold a
--      summary into the generation prompt so the model stops repeating the
--      same mistakes — see _shared/rejectionFeedback.ts.
--
-- Apply via `supabase db query --linked` in the SQL editor, NOT `db push`
-- (this project has known schema_migrations drift — see the other migration
-- headers). Already applied live to project fvyvtdwsomxfkpxwygpk.
-- =============================================================================

ALTER TABLE public.mkt_clients
  ADD COLUMN IF NOT EXISTS approval_rate_30d numeric;

ALTER TABLE public.mkt_content_queue
  ADD COLUMN IF NOT EXISTS rejection_reason text;
