-- =============================================================================
-- 38_rejected_digest_cron.sql — daily 07:00 Europe/London rejected-posts digest
--
-- pg_cron runs in UTC and has no timezone support, and 07:00 London is 06:00
-- UTC in BST (summer) but 07:00 UTC in GMT (winter). So — same pattern as
-- 30_weekly_brief_cron.sql — this schedules BOTH, and send-rejected-digest
-- only actually sends on the invocation where London local time is 07:00
-- (the other one no-ops). Keeps the send at exactly 07:00 London year-round
-- with no manual DST changes.
--
-- MANUAL STEP REQUIRED: send-rejected-digest checks for a service_role JWT
-- (same as send-weekly-brief), so <SERVICE_ROLE_KEY> below must be replaced
-- with the project's real service_role key before running this — same as
-- every other cron job in this project (see 11_cron_jobs.sql,
-- 30_weekly_brief_cron.sql). That's a live credential, so it's intentionally
-- left as a placeholder in this committed file and was NOT filled in or run
-- automatically. Get the key from Supabase dashboard -> Settings -> API,
-- substitute it into both blocks below, and run this in the SQL editor (or
-- `supabase db query --linked -f supabase/migrations/38_rejected_digest_cron.sql`
-- after editing a local, uncommitted copy — do not commit the real key).
-- =============================================================================

select cron.unschedule('rejected-digest-0600') where exists (select 1 from cron.job where jobname='rejected-digest-0600');
select cron.unschedule('rejected-digest-0700') where exists (select 1 from cron.job where jobname='rejected-digest-0700');

select cron.schedule('rejected-digest-0600', '0 6 * * *', $$
  select net.http_post(
    url := 'https://fvyvtdwsomxfkpxwygpk.supabase.co/functions/v1/send-rejected-digest',
    headers := '{"Authorization": "Bearer <SERVICE_ROLE_KEY>", "Content-Type": "application/json"}'::jsonb,
    body := '{}'::jsonb
  );
$$);

select cron.schedule('rejected-digest-0700', '0 7 * * *', $$
  select net.http_post(
    url := 'https://fvyvtdwsomxfkpxwygpk.supabase.co/functions/v1/send-rejected-digest',
    headers := '{"Authorization": "Bearer <SERVICE_ROLE_KEY>", "Content-Type": "application/json"}'::jsonb,
    body := '{}'::jsonb
  );
$$);
