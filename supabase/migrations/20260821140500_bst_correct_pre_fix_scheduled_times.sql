-- =============================================================================
-- 20260821140500_bst_correct_pre_fix_scheduled_times.sql
--
-- One-off data correction for scheduled times written BEFORE commit 5a2faac
-- ("Fix scheduled posts firing an hour late during BST", 2026-08-18 08:47:43
-- UTC), which added supabase/functions/_shared/ukTime.ts's ukTimeSlotToUtc.
--
-- THE BUG
-- mkt_content_schedule.time_uk and mkt_clients.post_time are UK-local
-- wall-clock times. Every pre-fix scheduling call site built the slot with
-- `new Date(day); slot.setHours(hh, mm, 0, 0)`, and the Edge Function runtime's
-- local timezone is UTC — so an intended "09:00 UK" was written as 09:00 UTC.
-- During BST (UTC+1) that is 10:00 UK: exactly one hour late. Migration 83
-- (83_reschedule_past_dated_queue_posts.sql) contains the same defect in SQL
-- form — it built its slot as
--   (v_day::text || ' ' || post_time || '+00')::timestamptz
-- i.e. it stamped a UK-local post_time with a literal +00 offset. Every row it
-- rescheduled is therefore stale in precisely the same way.
--
-- HOW AN AFFECTED ROW WAS IDENTIFIED (no guessing — see the report)
-- For each future-dated row, the intended UK-local time is resolved with the
-- SAME precedence the code itself uses (fill.ts slotDateTime / fillClientGap,
-- schedule-to-metricool nextSlot):
--     the platform's own active mkt_content_schedule.time_uk for the row's UK
--     weekday, else mkt_clients.post_time, else '09:00'.
-- That intended time yields two candidate instants for the row's UK date:
--     correct_utc = intended AT TIME ZONE 'Europe/London'   (what ukTimeSlotToUtc produces)
--     buggy_utc   = intended AT TIME ZONE 'UTC'             (what setHours/'+00' produced)
-- Across all 144 future-dated mkt_content_queue rows this partitions perfectly:
--     117 rows == buggy_utc, and EVERY ONE was created before the fix landed;
--      27 rows == correct_utc, and EVERY ONE was created after it;
--       0 rows matched neither.
-- Two independent signals (stored value, and created_at vs the commit) agree on
-- all 144 rows, so staleness here is demonstrated rather than assumed. Every
-- one of the 117 corrections is exactly -1 hour, and none becomes past-dated.
--
-- WHY SOME ODD-LOOKING ROWS ARE **NOT** TOUCHED
-- Quill — LinkedIn has post_time NULL and a LinkedIn schedule of 08:00 on
-- Tue/Thu/Sat. Its 11 pre-fix rows sit on Tue/Thu/Sat at 09:00 UK — the 08:00
-- schedule path, shifted; those ARE stale. Its 3 rows created 2026-08-19 15:29
-- sit on Mon/Wed/Fri (days the schedule does not cover) at 09:00 UK — the
-- `?? '09:00'` fallback, correctly converted by the fixed code. Both groups
-- store the identical instant (08:00 UTC) yet only the first is stale. They are
-- separated by UK weekday and created_at, both of which agree. The second group
-- is deliberately left alone. The same reasoning keeps Hormonely's 19:00 and
-- Once Upon A You's 20:00 post_time rows (created post-fix) untouched.
--
-- SCOPE — future-dated rows only.
-- Past-dated rows are NOT touched. 196 of them match the buggy pattern, but
-- they record what was actually scheduled and (mostly) already published;
-- rewriting them would falsify history without changing anything that happens.
--
-- mkt_scheduled_posts is a pure mirror of mkt_content_queue written at dispatch
-- time (all 131 future rows currently agree with their parent, 0 orphans), so
-- it is realigned to its parent rather than re-derived independently. 9 of its
-- rows were created after the fix but inherited a stale pre-fix parent time —
-- corrected here for the same reason.
--
-- mkt_content_schedule.time_uk and mkt_clients.post_time are UK-local
-- wall-clock strings by definition, not UTC instants. They are the source of
-- truth this migration reads and are correctly NOT modified.
--
-- REVERSIBILITY / AUDIT
-- Every before-value is preserved permanently in
-- mkt_schedule_bst_correction_20260821 before anything is written, so the exact
-- prior state is recoverable row by row. Re-running is a no-op: once a row
-- equals correct_utc it can no longer equal buggy_utc.
--
-- KNOWN LIMITATION, STATED PLAINLY
-- 109 of the 117 corrected queue rows already carry a metricool_post_id — they
-- were pushed to Metricool at the wrong time. This migration makes OUR database
-- correct; it does NOT move those posts inside Metricool. They still fire an
-- hour late until they are re-pushed through schedule-to-metricool (which does
-- support updating an existing post via
-- /v2/scheduler/posts/{id}). That re-push is deliberately NOT done here — it is
-- 109 live third-party writes and needs a human decision, not a migration.
-- =============================================================================

