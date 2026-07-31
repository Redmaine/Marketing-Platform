-- =============================================================================
-- 70_weekly_competitor_search_cron.sql — weekly competitor intelligence.
--
-- Schedules weekly-competitor-search (supabase/functions/weekly-competitor-search)
-- for Monday 06:00 UTC, alongside metricool-weekly-pull (same slot, see
-- migration 63) and ahead of weekly-content-prompt (Monday 08:00).
--
-- ⚠️ Replace SERVICE_ROLE_KEY below with the real key from
--    Supabase dashboard → Settings → API → service_role key, then apply via
--    `supabase db query --linked` — same convention as every other cron
--    migration in this repo (10, 25, 30, 38, 41, 48, 56, 57, 63). Not applied
--    automatically here: the real key only lives in the Supabase dashboard
--    (the CLI's `secrets list` only shows redacted digests), so this is a
--    manual step, same as it has been for every prior cron migration.
-- =============================================================================

SELECT cron.schedule(
  'weekly-competitor-search',
  '0 6 * * 1',
  $$
  SELECT net.http_post(
    url := 'https://fvyvtdwsomxfkpxwygpk.supabase.co/functions/v1/weekly-competitor-search',
    headers := '{"Authorization": "Bearer SERVICE_ROLE_KEY", "Content-Type": "application/json"}'::jsonb,
    body := '{}'::jsonb
  );
  $$
);

-- Check scheduled jobs:   select jobid, schedule, jobname from cron.job;
-- Check recent runs:      select * from cron.job_run_details order by start_time desc limit 20;
