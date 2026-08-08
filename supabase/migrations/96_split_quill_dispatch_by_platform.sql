-- =============================================================================
-- 96_split_quill_dispatch_by_platform.sql
--
-- Splits Quill's nightly generation dispatch into two genuinely independent
-- invocations — Facebook and LinkedIn — so a large combined backlog across
-- both platforms can no longer strain a single client invocation toward
-- midnight-cron's 150s-per-client execution budget (see midnight-cron/
-- index.ts's own header for that architecture).
--
-- No code change was needed to achieve this: midnight-cron already dispatches
-- one independent request per ACTIVE mkt_clients row (not per platform), and
-- a dedicated "Quill — LinkedIn" client row (mkt_clients.slug =
-- 'quill-linkedin') already existed from an earlier build task. The actual
-- problem was that the MAIN "Quill" row (slug 'quill') still also had
-- 'linkedin' in connected_platforms AND an active mkt_content_schedule row
-- for linkedin — so it was independently generating LinkedIn content for the
-- SAME Metricool brand (6469945) as "Quill — LinkedIn", on the SAME dates.
-- Confirmed live before this fix: 4 duplicate draft LinkedIn posts existed
-- under the main Quill row for 11/18/25 Aug and 1 Sep — the exact same dates
-- "Quill — LinkedIn" had already drafted independently.
--
-- This migration:
--   1. Trims the main Quill row's connected_platforms to ['facebook'] only
--      (was ['facebook','linkedin']) — LinkedIn generation now belongs
--      exclusively to the dedicated "Quill — LinkedIn" row, which already
--      dispatches as its own independent midnight-cron invocation.
--   2. Deactivates the erroneous linkedin mkt_content_schedule row that had
--      been added to the main Quill row (id 8f343adb-6b14-4aa2-b302-
--      615bee1bd195) — kept, not deleted, for history.
--   3. Removes the 4 confirmed-duplicate draft LinkedIn posts already
--      generated under the main Quill row's client_id (logged before
--      deletion; all were status='draft', none had a metricool_post_id).
--
-- Applied directly against the live tables and confirmed after: the two
-- Quill rows now have disjoint connected_platforms (['facebook'] and
-- ['linkedin']) and zero linkedin rows remain under the main Quill
-- client_id. This migration documents that same change, idempotently.
-- =============================================================================

UPDATE public.mkt_clients
SET connected_platforms = ARRAY['facebook']
WHERE id = 'b6d35682-5737-4987-9223-73ec4592e418'
  AND connected_platforms @> ARRAY['linkedin'];

UPDATE public.mkt_content_schedule
SET active = false
WHERE id = '8f343adb-6b14-4aa2-b302-615bee1bd195'
  AND active = true;

DELETE FROM public.mkt_content_queue
WHERE id IN (
  '5c49eef5-7ae5-47d1-9f25-e1f8ade8093c',
  '315cbf1c-e042-4e15-b85b-d55f8b35cb93',
  '5f212176-54f6-4006-aeca-2d612cc75925',
  'c25ea3c4-edeb-4594-bc86-a08167ce9675'
);
