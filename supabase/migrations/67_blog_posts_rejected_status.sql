-- =============================================================================
-- 67_blog_posts_rejected_status.sql
--
-- Adds 'rejected' to mkt_blog_posts.status's CHECK constraint.
--
-- Migration 66 added rejection_reason to this table specifically so a
-- rejected blog could record why — but never widened the status constraint
-- to permit the value that column exists for. Without this, "reject a blog"
-- is impossible at the database level: any UPDATE ... SET status = 'rejected'
-- fails constraint mkt_blog_posts_status_check (23514), which is what
-- surfaced this gap.
--
-- No other change needed: nothing in the frontend enumerates blog statuses
-- exhaustively. ContentQueue.jsx's blog-dependent gate treats any status
-- other than 'published' as "still blocked" — a social post linked to a
-- rejected blog correctly stays blocked forever rather than being eligible
-- for approval to promote a blog that will never go live.
--
-- Apply via `supabase db query -f ... --linked` — NOT `supabase db push`.
-- =============================================================================

ALTER TABLE public.mkt_blog_posts
  DROP CONSTRAINT mkt_blog_posts_status_check;

ALTER TABLE public.mkt_blog_posts
  ADD CONSTRAINT mkt_blog_posts_status_check
  CHECK (status = ANY (ARRAY['draft'::text, 'approved'::text, 'published'::text, 'publish_failed'::text, 'rejected'::text]));

SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'mkt_blog_posts_status_check';
