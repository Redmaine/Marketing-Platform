-- =============================================================================
-- 79_clear_stale_needs_attention_queue.sql
--
-- Parts 1-5 of the "clear stale needs_attention queue" task. Five separate
-- DO blocks, run in the exact order specified, each logging its own count
-- via RAISE NOTICE immediately before its own DELETE. Deliberately kept
-- sequential in one file rather than five migrations so each block's
-- "before" count reflects the queue state after every prior block in this
-- file has already run (Part 1 is broad and overlaps with Parts 2-5's
-- per-brand sets, so running them out of order would double-count).
--
-- Every block scopes to review_status = 'needs_attention' only — status
-- 'sent', 'scheduled', or 'published' rows are never touched by any of
-- these (needs_attention posts are never in those statuses in this schema
-- anyway, since a post only reaches needs_attention pre-approval, but the
-- explicit status exclusion on Part 1 is kept as a belt-and-braces guard
-- matching the brief exactly).
-- =============================================================================

-- ── Part 1 — every brand, needs_attention, scheduled before 2026-08-05 ────────
do $$
declare
  v_count integer;
begin
  select count(*) into v_count
  from public.mkt_content_queue
  where review_status = 'needs_attention'
    and scheduled_for < '2026-08-05'
    and status not in ('sent', 'scheduled', 'published');

  raise notice 'Part 1 — stale needs_attention posts (scheduled_for < 2026-08-05): %', v_count;

  delete from public.mkt_content_queue
  where review_status = 'needs_attention'
    and scheduled_for < '2026-08-05'
    and status not in ('sent', 'scheduled', 'published');
end $$;

-- ── Part 2 — Quill, Facebook, needs_attention (no date filter) ────────────────
do $$
declare
  v_count integer;
begin
  select count(*) into v_count
  from public.mkt_content_queue q
  join public.mkt_clients c on c.id = q.client_id
  where c.slug = 'quill' and q.platform = 'facebook' and q.review_status = 'needs_attention';

  raise notice 'Part 2 — Quill Facebook needs_attention posts: %', v_count;

  delete from public.mkt_content_queue q
  using public.mkt_clients c
  where c.id = q.client_id
    and c.slug = 'quill' and q.platform = 'facebook' and q.review_status = 'needs_attention';
end $$;

-- ── Part 3 — Hormonely, Facebook, needs_attention (no date filter) ────────────
do $$
declare
  v_count integer;
begin
  select count(*) into v_count
  from public.mkt_content_queue q
  join public.mkt_clients c on c.id = q.client_id
  where c.slug = 'hormonely' and q.platform = 'facebook' and q.review_status = 'needs_attention';

  raise notice 'Part 3 — Hormonely Facebook needs_attention posts: %', v_count;

  delete from public.mkt_content_queue q
  using public.mkt_clients c
  where c.id = q.client_id
    and c.slug = 'hormonely' and q.platform = 'facebook' and q.review_status = 'needs_attention';
end $$;

-- ── Part 4 — OUAY, Facebook, needs_attention (no date filter) ─────────────────
do $$
declare
  v_count integer;
begin
  select count(*) into v_count
  from public.mkt_content_queue q
  join public.mkt_clients c on c.id = q.client_id
  where c.slug = 'ouay' and q.platform = 'facebook' and q.review_status = 'needs_attention';

  raise notice 'Part 4 — OUAY Facebook needs_attention posts: %', v_count;

  delete from public.mkt_content_queue q
  using public.mkt_clients c
  where c.id = q.client_id
    and c.slug = 'ouay' and q.platform = 'facebook' and q.review_status = 'needs_attention';
end $$;

-- ── Part 5 — Problem. Solution., Facebook, needs_attention (no date filter) ───
do $$
declare
  v_count integer;
begin
  select count(*) into v_count
  from public.mkt_content_queue q
  join public.mkt_clients c on c.id = q.client_id
  where c.slug = 'ps' and q.platform = 'facebook' and q.review_status = 'needs_attention';

  raise notice 'Part 5 — Problem. Solution. Facebook needs_attention posts: %', v_count;

  delete from public.mkt_content_queue q
  using public.mkt_clients c
  where c.id = q.client_id
    and c.slug = 'ps' and q.platform = 'facebook' and q.review_status = 'needs_attention';
end $$;
