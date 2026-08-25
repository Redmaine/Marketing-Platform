-- 20260825201500_rls_bst_correction_audit_tables.sql
--
-- Closes three ERROR-level `rls_disabled_in_public` findings raised by
-- Supabase's own security advisor (lint 0013).
--
-- WHAT WAS WRONG
-- The one-off BST correction of 2026-08-21 left three audit/snapshot tables
-- behind. 20260821140500_bst_correct_pre_fix_scheduled_times.sql creates
-- mkt_schedule_bst_correction_20260821 with a plain `create table` and never
-- enables RLS; the two mkt_metricool_*_20260821 tables were created ad hoc
-- during the same incident and were never in a migration at all. Supabase's
-- default grants hand anon and authenticated full
-- SELECT/INSERT/UPDATE/DELETE/TRUNCATE on every new table in `public`, and
-- with RLS off nothing else stood in the way — so all three were readable AND
-- writable AND deletable over PostgREST by anyone holding the (public,
-- client-side) anon key. Verified before this migration with a real anonymous
-- HTTP GET: all three returned 200 with live rows.
--
-- Worst case was not the read. mkt_schedule_bst_correction_20260821 is, in the
-- words of its own comment, "the only record of the prior values" for 226
-- corrected rows — an anonymous DELETE would have destroyed the sole record of
-- what the schedule looked like before the correction, unrecoverably.
--
-- THE FIX, AND WHY THIS SHAPE
-- Same pattern the other internal, admin-only mkt_* tables already use
-- (mkt_cron_log, mkt_monthly_reports, mkt_post_performance): enable RLS, then
-- exactly one SELECT policy gated on mkt_is_admin(). Deliberately no INSERT,
-- UPDATE or DELETE policy — these are frozen forensic snapshots of an incident
-- that is closed. Nothing should ever write to them again, and under RLS the
-- absence of a policy is the denial.
--
-- mkt_is_admin() reads auth.jwt()->>'email', so it is false for anon rather
-- than an error, and service_role bypasses RLS entirely — which is why no
-- backend path breaks here. Confirmed by grep: no application code reads these
-- tables at runtime; the only references anywhere are inside the migration
-- that created them.

alter table public.mkt_schedule_bst_correction_20260821 enable row level security;
alter table public.mkt_metricool_bst_resync_20260821    enable row level security;
alter table public.mkt_metricool_resync_batch_20260821  enable row level security;

drop policy if exists mkt_schedule_bst_correction_20260821_admin_read on public.mkt_schedule_bst_correction_20260821;
create policy mkt_schedule_bst_correction_20260821_admin_read
  on public.mkt_schedule_bst_correction_20260821
  for select using (mkt_is_admin());

drop policy if exists mkt_metricool_bst_resync_20260821_admin_read on public.mkt_metricool_bst_resync_20260821;
create policy mkt_metricool_bst_resync_20260821_admin_read
  on public.mkt_metricool_bst_resync_20260821
  for select using (mkt_is_admin());

drop policy if exists mkt_metricool_resync_batch_20260821_admin_read on public.mkt_metricool_resync_batch_20260821;
create policy mkt_metricool_resync_batch_20260821_admin_read
  on public.mkt_metricool_resync_batch_20260821
  for select using (mkt_is_admin());

-- The two metricool tables never had one; the incident they belong to is only
-- legible from the migration above, so point at it from the tables themselves.
comment on table public.mkt_metricool_bst_resync_20260821 is
  'Per-post resync requests issued during the one-off BST scheduling correction of 2026-08-21. Frozen audit record; see 20260821140500_bst_correct_pre_fix_scheduled_times.sql.';
comment on table public.mkt_metricool_resync_batch_20260821 is
  'Metricool create/delete request pairs for the 2026-08-21 BST re-push (old and new post ids per queue row). Frozen audit record; see 20260821140500_bst_correct_pre_fix_scheduled_times.sql.';
