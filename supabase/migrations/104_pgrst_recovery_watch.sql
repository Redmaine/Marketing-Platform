-- =============================================================================
-- 104_pgrst_recovery_watch.sql
--
-- Watches for the END of the PGRST303 outage and alerts once when it clears.
--
-- Background: from 2026-08-26 15:29 UTC, PostgREST rejected every
-- service-role request with PGRST303 ("JWT issued at future"), taking the
-- whole content pipeline down. Confirmed 28 Aug as a platform-wide Supabase
-- incident (status.supabase.com — "Increased response times for requests",
-- identified 01:38 UTC, rollback in progress), not a fault in this project.
-- Measured here: 12 probes 5s apart, 0 successes — deterministic, so there
-- was no point building a retry.
--
-- Since the recovery time is outside our control and the pipeline has been
-- dead for two days, the useful thing is to know the minute it returns. The
-- edge function probes the exact request that is failing and emails once.
--
-- The state table is what makes it fire ONCE rather than every five minutes
-- forever after. The flag is written through PostgREST deliberately: at the
-- moment of recovery PostgREST is by definition working, so the probe and the
-- write succeed or fail together and cannot disagree.
--
-- REMOVAL: once Supabase confirm the incident is closed and the alert has
-- fired, unschedule with
--   select cron.unschedule('pgrst-recovery-watch');
-- and drop this function. It is a response to one incident, not permanent
-- infrastructure.
-- =============================================================================

create table if not exists public.pgrst_recovery_watch (
  id            uuid primary key default gen_random_uuid(),
  detected_at   timestamptz not null default now(),
  note          text
);

alter table public.pgrst_recovery_watch enable row level security;

-- Every 5 minutes. Cheap (one REST probe, no AI, no external calls unless it
-- actually recovers) and tight enough to notice promptly.
select cron.schedule(
  'pgrst-recovery-watch',
  '*/5 * * * *',
  $$select net.http_post(
      url := 'https://fvyvtdwsomxfkpxwygpk.supabase.co/functions/v1/pgrst-recovery-watch',
      headers := private.cron_request_headers(true),
      body := '{}'::jsonb
    );$$
);
