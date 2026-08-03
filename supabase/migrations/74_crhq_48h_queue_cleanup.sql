-- =============================================================================
-- 74_crhq_48h_queue_cleanup.sql
--
-- Incident fix: CRHQ content is time-sensitive (geopolitics/defence, goes
-- stale within hours — see crhq-nightly-content/index.ts's own header) and
-- must never be queued more than 48 hours ahead. As of 2026-08-01, two CRHQ
-- posts had been generated for Thursday 6 August and Saturday 8 August —
-- both violate the 48-hour rule.
--
-- mkt_content_queue has no status literally named 'pending' in CRHQ's own
-- generated rows — this codebase's cron-generated awaiting-review status is
-- 'draft' (migration 12's own comment: "'draft' (brief wording) and
-- 'pending' both validate" — i.e. 'draft' IS this schema's "pending").
-- Confirmed by querying live data before writing this migration: exactly
-- the two rows matching status IN ('draft','approved') AND scheduled_for >
-- now() + 48h were the 6/8 August facebook posts the brief named.
--
-- NOT included in this cleanup: three further CRHQ rows also beyond 48h out
-- (2 x instagram, 1 x facebook, spanning 4-6 August) but already
-- status='scheduled' — i.e. already committed to Metricool with a live
-- publish time. Deleting those from mkt_content_queue alone would NOT
-- un-schedule them from Metricool; it would only delete our own record of
-- a post Metricool still intends to publish, leaving it orphaned. That
-- needs an actual Metricool unschedule call (DELETE
-- /v2/scheduler/posts/{id}), which is a materially different and riskier
-- operation than this migration's plain DELETE — flagged for a separate,
-- explicit decision rather than done silently here.
-- =============================================================================

do $$
declare
  v_count integer;
begin
  select count(*) into v_count
  from public.mkt_content_queue q
  join public.mkt_clients c on c.id = q.client_id
  where c.slug = 'crhq'
    and q.status in ('draft', 'approved')
    and q.scheduled_for > now() + interval '48 hours';

  raise notice 'CRHQ 48h-queue-rule violations found (status draft/approved, scheduled_for > now()+48h): %', v_count;

  delete from public.mkt_content_queue q
  using public.mkt_clients c
  where c.id = q.client_id
    and c.slug = 'crhq'
    and q.status in ('draft', 'approved')
    and q.scheduled_for > now() + interval '48 hours';

  raise notice 'CRHQ 48h-queue-rule violations deleted: %', v_count;
end $$;
