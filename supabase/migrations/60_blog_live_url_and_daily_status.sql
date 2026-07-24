-- =============================================================================
-- 60_blog_live_url_and_daily_status.sql
-- Persists the live URL a blog was actually published to, so
-- generate-daily-status's blogs_published_last_7d can report a real URL
-- rather than guessing one. Populated by publish-approved-blog going forward
-- (github + steady branches only — the manual-HTML branch has no live URL to
-- store, since nothing was actually pushed anywhere). Historic rows published
-- before this column existed stay NULL, which is correct — no URL was stored
-- for them.
-- Idempotent. Confirmed live before running: mkt_blog_posts had no live_url
-- (or similarly-named) column.
-- =============================================================================
alter table public.mkt_blog_posts
  add column if not exists live_url text;
