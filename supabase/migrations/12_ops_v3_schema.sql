-- =============================================================================
-- 12_ops_v3_schema.sql — Marketing Ops v3 (June 2026)
-- ADDITIVE ONLY. Adapts the existing mkt_ schema to the v3 brief without
-- breaking the deployed frontend. Safe to re-run.
--
-- Run order: after 01–11. Then run 13_ops_v3_seed.sql.
-- =============================================================================

-- ── mkt_clients: master_prompt + slug ────────────────────────────────────────
alter table public.mkt_clients
  add column if not exists master_prompt text,
  add column if not exists slug          text;

-- slug is unique when present (allow nulls during backfill).
create unique index if not exists mkt_clients_slug_key
  on public.mkt_clients (slug) where slug is not null;

-- ── mkt_content_queue: allow 'draft' status (brief), keep existing values ─────
-- Existing flow uses 'pending' for awaiting-approval; we widen the allowed set
-- so 'draft' (brief wording) and 'pending' both validate. Default unchanged.
alter table public.mkt_content_queue
  drop constraint if exists mkt_content_queue_status_check;
alter table public.mkt_content_queue
  add constraint mkt_content_queue_status_check
  check (status in ('draft','pending','approved','scheduled','published','rejected'));

-- ── mkt_tasks: brief fields (title/notes/due_time/recurring) + wider types ────
alter table public.mkt_tasks
  add column if not exists title           text,
  add column if not exists notes           text,
  add column if not exists due_time        text,
  add column if not exists recurring       boolean default false,
  add column if not exists recurrence_rule text;

-- Keep the existing `task` column as the canonical display string. Mirror it
-- into title where title is null so both old and new readers work.
update public.mkt_tasks set title = task where title is null;

-- Widen task_type to the UNION of existing + brief types so old rows and new
-- rows both validate.
alter table public.mkt_tasks
  drop constraint if exists mkt_tasks_task_type_check;
alter table public.mkt_tasks
  add constraint mkt_tasks_task_type_check
  check (task_type in (
    -- existing
    'generate_posts','review_response','schedule_posts','ads_check','report_due','gbp_post',
    -- brief v3
    'facebook_post','linkedin_post','first_comment','apollo_reply','other'
  ));

-- ── mkt_reports: brief metrics ───────────────────────────────────────────────
alter table public.mkt_reports
  add column if not exists posts_published    integer,
  add column if not exists engagement_summary text,
  add column if not exists apollo_sends       integer,
  add column if not exists apollo_replies     integer,
  add column if not exists key_wins           text;

-- ── mkt_content_schedule: recurring posting schedule per client (new) ─────────
create table if not exists public.mkt_content_schedule (
  id          uuid primary key default gen_random_uuid(),
  created_at  timestamptz default now(),
  client_id   uuid references public.mkt_clients(id) on delete cascade,
  platform    text not null,
  day_of_week integer not null check (day_of_week between 0 and 6), -- 0=Sun
  time_uk     text not null,
  pillar      text,
  active      boolean default true
);

-- ── mkt_client_notes: free-text notes per client (new) ───────────────────────
create table if not exists public.mkt_client_notes (
  id         uuid primary key default gen_random_uuid(),
  created_at timestamptz default now(),
  client_id  uuid references public.mkt_clients(id) on delete cascade,
  note       text not null
);

-- ── RLS for the two new tables: admin full; client read-only own rows ─────────
do $$
declare t text;
begin
  foreach t in array array['mkt_content_schedule','mkt_client_notes']
  loop
    execute format('alter table public.%I enable row level security;', t);
    execute format('drop policy if exists "%s_admin_all" on public.%I;', t, t);
    execute format('create policy "%s_admin_all" on public.%I for all using (public.mkt_is_admin()) with check (public.mkt_is_admin());', t, t);
    execute format('drop policy if exists "%s_client_read" on public.%I;', t, t);
    execute format('create policy "%s_client_read" on public.%I for select using (client_id in (select public.mkt_user_client_ids()));', t, t);
  end loop;
end $$;

-- Helpful indexes for digest / calendar queries.
create index if not exists mkt_content_schedule_client_day on public.mkt_content_schedule (client_id, day_of_week) where active;
create index if not exists mkt_client_notes_client_created  on public.mkt_client_notes (client_id, created_at desc);
