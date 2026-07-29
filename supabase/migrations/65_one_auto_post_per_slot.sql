-- =============================================================================
-- 65_one_auto_post_per_slot.sql
--
-- Part 8 — stop duplicate posts at the source.
--
-- WHAT WAS ACTUALLY HAPPENING
-- The audit found zero duplicate BODIES, so this was never one write repeated:
-- it was several different posts landing on one slot. Three groups existed:
--
--   19 Jul 09:00  Neuro Decoded  3x generated_by='cron', inserted 00:00:27,
--                 00:00:32 and 00:00:38 in a single midnight run — concurrent
--                 fillClientGap passes each reading "no post here yet" before
--                 any of them had inserted.
--   03 Aug 09:00  Neuro Decoded  2x generated_by='ai', six days apart.
--   03 Aug 19:00  Hormonely      1x 'cron' + 1x 'ai', a day apart.
--
-- So it is not one bug in one code path. fillClientGap's hasAutoPostOnDate
-- check is a read-then-write with nothing between the read and the write, and
-- the 'ai' paths (generate-content / backfill-content) reach the same table by
-- a different route. Any guard added inside one function leaves the others
-- open, and none of them close the race.
--
-- THE FIX
-- A partial UNIQUE INDEX. It is the only mechanism that is race-proof — two
-- concurrent transactions cannot both win — and it applies to every write path
-- automatically, including any added later. Scoped to auto-generated posts
-- ('ai'/'cron') so a human deliberately placing a manual post is never
-- blocked, and to non-rejected rows so a rejected post frees its slot.
--
-- WHY FOUR ROWS ARE EXEMPT
-- All seven pre-existing duplicate rows are status='scheduled' AND already
-- carry a metricool_post_id — they are live in Metricool. Deleting them here
-- would NOT unschedule them: the duplicate would still post publicly while
-- disappearing from the calendar, which is the display-layer fix this is
-- explicitly meant to avoid. They are therefore exempted by id rather than
-- removed, and the two future ones are being surfaced for removal through
-- delete-post, which cancels in Metricool first.
--
-- Apply via `supabase db query -f ... --linked` — NOT `supabase db push`.
-- =============================================================================

CREATE UNIQUE INDEX IF NOT EXISTS mkt_content_queue_one_auto_post_per_slot
  ON public.mkt_content_queue (client_id, platform, scheduled_for)
  WHERE content_type = 'post'
    AND status <> 'rejected'
    AND generated_by IN ('ai', 'cron')
    -- Pre-existing duplicates, live in Metricool — see header.
    AND id NOT IN (
      '3492468f-9eab-4ace-82d8-8bcffb7a9504'::uuid,
      '5ae59a38-ffd8-4f5e-a7f4-0bbad34c3a5a'::uuid,
      '92e4ad9d-ff80-44e3-8203-e5daef248f29'::uuid,
      'f1ec56df-3b40-47ee-bbc5-1cd2492557cd'::uuid
    );

-- Verification: the index exists, and no NEW collision can be created.
SELECT indexname FROM pg_indexes WHERE indexname = 'mkt_content_queue_one_auto_post_per_slot';
