-- =============================================================================
-- 26_add_steady_client.sql — Add Steady as client 8
-- Idempotent: guarded with WHERE NOT EXISTS.
-- Run in Supabase SQL Editor (project fvyvtdwsomxfkpxwygpk), after 25.
--
-- NOTE — metricool_brand_id is left NULL below. Look up the real ID by
-- logging into Metricool, opening Steady's brand, and reading the numeric
-- ID out of the URL (matches the pattern used for the other 5 brands in
-- 16_metricool_schema.sql — e.g. UPDATE public.mkt_clients SET
-- metricool_brand_id = '...' WHERE slug = 'steady';). Until that's set,
-- schedule-to-metricool will fail for Steady's posts with a clear "no
-- metricool_brand_id" error rather than silently posting to the wrong brand.
-- =============================================================================

insert into public.mkt_clients
  (name, short_name, slug, industry, location, website, contact_email,
   tone_of_voice, key_services, target_customer, content_pillars,
   post_days, post_time, traffic_light, brand_primary_color,
   connected_platforms, active, master_prompt)
select
  'Steady', 'Steady', 'steady', 'Health & Wellbeing (GLP-1 aftercare)', 'United Kingdom',
  'https://steadyme.co.uk', 'hello@steadyme.co.uk',
  'Warm, honest, science-backed. Never preachy. Never medical advice.',
  'A companion app for the phase after stopping GLP-1 weight-loss medication (Mounjaro, Wegovy, Ozempic) — daily AI check-ins, food noise journal, habit and mindset coaching',
  'UK adults who have stopped or are planning to stop GLP-1 weight-loss medication',
  array['Science & stats', 'Real voices', 'Food noise education', 'The plan', 'Mindset & habit coaching'],
  array['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'], '09:00', 'green',
  '#4a7c6f',
  array['facebook'], true,
  $md$You are writing for Steady (steadyme.co.uk), a companion app for people who have stopped or are planning to stop GLP-1 weight-loss medication (Mounjaro, Wegovy, Ozempic). Voice is warm, honest, and science-backed — never preachy, never a scare tactic. Validate how hard this phase is without being dramatic about it. Cite real, peer-reviewed statistics (e.g. SURMOUNT-4, STEP 1 trial) when making claims — never invent a statistic or study. No emojis. No exclamation marks. Single space after every full stop.

Steady provides lifestyle and wellbeing guidance only. NEVER give medical advice, recommend medication, set calorie targets, or suggest a specific diet. Always end lifestyle-guidance content with: "Steady provides lifestyle guidance only. Always follow your prescriber's advice."

NEVER invent specific jobs, clients, projects, events, testimonials, or results. Only write about real capabilities, real services, real values, and general industry knowledge. No fictional case studies. No made-up completed work.$md$
where not exists (select 1 from public.mkt_clients where slug = 'steady');

-- Verify
select id, name, slug, metricool_brand_id, connected_platforms, post_days, post_time
from public.mkt_clients
where slug = 'steady';
