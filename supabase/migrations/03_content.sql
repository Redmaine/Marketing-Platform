-- =============================================================================
-- 03_content.sql — mkt_content_queue, mkt_scheduled_posts, mkt_published_posts
-- =============================================================================

create table if not exists public.mkt_content_queue (
  id              uuid primary key default gen_random_uuid(),
  created_at      timestamptz default now(),
  client_id       uuid references public.mkt_clients(id) on delete cascade,
  platform        text check (platform in ('facebook','instagram','google_business','blog','ad_facebook','ad_google')),
  content_type    text check (content_type in ('post','review_response','ad','blog')),
  pillar          text,
  body            text not null,
  status          text check (status in ('pending','approved','scheduled','published','rejected')) default 'pending',
  scheduled_for   timestamptz,
  buffer_update_id text,
  approved_at     timestamptz,
  approved_by     text,
  generated_by    text check (generated_by in ('ai','human','cron'))
);

create table if not exists public.mkt_scheduled_posts (
  id               uuid primary key default gen_random_uuid(),
  created_at       timestamptz default now(),
  client_id        uuid references public.mkt_clients(id) on delete cascade,
  content_queue_id uuid references public.mkt_content_queue(id),
  platform         text,
  body             text,
  scheduled_for    timestamptz,
  buffer_update_id text,
  status           text check (status in ('scheduled','sent','failed'))
);

create table if not exists public.mkt_published_posts (
  id               uuid primary key default gen_random_uuid(),
  published_at     timestamptz,
  client_id        uuid references public.mkt_clients(id) on delete cascade,
  platform         text,
  body             text,
  reach            integer,
  impressions      integer,
  engagement       integer,
  clicks           integer,
  buffer_update_id text
);

-- RLS: admin full; client read-only of their own rows.
do $$
declare t text;
begin
  foreach t in array array['mkt_content_queue','mkt_scheduled_posts','mkt_published_posts']
  loop
    execute format('alter table public.%I enable row level security;', t);
    execute format('drop policy if exists "%s_admin_all" on public.%I;', t, t);
    execute format('create policy "%s_admin_all" on public.%I for all using (public.mkt_is_admin()) with check (public.mkt_is_admin());', t, t);
    execute format('drop policy if exists "%s_client_read" on public.%I;', t, t);
    execute format('create policy "%s_client_read" on public.%I for select using (client_id in (select public.mkt_user_client_ids()));', t, t);
  end loop;
end $$;
