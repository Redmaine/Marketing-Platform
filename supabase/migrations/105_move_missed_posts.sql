-- 105_move_missed_posts.sql — 18 Sep 2026
-- Platform-wide missed-slot mover (supabase/functions/_shared/missedSlots.ts,
-- edge function move-missed-posts). A post whose slot passed without
-- publishing moves to the next open slot for its brand/platform instead of
-- being cleared by hand ("past scheduled date — superseded, cleared during
-- queue cleanup" — the top rejection reason across brands for weeks).
--
--   published_verified_at  Metricool's scheduler confirmed providers[].status
--                          PUBLISHED for this row — asked once, then skipped.
--   missed_moved_from      the slot the row was moved away from
--   missed_moved_at        when
alter table public.mkt_content_queue
  add column if not exists published_verified_at timestamptz,
  add column if not exists missed_moved_from timestamptz,
  add column if not exists missed_moved_at timestamptz;

create index if not exists mkt_content_queue_missed_candidates_idx
  on public.mkt_content_queue (scheduled_for)
  where content_type in ('post', 'reel') and published_verified_at is null
    and status in ('draft', 'pending', 'approved', 'scheduled');

-- 23:30 UTC daily — before midnight-content-generation (00:00) fills the gaps.
select cron.unschedule('move-missed-posts') where exists (select 1 from cron.job where jobname = 'move-missed-posts');
select cron.schedule(
  'move-missed-posts',
  '30 23 * * *',
  $$select net.http_post(
      url := 'https://fvyvtdwsomxfkpxwygpk.supabase.co/functions/v1/move-missed-posts',
      headers := private.cron_request_headers(true),
      body := '{}'::jsonb
    );$$
);
