-- =============================================================================
-- 83_reschedule_past_dated_queue_posts.sql
--
-- Fix 2 (approval queue must never show past-dated posts) — this migration
-- is the one-off data-correction half; "never shown" itself is a frontend
-- filter change in ContentQueue.jsx (not a DB change), done alongside this.
--
-- The task's own given SQL —
--   SELECT COUNT(*) FROM mkt_content_queue WHERE scheduled_for < NOW()
--   AND status IN ('pending','approved','draft')
--   AND review_status NOT IN ('rejected','failed')
-- — references two review_status values, 'rejected' and 'failed', that do
-- not exist in this schema's CHECK constraint (the only real values are
-- 'passed', 'needs_attention', 'blog_dependent', and null — consistent
-- with every prior migration this session touching review_status). Beyond
-- being a no-op, `review_status NOT IN (...)` would also silently drop any
-- row whose review_status IS NULL (three-valued NULL logic) — a second,
-- latent bug had the values been real. Both are avoided by dropping the
-- clause entirely; status IN (...) + scheduled_for < now() is the filter
-- that actually matters.
--
-- Confirmed live before writing this: 5 rows match (2 draft/blog_dependent
-- for Steady/facebook, 3 approved/passed for Neuro Decoded/facebook — all
-- 5 with metricool_post_id IS NULL, i.e. none have actually gone out, so
-- moving scheduled_for is safe and doesn't misrepresent a real send).
--
-- Reschedule logic mirrors supabase/functions/_shared/fill.ts's
-- nextEmptySlot() exactly: per-platform mkt_content_schedule rows win when
-- active ones exist for this client+platform, else client.post_days (day
-- names -> 0=Sun..6=Sat), else Mon-Fri; "empty" = no other non-rejected
-- post already on that calendar day for this client+platform; walked
-- forward up to 45 days (fill.ts's own SAFETY_MAX_DAYS_WALKED) before
-- giving up on a row and leaving it untouched rather than guessing.
-- Starts the walk at today rather than fill.ts's usual "tomorrow" — these
-- are past-due rows being pulled forward, not currently-occupied slots
-- being displaced, and the task's own instruction is explicit: "work
-- forward from today".
-- =============================================================================

do $$
declare
  v_count integer;
  r record;
  v_days int[];
  v_day date;
  v_dow int;
  v_slot timestamptz;
  v_occupied boolean;
  v_walked int;
  v_found boolean;
  day_name_map jsonb := '{"sunday":0,"monday":1,"tuesday":2,"wednesday":3,"thursday":4,"friday":5,"saturday":6}'::jsonb;
begin
  select count(*) into v_count
  from public.mkt_content_queue
  where status in ('pending','draft','approved') and scheduled_for < now();
  raise notice 'Past-dated pending/draft/approved posts found: %', v_count;

  for r in
    select q.id, q.client_id, q.platform, c.post_days, c.post_time
    from public.mkt_content_queue q
    join public.mkt_clients c on c.id = q.client_id
    where q.status in ('pending','draft','approved')
      and q.scheduled_for < now()
      and q.content_type = 'post'
    order by q.scheduled_for asc
  loop
    -- Per-platform schedule wins when active rows exist for this
    -- client+platform (mirrors platformSchedule in fill.ts).
    select array_agg(day_of_week) into v_days
    from public.mkt_content_schedule
    where client_id = r.client_id and platform = r.platform and active = true;

    -- Else client.post_days (day names -> numbers), else Mon-Fri (mirrors
    -- clientPostingDays in fill.ts).
    if v_days is null then
      select array_agg((day_name_map ->> lower(trim(d)))::int) into v_days
      from unnest(r.post_days) as d
      where day_name_map ? lower(trim(d));
      if v_days is null or array_length(v_days, 1) is null then
        v_days := array[1,2,3,4,5];
      end if;
    end if;

    v_day := current_date;
    v_walked := 0;
    v_found := false;
    while v_walked < 45 and not v_found loop
      v_walked := v_walked + 1;
      v_dow := extract(dow from v_day);
      if v_dow = any(v_days) then
        select exists(
          select 1 from public.mkt_content_queue
          where client_id = r.client_id and platform = r.platform and content_type = 'post'
            and status != 'rejected' and id != r.id
            and scheduled_for::date = v_day
        ) into v_occupied;
        if not v_occupied then
          v_slot := (v_day::text || ' ' || coalesce(r.post_time::text, '09:00:00') || '+00')::timestamptz;
          -- A day can be "empty" only because the row being rescheduled was
          -- its sole occupant (excluded via id != r.id above) — if that day
          -- is today and its slot time has already passed, reassigning it
          -- to the same already-past moment would leave the row exactly as
          -- past-dated as it started. Skip straight to the next day instead.
          if v_slot > now() then
            update public.mkt_content_queue set scheduled_for = v_slot where id = r.id;
            raise notice 'Rescheduled % (client %, platform %) -> %', r.id, r.client_id, r.platform, v_slot;
            v_found := true;
          end if;
        end if;
      end if;
      v_day := v_day + 1;
    end loop;

    if not v_found then
      raise notice 'Could not find an empty slot within 45 days for % (client %, platform %) — left unchanged', r.id, r.client_id, r.platform;
    end if;
  end loop;
end $$;
