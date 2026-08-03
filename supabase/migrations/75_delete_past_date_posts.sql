-- =============================================================================
-- 75_delete_past_date_posts.sql
--
-- Clean-up: delete every mkt_content_queue row still sitting in an
-- awaiting-approval state (pending/draft/approved) with a scheduled_for in
-- the past (before 2026-08-01) — these are stale drafts that were never
-- approved before their slot passed, across every brand, not just CRHQ.
--
-- 'pending' and 'draft' are both this schema's awaiting-approval statuses
-- (see mkt_content_queue_status_check, migration 12's own comment: "'draft'
-- (brief wording) and 'pending' both validate"). 'sent' does not exist as a
-- status value in this schema at all (the real terminal-and-live states are
-- scheduled/published/rejected) — included in the brief's "do not touch"
-- list regardless, harmlessly: no row can ever match a status that doesn't
-- exist, so it needs no special handling here. scheduled_for is the real
-- column name (the brief calls it scheduled_date).
--
-- Row count logged via RAISE NOTICE before deleting, confirmed by query
-- before writing this migration: 30 rows.
-- =============================================================================

do $$
declare
  v_count integer;
begin
  select count(*) into v_count
  from public.mkt_content_queue
  where status in ('pending', 'draft', 'approved')
    and scheduled_for < '2026-08-01';

  raise notice 'Past-date pending/draft/approved posts found (scheduled_for < 2026-08-01): %', v_count;

  delete from public.mkt_content_queue
  where status in ('pending', 'draft', 'approved')
    and scheduled_for < '2026-08-01';

  raise notice 'Past-date pending/draft/approved posts deleted: %', v_count;
end $$;
