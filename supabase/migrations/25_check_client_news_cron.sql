-- =============================================================================
-- 25_check_client_news_cron.sql — schedule check-client-news via pg_cron
-- Run in the Supabase SQL editor AFTER deploying check-client-news.
--
-- ⚠️ Replace SERVICE_ROLE_KEY below with the real key from
--    Supabase dashboard → Settings → API → service_role key, same as
--    11_cron_jobs.sql.
-- =============================================================================

-- Client news monitoring — RSS scan + keyword gate + Haiku assess (09:00 daily)
select cron.schedule(
  'check-client-news',
  '0 9 * * *',
  $$
  select net.http_post(
    url := 'https://fvyvtdwsomxfkpxwygpk.supabase.co/functions/v1/check-client-news',
    headers := '{"Authorization": "Bearer SERVICE_ROLE_KEY", "Content-Type": "application/json"}'::jsonb,
    body := '{}'::jsonb
  );
  $$
);

-- Check scheduled jobs:   select jobid, schedule, jobname from cron.job;
-- Check recent runs:      select * from cron.job_run_details order by start_time desc limit 20;
