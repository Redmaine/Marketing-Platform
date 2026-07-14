-- =============================================================================
-- 47_edge_function_errors.sql — edge_function_errors (cross-function error log)
--
-- No generic error-logging table existed before this — mkt_cron_log is
-- midnight-cron-specific (array-of-strings-per-run) and
-- mkt_content_queue.error_message is a single overwritten field scoped to one
-- row. This table is written to by midnight-cron, approve-blog, and
-- schedule-to-metricool on failure (see those functions), and read by
-- generate-daily-status for its edge_function_errors_last_24h section.
-- =============================================================================
create table if not exists public.edge_function_errors (
  id             uuid primary key default gen_random_uuid(),
  function_name  text not null,
  error_message  text not null,
  created_at     timestamptz default now()
);

create index if not exists edge_function_errors_created_at_idx on public.edge_function_errors(created_at desc);

alter table public.edge_function_errors enable row level security;

-- Agency admins can read the log; rows are written by the edge functions
-- using the service role (which bypasses RLS), so no insert policy is needed.
drop policy if exists "edge_function_errors_admin_read" on public.edge_function_errors;
create policy "edge_function_errors_admin_read" on public.edge_function_errors
  for select using (public.mkt_is_admin());
