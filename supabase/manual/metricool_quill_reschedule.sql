-- =============================================================================
-- metricool_quill_reschedule.sql
-- 1. Check whether the Quill launch post was scheduled to Metricool tonight.
-- 2. If it was not (no metricool_post_id), reset it for 29 June at 08:00 BST
--    so the edge function can be re-invoked to send it.
--
-- Run in Supabase SQL Editor (project fvyvtdwsomxfkpxwygpk).
-- =============================================================================

-- ── STEP 1: Inspect the current state of all recent Quill posts ──────────────
SELECT
  q.id,
  q.status,
  q.scheduled_for,
  q.metricool_post_id,
  LEFT(q.body, 80) AS body_preview,
  q.created_at
FROM public.mkt_content_queue  q
JOIN public.mkt_clients         c ON c.id = q.client_id
WHERE c.slug = 'quill'
ORDER BY q.created_at DESC
LIMIT 10;

-- ── STEP 2: Check the scheduled_posts log ────────────────────────────────────
SELECT
  sp.id,
  sp.platform,
  sp.scheduled_for,
  sp.metricool_post_id,
  sp.status,
  LEFT(sp.body, 80) AS body_preview,
  sp.created_at
FROM public.mkt_scheduled_posts sp
JOIN public.mkt_clients          c ON c.id = sp.client_id
WHERE c.slug = 'quill'
ORDER BY sp.created_at DESC
LIMIT 10;

-- =============================================================================
-- STEP 3: If the launch post has NO metricool_post_id (Metricool call failed),
-- run the block below to reset it for 29 June 08:00 BST.
-- After running, invoke the edge function manually:
--   supabase functions invoke schedule-to-metricool \
--     --project-ref fvyvtdwsomxfkpxwygpk \
--     --body '{"content_queue_id": "<paste id from STEP 1 here>"}'
-- =============================================================================
UPDATE public.mkt_content_queue SET
  status          = 'approved',
  scheduled_for   = '2026-06-29 08:00:00+01:00',
  metricool_post_id = NULL
WHERE id = (
  -- Targets the most recent Quill post that is approved/scheduled but
  -- has no Metricool confirmation ID.
  SELECT q.id
  FROM   public.mkt_content_queue q
  JOIN   public.mkt_clients       c ON c.id = q.client_id
  WHERE  c.slug = 'quill'
    AND  q.status IN ('approved', 'scheduled')
    AND  q.metricool_post_id IS NULL
  ORDER  BY q.created_at DESC
  LIMIT  1
);
-- Returns "UPDATE 0" if everything is fine (post already has a metricool_post_id).
-- Returns "UPDATE 1" if the post was reset — then invoke the edge function above.
