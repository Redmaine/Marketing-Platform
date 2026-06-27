-- =============================================================================
-- 16_metricool_schema.sql — Replace Buffer with Metricool (June 2026)
-- Additive only — existing buffer_* columns kept for historical records.
-- Run in Supabase SQL Editor (project fvyvtdwsomxfkpxwygpk).
-- =============================================================================

-- Add Metricool brand ID to clients (replaces buffer_profile_ids jsonb).
ALTER TABLE public.mkt_clients
  ADD COLUMN IF NOT EXISTS metricool_brand_id TEXT;

-- Add Metricool post ID columns on the two queue tables (replaces buffer_update_id).
ALTER TABLE public.mkt_content_queue
  ADD COLUMN IF NOT EXISTS metricool_post_id TEXT;

ALTER TABLE public.mkt_scheduled_posts
  ADD COLUMN IF NOT EXISTS metricool_post_id TEXT;

-- Set brand IDs per client.
UPDATE public.mkt_clients SET metricool_brand_id = '6469995' WHERE slug = 'yca';
UPDATE public.mkt_clients SET metricool_brand_id = '6470001' WHERE slug = 'ps';
UPDATE public.mkt_clients SET metricool_brand_id = '6469945' WHERE slug = 'quill';
UPDATE public.mkt_clients SET metricool_brand_id = '6470002' WHERE slug = 'hormonely';
UPDATE public.mkt_clients SET metricool_brand_id = '6470004' WHERE slug = 'riverside';
