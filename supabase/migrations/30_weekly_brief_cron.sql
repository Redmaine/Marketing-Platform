-- Item 5 — Friday 09:00 Europe/London weekly content brief email.
--
-- pg_cron runs in UTC and has no timezone support, and 09:00 London is 08:00
-- UTC in BST (summer) but 09:00 UTC in GMT (winter). So we schedule BOTH and
-- the send-weekly-brief function only actually sends on the invocation where
-- London local time is 09:00 (the other one no-ops). This keeps the send at
-- exactly 09:00 London year-round with no manual DST changes.
--
-- Replace <SERVICE_ROLE_KEY> with the project's service_role JWT before running
-- (this repo copy keeps the placeholder; the live cron was created with the
-- real token). Same pattern as the other cron jobs on this project.

select cron.unschedule('weekly-brief-0800') where exists (select 1 from cron.job where jobname='weekly-brief-0800');
select cron.unschedule('weekly-brief-0900') where exists (select 1 from cron.job where jobname='weekly-brief-0900');

select cron.schedule('weekly-brief-0800', '0 8 * * 5', $$
  select net.http_post(
    url := 'https://fvyvtdwsomxfkpxwygpk.supabase.co/functions/v1/send-weekly-brief',
    headers := '{"Authorization": "Bearer <SERVICE_ROLE_KEY>", "Content-Type": "application/json"}'::jsonb,
    body := '{}'::jsonb
  );
$$);

select cron.schedule('weekly-brief-0900', '0 9 * * 5', $$
  select net.http_post(
    url := 'https://fvyvtdwsomxfkpxwygpk.supabase.co/functions/v1/send-weekly-brief',
    headers := '{"Authorization": "Bearer <SERVICE_ROLE_KEY>", "Content-Type": "application/json"}'::jsonb,
    body := '{}'::jsonb
  );
$$);
