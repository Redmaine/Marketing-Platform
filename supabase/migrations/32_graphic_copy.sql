-- Item 7 — weekly graphic copy (Monday 07:00). Copy only; never auto-posted.
create table if not exists mkt_graphic_copy (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references mkt_clients(id) on delete cascade,
  week_of date not null,                 -- the Monday this graphic is for
  headline text not null,                -- max 6 words
  highlight_word text,                   -- the one word in headline to accent
  subline text,                          -- max 8 words
  status text not null default 'draft' check (status in ('draft','approved','rejected')),
  created_at timestamptz not null default now(),
  unique (client_id, week_of)
);
create index if not exists mkt_graphic_copy_client_week_idx on mkt_graphic_copy (client_id, week_of desc);
alter table mkt_graphic_copy enable row level security;
drop policy if exists mkt_graphic_copy_admin_all on mkt_graphic_copy;
create policy mkt_graphic_copy_admin_all on mkt_graphic_copy
  for all using (mkt_is_admin()) with check (mkt_is_admin());

-- Monday 07:00 Europe/London cron (Item 7). pg_cron is UTC; scheduled at both
-- 06:00 and 07:00 UTC Monday, generate-graphics only runs at 07:00 London.
-- Created live reusing the existing cron's service-role auth (placeholder):
--   select cron.schedule('graphic-copy-0700','0 7 * * 1', $$
--     select net.http_post(url:='https://fvyvtdwsomxfkpxwygpk.supabase.co/functions/v1/generate-graphics',
--       headers:='{"Authorization":"Bearer <SERVICE_ROLE_KEY>","Content-Type":"application/json"}'::jsonb, body:='{}'::jsonb); $$);
