-- =============================================================================
-- 54_crhq_add_instagram_platform.sql
--
-- Adds Instagram to CRHQ so the content pipeline generates for facebook AND
-- instagram.
--
-- ⚠️ THE connected_platforms UPDATE ALONE MAY NOT BE ENOUGH. Platform
-- selection lives in clientPlatforms() (_shared/fill.ts):
--
--   const scheduled  = active rows in mkt_content_schedule for this client
--   const candidates = scheduled.length ? scheduled : client.connected_platforms
--   return candidates.filter(p => isPlatformConnected(client, p))   // gate on
--                                                                   // connected_platforms
--
-- So connected_platforms is a hard GATE (nothing outside it is ever
-- generated), but the CANDIDATE LIST comes from mkt_content_schedule whenever
-- that table has active rows for the client. Two cases:
--
--   A. CRHQ has NO active mkt_content_schedule rows
--      → candidates = connected_platforms → the UPDATE below is sufficient.
--
--   B. CRHQ HAS active mkt_content_schedule rows (facebook only)
--      → candidates = ['facebook'], and the connected_platforms change has
--        NO effect whatsoever. An instagram schedule row is also required.
--
-- This file handles both. Step 2 only inserts instagram rows if the client
-- already uses schedule rows — deliberately NOT unconditionally, because
-- inserting an instagram row into a client that currently has none would
-- flip candidates from connected_platforms to ['instagram'] and silently
-- STOP Facebook generation.
--
-- Apply in the Supabase SQL editor (this project's convention).
-- =============================================================================

-- ── 1. connected_platforms: the gate. Required in both cases. ────────────────
-- (Postgres trims whitespace around unquoted array elements, so the spaced
-- form in the brief would also have parsed fine; written tight for clarity.)
UPDATE public.mkt_clients
SET connected_platforms = '{facebook,instagram}'
WHERE slug = 'crhq';

-- ── 2. Case B only: mirror every active facebook schedule row to instagram ───
-- Same day_of_week / time_uk / pillar as the existing facebook rows, so the
-- Instagram cadence matches what's already working for Facebook. No-op for
-- Case A (no facebook rows → nothing inserted → step 1 governs).
INSERT INTO public.mkt_content_schedule (client_id, platform, day_of_week, time_uk, pillar, active)
SELECT s.client_id, 'instagram', s.day_of_week, s.time_uk, s.pillar, true
FROM public.mkt_content_schedule s
JOIN public.mkt_clients c ON c.id = s.client_id
WHERE c.slug = 'crhq'
  AND s.platform = 'facebook'
  AND s.active = true
  AND NOT EXISTS (
    SELECT 1 FROM public.mkt_content_schedule x
    WHERE x.client_id = s.client_id
      AND x.platform = 'instagram'
      AND x.day_of_week = s.day_of_week
      AND x.time_uk = s.time_uk
  );

-- ── 3. Verification — run these and check the result ─────────────────────────
-- Expect connected_platforms = {facebook,instagram}.
SELECT slug, name, connected_platforms, metricool_brand_id, post_days, post_time
FROM public.mkt_clients
WHERE slug = 'crhq';

-- If this returns NO rows, CRHQ is Case A and step 1 is all that was needed.
-- If it returns rows, they must now cover BOTH facebook and instagram.
SELECT s.platform, s.day_of_week, s.time_uk, s.pillar, s.active
FROM public.mkt_content_schedule s
JOIN public.mkt_clients c ON c.id = s.client_id
WHERE c.slug = 'crhq'
ORDER BY s.platform, s.day_of_week;
