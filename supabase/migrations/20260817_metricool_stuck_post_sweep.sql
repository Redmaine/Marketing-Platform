-- Metricool scheduling reliability: retry/backoff/logging in
-- schedule-to-metricool (code change, no schema needed for that part) plus
-- this migration's two pieces — an index for the new sweep's query, and the
-- pg_cron job that runs it every 30 minutes.
--
-- Background: 17 Aug 2026, a single failed Metricool call left a post at
-- status='approved'/metricool_post_id=null with zero trace anywhere —
-- edge_function_errors had no row for this function at all. Resolved only
-- because Adrian noticed the "Failed to schedule" dashboard count and
-- clicked retry by hand. schedule-to-metricool now retries inline (3
-- attempts, ~82s worst case) and logs every failed attempt; this sweep
-- catches what an inline retry structurally cannot — a failure that outlasts
-- a few seconds of backoff, i.e. a genuine outage rather than a blip.

-- Supports sweep-stuck-metricool-posts' exact query: status='approved' AND
-- metricool_post_id IS NULL AND approved_at < <cutoff>, ordered oldest-first.
-- Partial (WHERE metricool_post_id is null) because that is the only state
-- this index needs to serve fast, and it stays tiny regardless of how large
-- mkt_content_queue's overall history grows — a stuck row is meant to be rare.
create index if not exists mkt_content_queue_stuck_approved_idx
  on public.mkt_content_queue (approved_at)
  where status = 'approved' and metricool_post_id is null;

-- Every 30 minutes — matches generate-daily-status, the highest existing
-- cadence in this project's cron.job, and frequent enough that the sweep's
-- own 20-minute staleness threshold (see sweep-stuck-metricool-posts) means a
-- stuck post is caught within roughly 30-50 minutes of going stale, not left
-- for a full day. cron.schedule() upserts by name, so this is safe to re-run.
select cron.schedule(
  'sweep-stuck-metricool-posts',
  '*/30 * * * *',
  $$select net.http_post(
    url := 'https://fvyvtdwsomxfkpxwygpk.supabase.co/functions/v1/sweep-stuck-metricool-posts',
    headers := private.cron_request_headers(false),
    body := '{}'::jsonb
  );$$
);
