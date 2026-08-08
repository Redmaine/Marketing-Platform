-- =============================================================================
-- 94_clear_stale_riverside_queue_for_new_direction.sql
--
-- Removes 4 Riverside (mkt_clients.slug = 'riverside') posts from
-- mkt_content_queue that were generated BEFORE the relationship-led content
-- direction (migration 92) landed — all four still referenced the dead
-- riversidesm.co.uk domain and, in three cases, banned words (precision/
-- bespoke) the new master_prompt explicitly forbids:
--
--   eee945e9-7567-4374-9270-2fb59b004877  approved   2026-08-24T09:00:00+00:00
--     (was about to publish live with the dead domain link)
--   27b9be1f-227c-44c4-8c76-26e06d9c6e1a  draft      2026-08-10T09:00:00+00:00
--   56dbae8b-bbd9-4e7a-9050-5f7603d7e267  draft      2026-08-12T09:00:00+00:00
--   04a0c2a1-6d9c-4c01-8357-1881ce3c76de  draft      2026-08-17T09:00:00+00:00
--
-- Confirmed before deleting: none had a metricool_post_id (nothing synced to
-- an external scheduler to clean up), and none had status 'sent' or
-- 'published' — only the one 'approved' row and three 'draft' rows were
-- touched, per the explicit scope of this change. This frees up queue
-- headroom so fillClientGap (the nightly cron) generates fresh Riverside
-- posts under the new master_prompt instead of the window already reading
-- as full from stale pre-migration-92 content.
--
-- Applied directly against the live table and confirmed removed (28 -> 24
-- rows for this client; remaining rows: 15 scheduled, 7 draft, 2 rejected —
-- no sent/published rows exist for this client at all). This migration
-- documents that same change as an idempotent DELETE — a rerun after these
-- IDs are already gone is a no-op.
-- =============================================================================

DELETE FROM public.mkt_content_queue
WHERE id IN (
  'eee945e9-7567-4374-9270-2fb59b004877',
  '27b9be1f-227c-44c4-8c76-26e06d9c6e1a',
  '56dbae8b-bbd9-4e7a-9050-5f7603d7e267',
  '04a0c2a1-6d9c-4c01-8357-1881ce3c76de'
);
