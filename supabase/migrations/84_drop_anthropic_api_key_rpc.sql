-- =============================================================================
-- 84_drop_anthropic_api_key_rpc.sql
--
-- Reverts migration 82: opportunity-scanner-worker-background.mjs no longer
-- reads ANTHROPIC_API_KEY from the Supabase vault via this RPC — it now
-- reads process.env.ANTHROPIC_API_KEY directly, like every other Netlify
-- function in this repo. The wrapper function has no remaining callers.
-- =============================================================================

DROP FUNCTION IF EXISTS public.get_anthropic_api_key();
