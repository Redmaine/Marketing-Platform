-- =============================================================================
-- 20_connected_platforms.sql
-- Adds connected_platforms column to mkt_clients.
-- Default all existing clients to ['facebook'] until other platforms are
-- explicitly connected.
-- Idempotent. Run in Supabase SQL Editor (project fvyvtdwsomxfkpxwygpk).
-- =============================================================================

ALTER TABLE public.mkt_clients
  ADD COLUMN IF NOT EXISTS connected_platforms text[] DEFAULT ARRAY['facebook'];

-- Ensure existing rows have the default (covers rows inserted before this migration).
UPDATE public.mkt_clients
SET connected_platforms = ARRAY['facebook']
WHERE connected_platforms IS NULL;
