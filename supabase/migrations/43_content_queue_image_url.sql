-- =============================================================================
-- 43_content_queue_image_url.sql — mkt_content_queue.image_url
--
-- Written by generatePostImage (_shared/image.ts) after a successful Stability
-- AI generation + mkt-assets upload. Stays NULL if generation/upload fails or
-- STABILITY_AI_API_KEY is unset — the post itself is never blocked on this;
-- the approval queue UI flags a NULL image_url as "Image missing".
--
-- Apply via `supabase db query --linked`, not `db push` (see migration 35's
-- history — the schema_migrations ledger has a pre-existing gap).
-- =============================================================================

ALTER TABLE public.mkt_content_queue ADD COLUMN IF NOT EXISTS image_url text;
