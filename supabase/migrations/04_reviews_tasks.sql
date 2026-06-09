-- =============================================================================
-- 04_reviews_tasks.sql — mkt_reviews, mkt_tasks
-- =============================================================================

create table if not exists public.mkt_reviews (
  id              uuid primary key default gen_random_uuid(),
  created_at      timestamptz default now(),
  client_id       uuid references public.mkt_clients(id) on delete cascade,
  platform        text check (platform in ('google','facebook','trustpilot')),
  reviewer_name   text,
  rating          integer check (rating between 1 and 5),
  body            text,
  review_date     date,
  response_body   text,
  response_status text check (response_status in ('pending','drafted','published')) default 'pending',
  gbp_review_id   text
);

create table if not exists public.mkt_tasks (
  id           uuid primary key default gen_random_uuid(),
  created_at   timestamptz default now(),
  client_id    uuid references public.mkt_clients(id) on delete cascade,
  task         text not null,
  task_type    text check (task_type in ('generate_posts','review_response','schedule_posts','ads_check','report_due','gbp_post')),
  priority     integer default 2,
  overdue      boolean default false,
  due_date     date,
  completed    boolean default false,
  completed_at timestamptz
);

do $$
declare t text;
begin
  foreach t in array array['mkt_reviews','mkt_tasks']
  loop
    execute format('alter table public.%I enable row level security;', t);
    execute format('drop policy if exists "%s_admin_all" on public.%I;', t, t);
    execute format('create policy "%s_admin_all" on public.%I for all using (public.mkt_is_admin()) with check (public.mkt_is_admin());', t, t);
    execute format('drop policy if exists "%s_client_read" on public.%I;', t, t);
    execute format('create policy "%s_client_read" on public.%I for select using (client_id in (select public.mkt_user_client_ids()));', t, t);
  end loop;
end $$;
