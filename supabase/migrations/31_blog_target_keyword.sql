-- Item 6 — Sunday blog posts are built around a search-intent keyword.
alter table mkt_blog_posts add column if not exists target_keyword text;

-- Saturday-night blog generation (Item 6). midnight-cron already generates
-- the weekly blog idempotently; this adds an explicit Saturday 23:30 UK run so
-- blogs are ready for Sunday. pg_cron is UTC; 22:30 UTC = 23:30 London in BST.
-- The daily 00:00 midnight-cron remains a backstop. Created live reusing the
-- existing cron's service-role auth (placeholder kept here):
--   select cron.schedule('saturday-blog-generation','30 22 * * 6', $$
--     select net.http_post(
--       url := 'https://fvyvtdwsomxfkpxwygpk.supabase.co/functions/v1/midnight-cron',
--       headers := '{"Authorization":"Bearer <SERVICE_ROLE_KEY>","Content-Type":"application/json"}'::jsonb,
--       body := '{}'::jsonb);
--   $$);
