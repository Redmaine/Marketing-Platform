-- =============================================================================
-- 52_image_gen_allowlist_all_clients.sql
--
-- Extends the migration-51 allow-list to the remaining brands, so Stability AI
-- is no longer called for Facebook posts whose image is discarded anyway
-- (schedule-to-metricool strips image_url for Facebook globally — see its
-- line ~148 — so a Facebook image is generated, paid for, and never published).
--
-- ⚠️ CORRECTED GUARD — the originally-supplied SQL used
--       AND image_gen_platforms IS NULL
--     which would have matched ZERO rows and silently updated nothing.
--     Migration 51 declared the column as:
--       image_gen_platforms text[] NOT NULL DEFAULT '{}'
--     so no row is ever NULL — an unconfigured client holds an EMPTY ARRAY.
--     The guard below is `= '{}'`, which preserves the original intent
--     ("only set clients that haven't been configured yet", i.e. don't
--     overwrite crhq's existing '{instagram}') and actually matches.
--
-- Apply in the Supabase SQL editor (this project's convention — see migration
-- 44's header re: the schema_migrations history gap).
-- =============================================================================

UPDATE public.mkt_clients
SET image_gen_platforms = '{instagram}'
WHERE slug IN ('yca', 'ps', 'quill', 'hormonely', 'ouay', 'steady', 'neuro-decoded')
  AND image_gen_platforms = '{}';

-- Verification — run this after the UPDATE. Every listed brand should show
-- {instagram}; crhq should already show {instagram} from migration 51.
-- 'riverside' is deliberately NOT in the list above (it wasn't in the brief) —
-- it will still show {} here, meaning it keeps generating Facebook images.
-- To include it, add 'riverside' to the IN list and re-run.
SELECT slug, image_gen_platforms, connected_platforms
FROM public.mkt_clients
ORDER BY slug;
