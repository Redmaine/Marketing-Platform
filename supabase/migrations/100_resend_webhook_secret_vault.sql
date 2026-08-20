-- Vault-backed storage for the Resend webhook signing secret, mirroring
-- get_cron_secret()'s exact pattern (see _shared/cronAuth.ts's header for
-- why: a secret stored in Vault never has to pass through a shell command,
-- a query result, or an env var to be set or rotated — set_resend_webhook_secret
-- is called directly by the one-off setup function that registers the
-- webhook with Resend, from inside the same request that receives Resend's
-- API response, so the plaintext secret never leaves that one process.
--
-- resend-webhook/index.ts previously read RESEND_WEBHOOK_SECRET from a plain
-- env var, which was never set (see that file's 20 Aug 2026 header note —
-- the webhook was fully built but never connected). Connected 20 Aug 2026.
create or replace function public.set_resend_webhook_secret(new_secret text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if exists (select 1 from vault.secrets where name = 'resend_webhook_secret') then
    perform vault.update_secret(
      (select id from vault.secrets where name = 'resend_webhook_secret'),
      new_secret
    );
  else
    perform vault.create_secret(new_secret, 'resend_webhook_secret', 'Signing secret for Resend webhook events (resend-webhook edge function)');
  end if;
end;
$$;

create or replace function public.get_resend_webhook_secret()
returns text
language sql
security definer
set search_path = ''
as $$
  select decrypted_secret from vault.decrypted_secrets where name = 'resend_webhook_secret'
$$;

revoke all on function public.set_resend_webhook_secret(text) from public, anon, authenticated;
revoke all on function public.get_resend_webhook_secret() from public, anon, authenticated;
grant execute on function public.set_resend_webhook_secret(text) to service_role;
grant execute on function public.get_resend_webhook_secret() to service_role;
