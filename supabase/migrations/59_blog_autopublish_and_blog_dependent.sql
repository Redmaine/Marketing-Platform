-- =============================================================================
-- 59_blog_autopublish_and_blog_dependent.sql
-- Auto-publish-on-approval wiring + blog-dependent social gating.
--
-- 1. mkt_blog_posts.status — add 'publish_failed'. publish-approved-blog sets
--    this (and logs to edge_function_errors) when a GitHub push fails, so a
--    failed publish is visibly distinct from an un-approved draft.
-- 2. mkt_content_queue.review_status — add 'blog_dependent'. A social post
--    whose copy references a blog ("blog", "latest post", "we wrote",
--    "read more") is marked blog_dependent and cannot be approved until the
--    blog it links to is published.
-- 3. mkt_content_queue.blog_id — FK to the source blog for repurposed posts,
--    so the approval flow can check the linked blog's publish status directly
--    rather than guessing which blog a post refers to.
-- Idempotent. Confirmed live before running:
--   status check was ('draft','approved','published');
--   review_status check was ('passed','needs_attention');
--   blog_id did not exist on mkt_content_queue.
-- =============================================================================

-- ── 1. mkt_blog_posts.status: add 'publish_failed' ───────────────────────────
alter table public.mkt_blog_posts drop constraint if exists mkt_blog_posts_status_check;
alter table public.mkt_blog_posts add constraint mkt_blog_posts_status_check
  check (status in ('draft','approved','published','publish_failed'));

-- ── 2. mkt_content_queue.review_status: add 'blog_dependent' ─────────────────
alter table public.mkt_content_queue drop constraint if exists mkt_content_queue_review_status_check;
alter table public.mkt_content_queue add constraint mkt_content_queue_review_status_check
  check (review_status in ('passed','needs_attention','blog_dependent'));

-- ── 3. mkt_content_queue.blog_id: link repurposed posts to their source blog ─
alter table public.mkt_content_queue
  add column if not exists blog_id uuid references public.mkt_blog_posts(id) on delete set null;

create index if not exists mkt_content_queue_blog_id_idx
  on public.mkt_content_queue (blog_id) where blog_id is not null;
