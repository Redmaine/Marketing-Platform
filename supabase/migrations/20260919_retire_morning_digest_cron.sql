-- =============================================================================
-- 20260919_retire_morning_digest_cron.sql — retire the separate morning digest.
--
-- send-digest ("Good morning — here's your day", 07:30 UTC) is merged into
-- notify-daily-ops (10:35 UTC) so Adrian gets one morning email instead of
-- two — see notify-daily-ops/index.ts's own header for the full writeup.
--
-- This unschedules the 'morning-digest' cron job. send-digest itself is left
-- deployed as a stubbed no-op (see that function's own header) rather than
-- deleted, as a second line of defence — if this unschedule somehow didn't
-- take, the function returns 200 and sends nothing rather than a real
-- duplicate email reappearing.
-- =============================================================================

select cron.unschedule('morning-digest');

-- Check remaining scheduled jobs: select jobid, schedule, jobname from cron.job;
