-- =============================================================================
-- 48_daily_status_cron.sql — add generate-daily-status to the morning-digest job
--
-- Deliberately NOT a separate cron.schedule() job (that would break this
-- repo's usual "one net.http_post per job" convention, but was an explicit
-- requirement: "add this to the existing 07:00 cron alongside the digest
-- email, do not create a separate cron job"). Re-running cron.schedule with
-- the existing job name ('morning-digest') updates it in place.
--
-- Note: the digest actually runs at 07:30 UTC, not 07:00 (see 11_cron_jobs.sql)
-- — the new call is added at that same real time so both fire together.
--
-- Run in the Supabase SQL editor.
-- =============================================================================

select cron.schedule(
  'morning-digest',
  '30 7 * * *',
  $$
  select net.http_post(
    url := 'https://fvyvtdwsomxfkpxwygpk.supabase.co/functions/v1/send-digest',
    headers := '{"Authorization": "Bearer SERVICE_ROLE_KEY", "Content-Type": "application/json"}'::jsonb,
    body := '{}'::jsonb
  );
  select net.http_post(
    url := 'https://fvyvtdwsomxfkpxwygpk.supabase.co/functions/v1/generate-daily-status',
    headers := '{"Authorization": "Bearer SERVICE_ROLE_KEY", "Content-Type": "application/json"}'::jsonb,
    body := '{}'::jsonb
  );
  $$
);
