-- Auto-release for review_status='blog_dependent' content_queue rows once
-- the blog they depend on actually publishes. See
-- _shared/blogDependentRelease.ts for the full incident writeup: the only
-- release path used to be client-side (ContentQueue.jsx's load()), so it
-- only ran when a human happened to have that admin page open. 4 real posts
-- (Hormonely, Once Upon A You) sat blog_dependent for weeks with their
-- blogs long since published, with no visibility anywhere that the wait
-- condition was already met. Fixed two ways: a real-time release inside
-- publish-approved-blog (all 3 publish branches), and this sweep as the
-- backstop for any blog published through another path.

-- Supports the query in blogDependentRelease.ts's releaseForBlogs/releaseAll:
-- status='draft' AND review_status='blog_dependent'. Partial, same rationale
-- as mkt_content_queue_stuck_approved_idx — this state is meant to be rare
-- and short-lived, so the index should stay tiny regardless of how large
-- mkt_content_queue's overall history grows.
create index if not exists mkt_content_queue_blog_dependent_idx
  on public.mkt_content_queue (client_id)
  where status = 'draft' and review_status = 'blog_dependent';

-- Every 30 minutes — same cadence as sweep-stuck-metricool-posts, the
-- closest analogue to this sweep. cron.schedule() upserts by name, so this
-- is safe to re-run.
select cron.schedule(
  'sweep-blog-dependent-posts',
  '*/30 * * * *',
  $$select net.http_post(
    url := 'https://fvyvtdwsomxfkpxwygpk.supabase.co/functions/v1/sweep-blog-dependent-posts',
    headers := private.cron_request_headers(false),
    body := '{}'::jsonb
  );$$
);
