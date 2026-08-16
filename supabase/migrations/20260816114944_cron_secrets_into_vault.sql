-- Secrets out of cron.job.command, into Vault.
--
-- Every scheduled job stored its credentials as literal text inside
-- cron.job.command, so any SELECT on cron.job printed them in full. That
-- happened three times in a single session. Care is not a control; this
-- removes the secret from the table instead.
--
-- Companion migration: 20260816115316_cron_jobs_use_vault_headers.sql
-- re-points every job at the helper defined here.
--
-- The Vault rows themselves are created out-of-band (see the runbook note at
-- the bottom) rather than in this file, because a migration is committed to
-- git and must never carry secret material:
--   * cron_secret       — generated inside Postgres with gen_random_bytes so
--                         the plaintext never leaves the database at all
--   * anon_key          — public by design, lifted from an existing job row
--   * service_role_key  — lifted from the opportunity-scanner job row
--
-- The helper lives in a `private` schema, NOT public: PostgREST only exposes
-- configured schemas (public by default), so nothing here is reachable over
-- the API regardless of grants. The explicit revokes are belt-and-braces on
-- top of that, because these functions return live credentials and are
-- SECURITY DEFINER.

create schema if not exists private;
revoke all on schema private from public;
revoke all on schema private from anon, authenticated;

-- Builds the header block for a scheduled HTTP call, reading each credential
-- from Vault at call time. Cron job commands call this instead of carrying
-- credentials inline.
--
-- use_service_role: opportunity-scanner authenticates with the service_role
-- key rather than the shared cron secret (it predates the shared-secret
-- pattern), so it needs the same helper with a different key.
create or replace function private.cron_request_headers(use_service_role boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_api_key text;
  v_cron_secret text;
begin
  select decrypted_secret into v_api_key
  from vault.decrypted_secrets
  where name = case when use_service_role then 'service_role_key' else 'anon_key' end;

  select decrypted_secret into v_cron_secret
  from vault.decrypted_secrets
  where name = 'cron_secret';

  -- Fail loudly rather than firing an unauthenticated request. A missing
  -- secret means the job does not run, which is the safe direction.
  if v_api_key is null or v_cron_secret is null then
    raise exception 'cron_request_headers: a required Vault secret is missing (api_key present=%, cron_secret present=%)',
      v_api_key is not null, v_cron_secret is not null;
  end if;

  return jsonb_build_object(
    'Authorization',  'Bearer ' || v_api_key,
    'apikey',         v_api_key,
    'x-cron-secret',  v_cron_secret,
    'Content-Type',   'application/json'
  );
end;
$$;

revoke all on function private.cron_request_headers(boolean) from public;
revoke all on function private.cron_request_headers(boolean) from anon, authenticated;

-- Read path for the edge functions' shared cronAuth check
-- (supabase/functions/_shared/cronAuth.ts). Kept in public because PostgREST
-- can only call RPCs in an exposed schema, but locked to service_role: any
-- caller holding that key can already do anything, so this adds no reachable
-- surface that did not already exist.
create or replace function public.get_cron_secret()
returns text
language sql
security definer
set search_path = ''
as $$
  select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret'
$$;

revoke all on function public.get_cron_secret() from public;
revoke all on function public.get_cron_secret() from anon, authenticated;
grant execute on function public.get_cron_secret() to service_role;

-- ── Runbook: seeding / rotating the Vault rows ──────────────────────────────
-- Run manually against the project (NOT committed with values, and never
-- pasted from a shell — generating in-database is the whole point):
--
--   select vault.create_secret(
--     encode(extensions.gen_random_bytes(32), 'hex'), 'cron_secret',
--     'x-cron-secret header value for pg_cron jobs');
--
--   select vault.create_secret(
--     (select substring(command from 'Bearer (eyJ[A-Za-z0-9._-]+)')
--        from cron.job where jobname = 'cron-healthcheck'), 'anon_key', '...');
--
--   select vault.create_secret(
--     (select substring(command from 'Bearer (eyJ[A-Za-z0-9._-]+)')
--        from cron.job where jobname = 'opportunity-scanner'),
--     'service_role_key', '...');
--
-- To rotate the cron secret later, without the value ever being seen:
--
--   select vault.update_secret(
--     (select id from vault.secrets where name = 'cron_secret'),
--     encode(extensions.gen_random_bytes(32), 'hex'));
--
-- Edge functions pick the new value up on their next cold start; nothing else
-- needs changing, because no copy of it exists anywhere outside Vault.
