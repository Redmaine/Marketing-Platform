-- =============================================================================
-- 20260829120000_ops_known_events.sql
--
-- New table: ops_known_events — a small log of "explained" windows that
-- daily-ops-check cross-references before it flags an edge_function_errors
-- row as needing human action. Two real cases it exists for:
--
--   1. A recorded platform restart/incident (e.g. the 28 Aug PGRST303
--      outage — see migration 20260828100715's own note; that one isn't
--      backfilled here because only its recovery moment was ever captured
--      precisely, not its onset, and by the time this table exists the
--      target date it happened on is long past daily-ops-check's rolling
--      "yesterday" window anyway).
--   2. Deliberate test activity against real production functions (Code
--      redeploying/exercising a function for real verification, same as
--      done repeatedly this week) — insert a row via
--      _shared/opsKnownEvents.ts's recordOpsKnownEvent() around that work
--      so the next daily-ops-check run doesn't re-report it as a fresh,
--      unexplained error.
--
-- function_name = null means the window applies to every function (a
-- whole-platform incident); a specific value scopes it to just that one
-- function (a targeted test of a single function).
--
-- RLS enabled, no policies — same standing pattern as every other table in
-- this project touched only by service-role Edge Functions: a hard deny for
-- anon/authenticated direct access, read/write only via the service role.
-- =============================================================================

create table if not exists ops_known_events (
  id uuid primary key default gen_random_uuid(),
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  function_name text,
  reason text not null,
  created_at timestamptz not null default now(),
  constraint ops_known_events_window_valid check (ends_at >= starts_at)
);

create index if not exists ops_known_events_window_idx
  on ops_known_events (starts_at, ends_at);

alter table ops_known_events enable row level security;

comment on table ops_known_events is
  'Explained windows (platform restarts/incidents, or deliberate test activity) that daily-ops-check treats as already ruled out when an edge_function_errors row falls inside one. function_name null applies to every function.';
