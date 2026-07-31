-- =============================================================================
-- 71_adrian_linkedin_client.sql
--
-- Adds Adrian Fielding's personal LinkedIn as a brand in mkt_clients so it
-- flows through the existing midnight-cron / approval-queue / Metricool
-- pipeline exactly like every other brand — one post/week, Thursdays only.
--
-- Column mapping (mkt_clients has no columns literally named
-- metricool_blog_id / platform / posting_schedule / status):
--   metricool_blog_id 6648946  -> metricool_brand_id (the column
--                                 schedule-to-metricool actually sends as
--                                 Metricool's blogId query param)
--   platform 'linkedin'        -> connected_platforms (array; hard-gates
--                                 generation via isPlatformConnected)
--   posting_schedule 'thursday'-> one row in mkt_content_schedule
--                                 (day_of_week=4, matches DAY_NAME_TO_NUM in
--                                 _shared/fill.ts) rather than post_days,
--                                 so this brand's cadence doesn't depend on
--                                 the client-wide fallback path
--   status 'active'            -> active boolean
--
-- master_prompt is the exact prompt text given in the brief, used verbatim
-- as buildSystemPrompt()'s brand-specific base (sandwiched between the
-- shared UNIVERSAL_CONTENT_RULES/FACTUAL_ACCURACY_CONSTRAINT/FORMAT_RULES
-- every brand already gets — see _shared/prompts.ts). content_pillars has a
-- single entry: with only one pillar, pickDiversePillar always returns it,
-- which is correct here — there is no real second "content pillar" to
-- rotate for a single personal weekly reflection post.
--
-- auto_approve is deliberately left at its default (false) — this is
-- personal, high-stakes founder voice content and must always go through
-- Adrian's own review in the approval queue before scheduling to Metricool,
-- same as every brand that doesn't have auto_approve explicitly set.
-- =============================================================================

insert into public.mkt_clients (
  name, slug, metricool_brand_id, connected_platforms, content_pillars, active, master_prompt
) values (
  'Adrian Fielding — LinkedIn',
  'adrian-linkedin',
  '6648946',
  array['linkedin'],
  array['Building in public'],
  true,
  'You are writing a personal LinkedIn post for Adrian Fielding, founder of Redmaine. Adrian runs Quill (AI social media agency), Your Company AI (business management platform for UK trades), and several consumer brands including Hormonely, Once Upon A You, Neuro Decoded, and Steady. He is building in public — documenting what works, what does not, and what he is learning. The post must be written in Adrian''s personal voice — direct, honest, specific, founder-led. It must reference something real that has happened in the business in the last week. It must not read as marketing copy. It must not sound like it was written by an AI. It should make someone who runs a small business stop and think. Maximum 300 words. No emojis. No exclamation marks. Single space after every full stop. End with a relevant URL — either byquill.co.uk or yourcompanyai.co.uk depending on the content.'
)
-- mkt_clients_slug_key (migration 12) is a PARTIAL unique index (where slug
-- is not null) — the inference clause below must match that exact predicate
-- or Postgres can't match it to this ON CONFLICT.
on conflict (slug) where slug is not null do nothing;

-- No unique constraint exists on mkt_content_schedule, so re-running this
-- migration would otherwise insert a duplicate row every time — guard with
-- NOT EXISTS instead of ON CONFLICT (which has no constraint to key off).
insert into public.mkt_content_schedule (client_id, platform, day_of_week, time_uk, pillar, active)
select c.id, 'linkedin', 4, '08:00', 'Building in public', true
from public.mkt_clients c
where c.slug = 'adrian-linkedin'
  and not exists (
    select 1 from public.mkt_content_schedule s
    where s.client_id = c.id and s.platform = 'linkedin' and s.day_of_week = 4
  );
