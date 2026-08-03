-- =============================================================================
-- 76_reject_stale_crhq_post.sql
--
-- Reject the stale CRHQ Facebook post scheduled for 2026-08-01 18:00 (copy
-- preview: "European security has had a reality check this week...").
-- Confirmed the row exists (id 681edd5a-13ba-4fdc-8655-f8c0509a1d2b) via
-- query before writing this migration.
-- =============================================================================

update public.mkt_content_queue q
set status = 'rejected',
    rejection_reason = 'stale content',
    rejected_at = now()
from public.mkt_clients c
where c.id = q.client_id
  and c.slug = 'crhq'
  and q.platform = 'facebook'
  and q.scheduled_for = '2026-08-01 18:00:00+00'
  and q.body like 'European security has had a reality check this week%';
