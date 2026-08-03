-- =============================================================================
-- 78_quill_linkedin_placeholder.sql
--
-- Quill LinkedIn company page — placeholder client + schedule, inserted
-- INACTIVE per the task's own explicit instruction: the real Metricool
-- blogId is not yet known (Adrian connects the page in Metricool and
-- supplies it later). metricool_brand_id is left NULL rather than a fake
-- value — update it and set active=true once the real ID is confirmed.
--
-- No pipeline code change is needed for that later step: midnight-cron /
-- fillClientGap / schedule-to-metricool / metricool-weekly-pull all read
-- mkt_clients dynamically with no LinkedIn-specific branching (confirmed by
-- Adrian Fielding — LinkedIn, slug 'adrian-linkedin', migration 71 — same
-- pattern followed here), so flipping this row to active is the whole job.
--
-- Cadence: Tuesday/Thursday/Saturday 08:00 (day_of_week 2/4/6), one row per
-- day matching migration 71's per-day-row convention rather than packing
-- multiple days into one row (mkt_content_schedule has no such column).
-- =============================================================================

insert into public.mkt_clients (
  name, slug, metricool_brand_id, connected_platforms, content_pillars, active, master_prompt
) values (
  'Quill — LinkedIn',
  'quill-linkedin',
  null,
  array['linkedin'],
  array['Social media management, AI, and client work'],
  false,
  'You are writing a LinkedIn company page post for Quill, an AI-powered social media agency. Voice: confident, direct, first person as Quill. The post must be about social media management, AI, or what Quill does for clients. Reference real client work where possible — Riverside Sheet Metal, Combat Ready HQ. No emojis. No exclamation marks. Single space after every full stop. Maximum 200 words. End with byquill.co.uk.'
)
-- mkt_clients_slug_key (migration 12) is a PARTIAL unique index (where slug
-- is not null) — the inference clause below must match that exact predicate.
on conflict (slug) where slug is not null do nothing;

-- No unique constraint exists on mkt_content_schedule (see migration 71's own
-- note) — guard with NOT EXISTS instead of ON CONFLICT.
insert into public.mkt_content_schedule (client_id, platform, day_of_week, time_uk, pillar, active)
select c.id, 'linkedin', d.day, '08:00', 'Social media management, AI, and client work', true
from public.mkt_clients c
cross join unnest(array[2, 4, 6]) as d(day)  -- Tuesday, Thursday, Saturday
where c.slug = 'quill-linkedin'
  and not exists (
    select 1 from public.mkt_content_schedule s
    where s.client_id = c.id and s.platform = 'linkedin' and s.day_of_week = d.day
  );
