-- =============================================================================
-- 44_crhq_visual_style_and_image_disable.sql
--
-- 1. CRHQ visual_style: the previous brief (migration 42) explicitly asked for
--    "map or intelligence imagery", which is exactly the busy/collage-style
--    output that's been failing — replaced with a tighter, single-focal-point
--    brief.
-- 2. mkt_clients.image_gen_disabled_platforms: per-client, per-platform image
--    generation kill switch. Set by generatePostImage (_shared/image.ts) when
--    a client's generated image prompt fails its style-prefix check, or the
--    Stability AI call itself errors (e.g. content-policy rejection of a
--    tactical/military prompt) — scoped to the one platform that failed, so
--    e.g. CRHQ Facebook can disable itself without touching CRHQ Instagram.
--    Reset by clearing the array manually once the underlying issue is fixed:
--      update mkt_clients set image_gen_disabled_platforms = '{}' where slug = 'crhq';
--
-- Apply via `supabase db query --linked`, not `db push` (see migration 35's
-- history — the schema_migrations ledger has a pre-existing gap).
-- =============================================================================

ALTER TABLE public.mkt_clients ADD COLUMN IF NOT EXISTS image_gen_disabled_platforms text[] NOT NULL DEFAULT '{}';

UPDATE public.mkt_clients SET visual_style =
  'dark near-black background, single strong focal point only, no text overlaid on the image, no maps, no collages, military or tactical aesthetic, clean and minimal, high contrast — one strong image element only, never multiple'
  WHERE slug = 'crhq';
