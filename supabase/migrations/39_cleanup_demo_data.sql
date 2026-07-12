-- =============================================================================
-- 39_cleanup_demo_data.sql — remove confirmed build-phase demo data
--
-- Confirmed with Adrian before running (see conversation record — not
-- guessed or inferred from a heuristic alone):
--
-- 1. mkt_tasks — 3 rows, exact-text match to 07_seed.sql's "Sample tasks"
--    (that migration's own comment), re-inserted with fabricated
--    current/relative dates on 2026-07-10. These were polluting the
--    morning digest ("Reply to 2 new Google reviews" in particular — no
--    client in this database has ever had a gbp_location_id set, so that
--    task could never have reflected real activity). Deleted by id, not
--    by text match, so this can never accidentally catch a real task that
--    happens to share similar wording in future.
--
-- 2. mkt_performance — all 54 rows. 100% synthetic: every row matches the
--    07_seed.sql formula exactly (reach = 2000 + week*350, impressions =
--    5200 + week*600, avg_rating always precisely 4.8, ad_spend always 0).
--    Checked for outliers first — zero rows deviated from the formula.
--    No real performance data has ever been recorded; the Reports section
--    is empty/useless until genuine data starts populating it.
--
-- NOT touched, per Adrian's explicit instruction:
--   - mkt_clients rows for Combat Ready HQ and Safe Hands Funeral Services
--     (both real, active=false is correct — paused/in-pipeline, not test data).
--   - mkt_tasks rows for the Hormonely first-comment and YCA LinkedIn
--     recurring tasks — real ongoing operational work.
-- =============================================================================

DELETE FROM public.mkt_tasks
WHERE id IN (
  'd2c47ed3-243a-43ac-b2e6-812565a8fc45', -- "Approve 3 Facebook posts"
  '71ea4501-2262-4c3a-b822-7f80b4a9beb4', -- "Reply to 2 new Google reviews"
  '9e9c287a-c0c7-4261-9af8-1f903a9f4f38'  -- "June report due"
);

DELETE FROM public.mkt_performance;
