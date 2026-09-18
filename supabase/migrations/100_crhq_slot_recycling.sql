-- 100_crhq_slot_recycling.sql — 18 Sep 2026
-- Slot recycling for CRHQ (supabase/functions/_shared/crhqRecycle.ts): a post
-- whose slot passes unpublished is regenerated once into a future open slot.
-- Three nullable columns on the shared queue table, written only by that
-- module and only for CRHQ rows; no other brand's rows carry values.
--   recycled_at    on the original — when it was closed off (once only)
--   recycled_into  on the original — the new row it became, if one was made
--   recycled_from  on the new row  — the original it came from
-- The original's status becomes 'recycled' (a rejected original stays
-- 'rejected'); 'recycled' is terminal and outside every queued/stuck/
-- pending set the pipeline and the sweeps look at.
alter table public.mkt_content_queue
  add column if not exists recycled_at timestamptz,
  add column if not exists recycled_into uuid references public.mkt_content_queue(id) on delete set null,
  add column if not exists recycled_from uuid references public.mkt_content_queue(id) on delete set null;

-- Rejected posts were dropped from eligibility the same day (a rejection is
-- a deliberate human decision, never quietly retried); the predicate below
-- is a superset of what the module queries, which is harmless for an index.
create index if not exists mkt_content_queue_recycle_candidates_idx
  on public.mkt_content_queue (client_id, platform, scheduled_for)
  where content_type = 'post' and metricool_post_id is null and recycled_at is null
    and status in ('draft', 'pending', 'approved', 'rejected');

-- Both columns are check-constrained (the first live run proved it: every
-- insert and every close failed on the constraint). 'recycled' joins each
-- allowed list; nothing else in either list changes.
alter table public.mkt_content_queue drop constraint if exists mkt_content_queue_status_check;
alter table public.mkt_content_queue add constraint mkt_content_queue_status_check
  check (status = any (array['draft','pending','approved','scheduled','published','rejected','recycled']));
alter table public.mkt_content_queue drop constraint if exists mkt_content_queue_content_source_check;
alter table public.mkt_content_queue add constraint mkt_content_queue_content_source_check
  check (content_source is null or content_source = any (array['youtube_scrape','pillar_fallback','themed_weekly','recycled']));