create table if not exists public.mkt_schedule_bst_correction_20260821 (
  id                   uuid primary key default gen_random_uuid(),
  source_table         text        not null,
  row_id               uuid        not null,
  client_id            uuid,
  brand                text,
  platform             text,
  row_created_at       timestamptz,
  intended_uk_time     text,
  before_scheduled_for timestamptz not null,
  after_scheduled_for  timestamptz not null,
  corrected_at         timestamptz not null default now()
);

comment on table public.mkt_schedule_bst_correction_20260821 is
  'Before/after snapshot for the one-off BST scheduling correction of 2026-08-21 (pre-5a2faac rows stored a UK-local time as if it were UTC). Retain: this is the only record of the prior values.';

-- Resolve, for every future-dated queue row, the intended UK-local time and the
-- two candidate instants. Precedence mirrors fill.ts slotDateTime exactly.
create temporary table _bst_queue_fix as
with r as (
  select q.id, q.client_id, c.name as brand, q.platform, q.created_at, q.scheduled_for,
         (q.scheduled_for at time zone 'Europe/London')::date          as uk_date,
         extract(dow from (q.scheduled_for at time zone 'Europe/London'))::int as uk_dow,
         c.post_time
  from public.mkt_content_queue q
  join public.mkt_clients c on c.id = q.client_id
  where q.scheduled_for >= now()
), m as (
  select r.*,
         coalesce(
           (select s.time_uk from public.mkt_content_schedule s
             where s.client_id = r.client_id and s.platform = r.platform
               and s.active and s.day_of_week = r.uk_dow
             limit 1),
           to_char(r.post_time, 'HH24:MI'),
           '09:00') as intended_hm
  from r
)
select m.id, m.client_id, m.brand, m.platform, m.created_at, m.scheduled_for, m.intended_hm,
       ((m.uk_date::text || ' ' || m.intended_hm)::timestamp at time zone 'Europe/London') as correct_utc,
       ((m.uk_date::text || ' ' || m.intended_hm)::timestamp at time zone 'UTC')           as buggy_utc
from m;

-- Hard guard: refuse to run if the population is not the one that was audited.
-- A row matching NEITHER candidate means the intent model no longer holds (a
-- brand's configured time changed, say) and this migration must not guess.
do $$
declare v_unexplained int; v_bad_shift int; v_past int;
begin
  select count(*) into v_unexplained from _bst_queue_fix
    where scheduled_for <> correct_utc and scheduled_for <> buggy_utc;
  if v_unexplained > 0 then
    raise exception 'Aborting: % future queue row(s) match neither the correct nor the buggy instant — intent cannot be established, refusing to guess.', v_unexplained;
  end if;

  select count(*) into v_bad_shift from _bst_queue_fix
    where scheduled_for = buggy_utc and scheduled_for - correct_utc <> interval '1 hour';
  if v_bad_shift > 0 then
    raise exception 'Aborting: % stale row(s) would move by something other than exactly -1 hour.', v_bad_shift;
  end if;

  select count(*) into v_past from _bst_queue_fix
    where scheduled_for = buggy_utc and correct_utc <= now();
  if v_past > 0 then
    raise exception 'Aborting: % row(s) would become past-dated after correction.', v_past;
  end if;
end $$;

-- Preserve the complete before-state FIRST.
insert into public.mkt_schedule_bst_correction_20260821
  (source_table, row_id, client_id, brand, platform, row_created_at,
   intended_uk_time, before_scheduled_for, after_scheduled_for)
select 'mkt_content_queue', f.id, f.client_id, f.brand, f.platform, f.created_at,
       f.intended_hm, f.scheduled_for, f.correct_utc
from _bst_queue_fix f
where f.scheduled_for = f.buggy_utc;

insert into public.mkt_schedule_bst_correction_20260821
  (source_table, row_id, client_id, brand, platform, row_created_at,
   intended_uk_time, before_scheduled_for, after_scheduled_for)
select 'mkt_scheduled_posts', p.id, p.client_id, f.brand, p.platform, p.created_at,
       f.intended_hm, p.scheduled_for, f.correct_utc
from public.mkt_scheduled_posts p
join _bst_queue_fix f on f.id = p.content_queue_id
where f.scheduled_for = f.buggy_utc
  and p.scheduled_for = f.scheduled_for;

-- Correct the queue.
update public.mkt_content_queue q
   set scheduled_for = f.correct_utc
  from _bst_queue_fix f
 where q.id = f.id
   and f.scheduled_for = f.buggy_utc
   and q.scheduled_for = f.scheduled_for;

-- Realign the dispatch mirror to its parent.
update public.mkt_scheduled_posts p
   set scheduled_for = f.correct_utc
  from _bst_queue_fix f
 where p.content_queue_id = f.id
   and f.scheduled_for = f.buggy_utc
   and p.scheduled_for = f.scheduled_for;

do $$
declare v_left int;
begin
  select count(*) into v_left
  from public.mkt_content_queue q
  join _bst_queue_fix f on f.id = q.id
  where f.scheduled_for = f.buggy_utc and q.scheduled_for <> f.correct_utc;
  if v_left > 0 then
    raise exception 'Aborting: % row(s) did not take the correction.', v_left;
  end if;
  raise notice 'BST correction applied. Audit rows: %',
    (select count(*) from public.mkt_schedule_bst_correction_20260821);
end $$;

drop table _bst_queue_fix;
