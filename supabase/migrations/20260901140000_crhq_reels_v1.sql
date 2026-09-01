-- =============================================================================
-- 20260901140000_crhq_reels_v1.sql — CRHQ Instagram Reels pipeline, v1.
--
-- Craig/Adrian supply an ALREADY-VERTICAL clip (15-45s). Automated
-- horizontal->vertical cropping is deliberately out of scope: it needs real
-- CPU (Supabase Edge Functions cap at 2s CPU / 256MB, so video transcoding
-- cannot run there at all) and would mean a Netlify+ffmpeg build or a paid
-- video API, for what is a few seconds of manual work in CapCut or YouTube
-- Studio's own export. See the feasibility investigation.
--
-- Everything else reuses proven paths: Supabase Storage public URLs (as the
-- image pipeline already does), Replicate async submit+poll (as callFlux
-- already does), and the SAME /v2/scheduler/posts Metricool endpoint
-- schedule-to-metricool already calls.
-- =============================================================================

-- 'reel' as a first-class content_type. Deliberately NOT reusing 'post':
-- mkt_content_queue_one_auto_post_per_slot is scoped to content_type='post',
-- and a Reel is supplementary content that must not consume (or be blocked
-- by) a brand's one-auto-post-per-day slot.
alter table public.mkt_content_queue
  drop constraint if exists mkt_content_queue_content_type_check;
alter table public.mkt_content_queue
  add constraint mkt_content_queue_content_type_check
  check (content_type = any (array['post'::text, 'review_response'::text, 'ad'::text, 'blog'::text, 'reel'::text]));

-- The raw clip exactly as supplied by Craig/Adrian, before captions. Kept
-- separately from video_url so a captioning failure or a re-run never loses
-- the only copy of the source, and so a caption re-run has something to
-- re-process without a re-upload.
alter table public.mkt_content_queue
  add column if not exists source_video_url text;

-- The captioned, ready-to-publish clip. This is what gets attached to the
-- Metricool post. Null until captioning has genuinely succeeded — never
-- populated speculatively, so "has a video_url" always means "there is a
-- real, fetchable, captioned file", the same contract image_url already has.
alter table public.mkt_content_queue
  add column if not exists video_url text;

-- Captioning state, so a failure is visible rather than looking like a clip
-- that simply hasn't been processed yet.
--   pending    — uploaded, not yet sent to Replicate
--   processing — submitted, prediction in flight
--   complete   — video_url populated
--   failed     — see caption_error
alter table public.mkt_content_queue
  add column if not exists caption_status text
  check (caption_status is null or caption_status = any (array['pending','processing','complete','failed']));

alter table public.mkt_content_queue
  add column if not exists caption_error text;

-- Replicate prediction id, for tracing a specific run back to Replicate's own
-- dashboard when a caption result looks wrong.
alter table public.mkt_content_queue
  add column if not exists caption_prediction_id text;

create index if not exists mkt_content_queue_reels_idx
  on public.mkt_content_queue (client_id, content_type, caption_status)
  where content_type = 'reel';

comment on column public.mkt_content_queue.source_video_url is
  'Raw vertical clip as supplied by a human, before captioning. Reels only.';
comment on column public.mkt_content_queue.video_url is
  'Captioned, ready-to-publish vertical clip. Attached to the Metricool post. Reels only; null until captioning really succeeded.';
