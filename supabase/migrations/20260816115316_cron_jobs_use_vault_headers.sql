-- Re-point every scheduled job at private.cron_request_headers() so no
-- credential is stored in cron.job.command any more.
--
-- Companion to 20260816114944_cron_secrets_into_vault.sql, which defines the
-- helper and explains why this was needed.
--
-- Each job's URL is rebuilt from its own existing row (function slug) and its
-- schedule is carried over verbatim, so this cannot silently retime or
-- re-target a job through a transcription slip across 22 jobs.
-- cron.schedule() upserts by name, so this replaces rather than duplicates.
--
-- Idempotent: re-running rewrites each command to the same text.
do $$
declare
  j record;
  v_slug text;
  v_uses_service_role boolean;
  v_updated int := 0;
begin
  for j in select jobname, schedule, command from cron.job loop
    v_slug := substring(j.command from 'functions/v1/([a-z0-9-]+)');

    -- Skip anything that is not a standard edge-function invocation rather
    -- than guessing at its shape.
    if v_slug is null then
      raise notice 'skipping % — no functions/v1 target found', j.jobname;
      continue;
    end if;

    -- opportunity-scanner authenticates with the service_role key rather than
    -- the shared cron secret; detected from the encoded role claim in its
    -- then-current inline JWT, not assumed from the job name. (On a re-run
    -- this is already false for every job, since the inline JWTs are gone —
    -- which is why the check below is written against the ORIGINAL command
    -- text and this migration is not the place to change which key a job
    -- uses. Adjust the argument explicitly if that ever needs to change.)
    v_uses_service_role := j.command like '%InNlcnZpY2Vfcm9sZSI%'
                        or j.command like '%cron_request_headers(true)%';

    perform cron.schedule(
      j.jobname,
      j.schedule,
      format(
        'select net.http_post(url := %L, headers := private.cron_request_headers(%s), body := ''{}''::jsonb);',
        'https://fvyvtdwsomxfkpxwygpk.supabase.co/functions/v1/' || v_slug,
        case when v_uses_service_role then 'true' else 'false' end
      )
    );
    v_updated := v_updated + 1;
  end loop;

  raise notice 'rescheduled % job(s) onto Vault-sourced headers', v_updated;
end $$;
