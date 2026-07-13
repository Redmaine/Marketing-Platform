-- =============================================================================
-- 41_crhq_scrape_cron.sql — schedule scrape-crhq-content via pg_cron
-- Run in the Supabase SQL editor AFTER deploying scrape-crhq-content and
-- applying 40_crhq_scrape_cache.sql.
--
-- ⚠️ Replace SERVICE_ROLE_KEY below with the real key from
--    Supabase dashboard → Settings → API → service_role key, same as
--    11_cron_jobs.sql.
--
-- Timing: this runs at 22:00, two hours before midnight-cron's 00:00 content
-- generation (11_cron_jobs.sql) — deliberately not "midnight" itself, so the
-- scrape is already sitting in crhq_scrape_cache, fresh, by the time
-- midnight-cron looks for it (see SCRAPE_FRESHNESS_HOURS in its index.ts).
-- =============================================================================

-- CRHQ content scrape — YouTube uploads + news articles, last 48h (22:00 daily)
select cron.schedule(
  'crhq-content-scrape',
  '0 22 * * *',
  $$
  select net.http_post(
    url := 'https://fvyvtdwsomxfkpxwygpk.supabase.co/functions/v1/scrape-crhq-content',
    headers := '{"Authorization": "Bearer SERVICE_ROLE_KEY", "Content-Type": "application/json"}'::jsonb,
    body := '{}'::jsonb
  );
  $$
);

-- Check scheduled jobs:   select jobid, schedule, jobname from cron.job;
-- Check recent runs:      select * from cron.job_run_details order by start_time desc limit 20;
