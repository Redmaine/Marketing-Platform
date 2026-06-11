-- =============================================================================
-- 10_cron_log.sql — mkt_cron_log (run history for the scheduled jobs)
-- =============================================================================
create table if not exists public.mkt_cron_log (
  id                 uuid primary key default gen_random_uuid(),
  created_at         timestamptz default now(),
  job_name           text,
  clients_processed  integer default 0,
  posts_generated    integer default 0,
  errors             text[],
  duration_ms        integer
);

alter table public.mkt_cron_log enable row level security;

-- Agency admins can read the log; rows are written by the cron functions using
-- the service role (which bypasses RLS), so no insert policy is needed.
drop policy if exists "mkt_cron_log_admin_read" on public.mkt_cron_log;
create policy "mkt_cron_log_admin_read" on public.mkt_cron_log
  for select using (public.mkt_is_admin());
