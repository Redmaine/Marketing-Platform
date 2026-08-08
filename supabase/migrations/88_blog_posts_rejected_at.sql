-- =============================================================================
-- 88_blog_posts_rejected_at.sql
--
-- Part 1 of the Blog-tab reject button: mkt_blog_posts already has `status`
-- (with 'rejected' already a valid CHECK value) and `rejection_reason`, but
-- no `rejected_at` timestamp — the one field the content-queue reject
-- pattern (mkt_content_queue) has that this table doesn't. Added for parity
-- so a rejected blog draft carries the same shape as a rejected queue post.
-- =============================================================================

ALTER TABLE public.mkt_blog_posts ADD COLUMN IF NOT EXISTS rejected_at timestamptz;
