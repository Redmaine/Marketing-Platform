-- =============================================================================
-- 82_get_anthropic_api_key_rpc.sql
--
-- opportunity-scanner-worker-background.mjs (Netlify) needs to read the
-- ANTHROPIC_API_KEY out of the Supabase vault at runtime instead of
-- process.env, because the Netlify site's own copy of that env var is wrong.
--
-- The requested query — SELECT decrypted_secret FROM vault.decrypted_secrets
-- WHERE name = 'ANTHROPIC_API_KEY' LIMIT 1 — cannot be run directly from
-- application code via the Supabase JS client. Confirmed live before writing
-- this: a REST call to /rest/v1/decrypted_secrets with Accept-Profile: vault
-- (i.e. exactly what supabase-js's .schema('vault').from('decrypted_secrets')
-- sends under the hood), using the service_role key, returns:
--   406 PGRST106 "Invalid schema: vault. Only the following schemas are
--   exposed: public, graphql_public."
-- PostgREST's schema whitelist blocks `vault` at the API gateway regardless
-- of which key is used — this is a hard platform restriction, not fixable
-- by permissions/RLS. The standard Supabase pattern for reading a vault
-- secret from application code is a SECURITY DEFINER wrapper function in
-- `public` (which IS exposed), invoked via .rpc() instead of a direct table
-- read. The exact SELECT requested lives inside this function's body.
--
-- Deliberately narrow rather than a generic get_vault_secret(name text):
-- hardcoded to this one secret, no parameter, so this function can only
-- ever be used to fetch ANTHROPIC_API_KEY — not turned into a general
-- "read any vault secret by name" endpoint. EXECUTE is revoked from
-- PUBLIC/anon/authenticated and granted to service_role only, so this is
-- reachable only by a caller already holding the service_role key (the same
-- trust boundary that key already implies — full DB access — not a new
-- exposure), never by a browser or an anon/authenticated JWT.
-- =============================================================================

create or replace function public.get_anthropic_api_key()
returns text
language sql
security definer
set search_path = public, vault
as $$
  select decrypted_secret from vault.decrypted_secrets where name = 'ANTHROPIC_API_KEY' limit 1;
$$;

revoke all on function public.get_anthropic_api_key() from public;
revoke all on function public.get_anthropic_api_key() from anon;
revoke all on function public.get_anthropic_api_key() from authenticated;
grant execute on function public.get_anthropic_api_key() to service_role;
