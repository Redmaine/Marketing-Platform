-- =============================================================================
-- 11_cron_jobs.sql — schedule the three automation jobs via pg_cron
-- Run in the Supabase SQL editor.
--
-- ⚠️ BEFORE RUNNING:
--   1. Enable the extensions (pg_cron schedules; pg_net makes the HTTP calls):
--        create extension if not exists pg_cron;
--        create extension if not exists pg_net;
--        grant usage on schema cron to postgres;
--   2. Replace every  SERVICE_ROLE_KEY  below with the real key from
--        Supabase dashboard → Settings → API → service_role key.
--      (It bypasses RLS — keep it secret; it lives only inside the DB job here.)
--   3. Deploy the three functions first (midnight-cron, send-digest, pull-gbp-reviews).
--
-- Re-running: cron.schedule with the same job name updates it. To remove a job:
--   select cron.unschedule('midnight-content-generation');
-- =============================================================================

create extension if not exists pg_cron;
create extension if not exists pg_net;
grant usage on schema cron to postgres;

-- Midnight content generation — pre-generate tomorrow's posts (00:00 daily)
select cron.schedule(
  'midnight-content-generation',
  '0 0 * * *',
  $$
  select net.http_post(
    url := 'https://fvyvtdwsomxfkpxwygpk.supabase.co/functions/v1/midnight-cron',
    headers := '{"Authorization": "Bearer SERVICE_ROLE_KEY", "Content-Type": "application/json"}'::jsonb,
    body := '{}'::jsonb
  );
  $$
);

-- Morning digest — Adrian's "here's your day" email (07:30 daily)
select cron.schedule(
  'morning-digest',
  '30 7 * * *',
  $$
  select net.http_post(
    url := 'https://fvyvtdwsomxfkpxwygpk.supabase.co/functions/v1/send-digest',
    headers := '{"Authorization": "Bearer SERVICE_ROLE_KEY", "Content-Type": "application/json"}'::jsonb,
    body := '{}'::jsonb
  );
  $$
);

-- GBP review pull + AI draft responses (every 6 hours)
select cron.schedule(
  'pull-gbp-reviews',
  '0 */6 * * *',
  $$
  select net.http_post(
    url := 'https://fvyvtdwsomxfkpxwygpk.supabase.co/functions/v1/pull-gbp-reviews',
    headers := '{"Authorization": "Bearer SERVICE_ROLE_KEY", "Content-Type": "application/json"}'::jsonb,
    body := '{}'::jsonb
  );
  $$
);

-- Check scheduled jobs:   select jobid, schedule, jobname from cron.job;
-- Check recent runs:      select * from cron.job_run_details order by start_time desc limit 20;
