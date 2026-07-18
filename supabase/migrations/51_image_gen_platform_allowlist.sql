-- =============================================================================
-- 51_image_gen_platform_allowlist.sql
--
-- mkt_clients.image_gen_platforms — a per-client ALLOW-list of the platforms
-- image generation may run for. Empty/NULL means "no restriction", so every
-- client without one keeps its current behaviour exactly.
--
-- Why a new column rather than reusing image_gen_disabled_platforms (the
-- existing per-platform deny-list from migration 44):
--   1. The ask is "only Instagram, never any other platform". A deny-list can
--      only name the platforms that exist today (facebook/linkedin/twitter);
--      an allow-list stays correct if a new platform is connected later.
--   2. image_gen_disabled_platforms is ALSO the automatic failure kill-switch —
--      generatePostImage appends to it when Stability errors, and migration
--      44 documents clearing it (`set image_gen_disabled_platforms = '{}'`)
--      to re-enable after fixing the cause. Storing intentional config in the
--      same array means that documented reset would silently switch Facebook
--      image generation back on. Keeping deliberate config separate from the
--      failure switch avoids that.
--
-- CRHQ is set to Instagram-only. No other client is touched.
--
-- Apply in the Supabase SQL editor (this project's convention — see
-- migration 44's header re: the schema_migrations history gap).
-- =============================================================================

ALTER TABLE public.mkt_clients
  ADD COLUMN IF NOT EXISTS image_gen_platforms text[] NOT NULL DEFAULT '{}';

COMMENT ON COLUMN public.mkt_clients.image_gen_platforms IS
  'Allow-list of platforms image generation may run for. Empty = all platforms allowed.';

-- Combat Ready HQ: images on Instagram only. Facebook, LinkedIn, Twitter/X and
-- anything added later are skipped entirely — no Anthropic summarisation, no
-- Stability call, no upload.
UPDATE public.mkt_clients
  SET image_gen_platforms = '{instagram}'
  WHERE slug = 'crhq';
