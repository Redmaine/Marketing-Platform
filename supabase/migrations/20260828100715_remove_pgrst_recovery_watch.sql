-- =============================================================================
-- 20260828100715_remove_pgrst_recovery_watch.sql
--
-- Decommissions the PGRST303 recovery watcher (migration 104). Supabase
-- support confirmed the platform-wide incident resolved and the project was
-- restarted; the watcher's own state table records the moment it detected
-- recovery and fired its one-time alert:
--
--   detected_at: 2026-08-28 10:05:01 UTC
--   note: "PostgREST service-role access recovered after ~43h"
--
-- Real before/after evidence, not just the alert: net._http_response shows
-- sweep-stuck-metricool-posts still failing with "JWT issued at future" at
-- 10:00:00 UTC, and ordinary cron-triggered functions returning clean 200s
-- from 10:05:19 UTC onward.
--
-- Per migration 104's own removal note, the job is unscheduled here and the
-- edge function (supabase/functions/pgrst-recovery-watch) has been deleted
-- from the project and removed from this repo. It was a response to one
-- incident, not permanent infrastructure. The pgrst_recovery_watch state
-- table is left in place as a historical record of when the incident ended.
--
-- Note: by the time this migration ran, cron.job already had no row for
-- 'pgrst-recovery-watch' — it appears to have already been unscheduled
-- before this cleanup, so the unschedule below is a defensive no-op guard
-- rather than the actual removal.
-- =============================================================================

do $$
begin
  if exists (select 1 from cron.job where jobname = 'pgrst-recovery-watch') then
    perform cron.unschedule('pgrst-recovery-watch');
  end if;
end $$;
