-- =============================================================================
-- 20260830080000_quill_facebook_weekend_schedule.sql
--
-- Quill (slug 'quill') Facebook: add the missing Saturday + Sunday rows to
-- mkt_content_schedule, so the platform schedule finally agrees with the
-- brand's own mkt_clients.post_days (which has said all seven days all
-- along).
--
-- Why this was a real, silent problem. platformSchedule() takes precedence
-- over client.post_days whenever a client+platform has ANY active rows, and
-- Quill/facebook had exactly five — Mon..Fri (day_of_week 1..5). So the
-- nightly fill (fill.ts) resolved postingDays to Mon-Fri and never walked a
-- Saturday or Sunday, while other paths that read post_days happily created
-- weekend posts. Two consequences, both confirmed against live data:
--
--   1. Weekend slots could never be refilled once vacated. The 30 Aug (Sun)
--      and 5 Sep (Sat) posts rejected on 29 Aug to force image regeneration
--      were never regenerated for exactly this reason — not an image
--      failure, the day simply was not in the walk.
--   2. Weekend coverage was decaying silently. The Sat/Sun rows that do
--      exist (29 Aug Sat, 6 Sep Sun, both live and scheduled) came from a
--      one-off bulk insert on 19 Aug 15:30:53 that used post_days. Nothing
--      was replacing them as they published.
--
-- 08:00 matches every existing Quill/facebook row exactly, so weekends keep
-- the same slot time as weekdays rather than introducing a new one.
--
-- Deliberately scoped to facebook only. Quill's connected_platforms is
-- ['facebook'], so its instagram rows are already inert (clientPlatforms
-- filters to connected platforms) — adding weekend rows there would be dead
-- config, not a fix.
--
-- Note this raises the 28-day target for Quill/facebook from 20 posts
-- (5 days x 4 weeks) to 28 (7 x 4), via targetPostsForDays. The nightly
-- fill will close that gap over the coming runs at its normal per-client
-- budget; it is not a one-off backfill.
-- =============================================================================

insert into public.mkt_content_schedule (client_id, platform, day_of_week, time_uk, active)
select c.id, 'facebook', d.day_of_week, '08:00', true
from public.mkt_clients c
cross join (values (0), (6)) as d(day_of_week)   -- 0 = Sunday, 6 = Saturday
where c.slug = 'quill'
  and not exists (
    select 1 from public.mkt_content_schedule s
    where s.client_id = c.id
      and s.platform = 'facebook'
      and s.day_of_week = d.day_of_week
  );
