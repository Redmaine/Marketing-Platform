-- =============================================================================
-- 63_metricool_weekly_pull_cron.sql — weekly Metricool analytics pull.
--
-- Schedules metricool-weekly-pull (supabase/functions/metricool-weekly-pull)
-- for Monday 06:00 UTC — ahead of weekly-content-prompt (Monday 08:00, see
-- migration 57) so fresh performance numbers are in place before that job's
-- content-planning pass reads them. No day/time was specified when this was
-- commissioned; this slot was chosen to land ahead of weekly-content-prompt
-- rather than picked arbitrarily.
--
-- ⚠️ Replace SERVICE_ROLE_KEY below with the real key from
--    Supabase dashboard → Settings → API → service_role key, same convention
--    as every other cron migration in this repo (see e.g. migration 57).
-- Apply via `supabase db query --linked`, not `db push`.
-- =============================================================================

SELECT cron.schedule(
  'metricool-weekly-pull',
  '0 6 * * 1',
  $$
  SELECT net.http_post(
    url := 'https://fvyvtdwsomxfkpxwygpk.supabase.co/functions/v1/metricool-weekly-pull',
    headers := '{"Authorization": "Bearer SERVICE_ROLE_KEY", "Content-Type": "application/json"}'::jsonb,
    body := '{}'::jsonb
  );
  $$
);

-- Check scheduled jobs:   select jobid, schedule, jobname from cron.job;
-- Check recent runs:      select * from cron.job_run_details order by start_time desc limit 20;
