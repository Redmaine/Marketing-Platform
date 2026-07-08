-- Item 3 (Quill review step) + Item 4 (published posts log).
--
-- Every generated post now goes through an automated review before it reaches
-- the approval queue. These columns record the outcome on the queue row.
--   review_status: NULL = not yet reviewed (legacy rows),
--                  'passed' = review passed, shown with a "Reviewed" badge,
--                  'needs_attention' = failed twice, shown with the reason so
--                                      Adrian can see why the slot is empty.
--   reviewed_at:   timestamp the (final) review ran.
--   review_reason: the failure reason when needs_attention.
--   generation_attempts: how many times we generated for this slot (max 2).
alter table mkt_content_queue
  add column if not exists review_status text
    check (review_status in ('passed','needs_attention')),
  add column if not exists reviewed_at timestamptz,
  add column if not exists review_reason text,
  add column if not exists generation_attempts int not null default 1;

-- Item 4 — published posts log. Written when Metricool confirms a post was
-- sent. Read by the review step (repeat-topic check) and the Published tab.
create table if not exists published_posts (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references mkt_clients(id) on delete cascade,
  brand text not null,                 -- denormalised client name for display
  date_sent timestamptz not null default now(),
  platform text not null,
  content_pillar text,
  post_copy text not null,
  metricool_post_id text,
  content_queue_id uuid references mkt_content_queue(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists published_posts_client_date_idx
  on published_posts (client_id, date_sent desc);
-- Guards against double-logging the same scheduled post.
create unique index if not exists published_posts_queue_uniq
  on published_posts (content_queue_id) where content_queue_id is not null;

alter table published_posts enable row level security;

-- Admins (agency) can read/write everything; same gate the rest of the mkt_*
-- tables use (mkt_is_admin on the caller's JWT). Service role bypasses RLS,
-- so the edge functions that write the log are unaffected.
drop policy if exists published_posts_admin_all on published_posts;
create policy published_posts_admin_all on published_posts
  for all using (mkt_is_admin()) with check (mkt_is_admin());
