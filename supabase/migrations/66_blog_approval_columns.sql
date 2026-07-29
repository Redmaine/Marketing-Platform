-- =============================================================================
-- 66_blog_approval_columns.sql
--
-- Part 9 — mkt_blog_posts approval columns.
--
-- The brief listed a target schema of: brand_id, body_markdown,
-- scheduled_publish_date, generated_at, status pending_review/approved/
-- published/rejected. The live table instead uses client_id, content_html,
-- publish_date, created_at and status 'draft'. Those are not gaps — they are
-- different names for the same things, and every one of them is load-bearing
-- across _shared/blog.ts, approve-blog, publish-approved-blog,
-- generate-daily-status, Blog.jsx and ContentQueue.jsx.
--
-- Confirmed with Adrian: additive only. Renaming would touch six production
-- files to change vocabulary, and 'draft' already means exactly what
-- 'pending_review' is specified to mean — nothing publishes without
-- approve-blog setting status='approved' first, which publish-approved-blog
-- requires. The approval gate the brief asks for already exists.
--
-- Genuinely missing, and added here:
--   approved_at      — the table records published_at but never captured WHEN
--                      a blog was approved, so approve-blog's decision left no
--                      timestamp and approval latency could not be measured.
--   rejection_reason — mkt_content_queue has had rejection_reason since
--                      migration 01; blogs had nowhere to record why one was
--                      turned down, so that feedback was lost entirely.
--
-- Apply via `supabase db query -f ... --linked` — NOT `supabase db push`.
-- =============================================================================

ALTER TABLE public.mkt_blog_posts
  ADD COLUMN IF NOT EXISTS approved_at      timestamptz,
  ADD COLUMN IF NOT EXISTS rejection_reason text;

-- Backfill: any blog already past the approval gate was, by definition,
-- approved. Its publish time is the only evidence of when, so use that rather
-- than leaving a row that is clearly approved showing no approval at all.
UPDATE public.mkt_blog_posts
SET approved_at = COALESCE(published_at, created_at)
WHERE approved_at IS NULL
  AND status IN ('approved', 'published');

SELECT column_name FROM information_schema.columns
WHERE table_schema='public' AND table_name='mkt_blog_posts'
  AND column_name IN ('approved_at','rejection_reason')
ORDER BY column_name;
