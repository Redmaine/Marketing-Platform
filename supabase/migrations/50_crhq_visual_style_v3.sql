-- =============================================================================
-- 50_crhq_visual_style_v3.sql
--
-- CRHQ visual_style, third pass. Migration 44's "single focal point" brief
-- moved away from busy map/collage imagery but was still steering toward a
-- literal intelligence-briefing look (tactical/military aesthetic, clean and
-- minimal) rather than something visually compelling. Replaced with a
-- deliberately more cinematic, high-production-value brief.
--
-- Apply via the Supabase SQL editor (see this session's established
-- convention for this project — not `db push`, not `db query`; no local
-- tool in this environment can run SQL directly against the live DB).
-- =============================================================================

UPDATE public.mkt_clients SET visual_style =
  'near black background, dramatic cinematic lighting, tactical military equipment close-up, bold contrast, dark and authoritative, no people, no text, photorealistic detail, high production value'
  WHERE slug = 'crhq';
