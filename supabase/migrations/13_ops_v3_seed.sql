-- =============================================================================
-- 13_ops_v3_seed.sql — Marketing Ops v3 seed (June 2026)
-- Idempotent. Run after 12_ops_v3_schema.sql.
--
--  * Adds hello@ admin (keeps existing adrian@).
--  * Backfills slug + brand colour + master_prompt for the 2 existing clients.
--  * Inserts the 2 missing clients (OUAY, Hormonely) with master prompts.
--  * Seeds content schedules for all 4 brands.
--  * Seeds the two recurring tasks.
-- =============================================================================

-- ── Admin login email (brief: hello@) — additive, keeps existing admin ───────
insert into public.mkt_admins (email) values ('hello@yourcompanyai.co.uk')
on conflict (email) do nothing;

-- ── Client 1: Your Company AI — backfill slug, brand colour, master prompt ───
update public.mkt_clients set
  slug = 'yca',
  brand_primary_color = '#E8410A',
  master_prompt = $md$You are a copywriter for Your Company AI (yourcompanyai.co.uk), an AI-powered business management platform for small UK trades and service businesses. Write Facebook posts that are punchy, direct, and human. Short sentences. Varied rhythm. No filler. No emojis ever. No exclamation marks. Write in prose not bullet points. Tone: collaborative, confident, forward-looking. Target audience: plumbers, electricians, builders, cleaning companies, UK trade business owners aged 30-55. One space after every full stop. Key messages: all modules in one place, minimum clicks, mobile-first, 30 days free, founding member pricing closing soon. Never mention Staff Rota in posts targeting plumbers or electricians.$md$
where name = 'Your Company AI';

-- ── Client 2: Problem. Solution. — backfill slug, brand colour, master prompt ─
update public.mkt_clients set
  slug = 'ps',
  brand_primary_color = '#C41E3A',
  master_prompt = $md$You are a copywriter for Problem. Solution. (problemsolution.co.uk), a direct business solutions brand. Write Facebook posts that are pain-first, clinical, and direct. Short sentences. Varied rhythm. No filler. No emojis ever. No exclamation marks. Write in prose. Tone: confident, diagnostic, authoritative. Tagline: We find it. We fix it. Target: UK small business owners who want pain gone. Lead with the problem. End with the solution. One space after every full stop.$md$
where name = 'Problem. Solution.';

-- ── Client 3: Once Upon A You (new) ──────────────────────────────────────────
insert into public.mkt_clients
  (name, short_name, slug, industry, location, website, contact_email,
   tone_of_voice, key_services, target_customer, content_pillars,
   post_days, post_time, traffic_light, brand_primary_color, brand_secondary_color,
   active, master_prompt)
select
  'Once Upon A You', 'OUAY', 'ouay', 'Personalised Publishing', 'United Kingdom',
  'https://onceuponayou.co.uk', 'hello@onceuponayou.co.uk',
  'Warm, magical, parent-focused. Emotional and celebratory.',
  'Personalised AI children''s books — the child is the hero of their own story',
  'UK parents aged 25-45 buying gifts for children aged 3-10',
  array['The hero is your child','Why personalised','Gift moments','Behind the story'],
  array['Monday','Wednesday','Friday'], '10:00', 'green',
  '#085041', '#1C2B3A', true,
  $md$You are a copywriter for Once Upon A You (onceuponayou.co.uk), a personalised AI children's book business. Write Facebook posts that are warm, magical, parent-focused. Short sentences. Emotional. No emojis. Tone: warm, imaginative, celebratory. Target: UK parents aged 25-45 buying gifts for children aged 3-10. Key message: the child is the actual hero — their face in every illustration, their name on the cover, a story written just for them. Softcover from £14.99, ebooks from £6.99. One space after every full stop.$md$
where not exists (select 1 from public.mkt_clients where slug = 'ouay' or name = 'Once Upon A You');

-- ── Client 4: Hormonely (new) ────────────────────────────────────────────────
insert into public.mkt_clients
  (name, short_name, slug, industry, location, website, contact_email,
   tone_of_voice, key_services, target_customer, content_pillars,
   post_days, post_time, traffic_light, brand_primary_color, brand_secondary_color,
   active, master_prompt)
select
  'Hormonely', 'Hormonely', 'hormonely', 'Health Information', 'United Kingdom',
  'https://hormonely.co.uk', 'hello@hormonely.co.uk',
  'Plain English, calm, evidence-led. No scare tactics. No overclaiming.',
  'Hormone health information and EFSA-compliant supplement guidance',
  'Men and women aged 40-65 in the UK',
  array['Hormone health explained','Men over 40','Women over 40','Myth busting'],
  array['Monday','Tuesday','Wednesday','Thursday','Friday'], '10:00', 'green',
  '#8B5E3C', '#1C2B3A', true,
  $md$You are a copywriter for Hormonely (hormonely.co.uk), a hormone health information site for men and women in their 40s, 50s and beyond. Plain English always. No emojis ever. No exclamation marks. No bullet points — write in flowing paragraphs. No scare tactics. Never overclaim. Supplements support, they do not cure. All supplement claims must use EFSA-approved language only. Always end health posts with: This is information only, not medical advice. Always speak to your GP. Never put links in post body — always in first comment. Target: men and women aged 40-65 in the UK. One space after every full stop.$md$
where not exists (select 1 from public.mkt_clients where slug = 'hormonely' or name = 'Hormonely');

-- ── Content schedules (Facebook) ─────────────────────────────────────────────
-- Helper: insert one schedule row guarded against duplicates.
do $$
declare
  r record;
  spec jsonb := $j$[
    {"slug":"yca",       "days":[1,3,5],         "time":"06:00"},
    {"slug":"ps",        "days":[2,4,6],         "time":"09:00"},
    {"slug":"ouay",      "days":[1,3,5],         "time":"10:00"},
    {"slug":"hormonely", "days":[1,2,3,4,5],     "time":"10:00"}
  ]$j$;
  s jsonb;
  d int;
  cid uuid;
begin
  for s in select * from jsonb_array_elements(spec)
  loop
    select id into cid from public.mkt_clients where slug = (s->>'slug');
    if cid is null then continue; end if;
    for d in select value::int from jsonb_array_elements_text(s->'days')
    loop
      if not exists (
        select 1 from public.mkt_content_schedule
        where client_id = cid and platform = 'facebook' and day_of_week = d and time_uk = (s->>'time')
      ) then
        insert into public.mkt_content_schedule (client_id, platform, day_of_week, time_uk, pillar, active)
        values (cid, 'facebook', d, (s->>'time'), null, true);
      end if;
    end loop;
  end loop;
end $$;

-- ── Recurring task: Hormonely first comment (Mon–Fri 10:05) ──────────────────
insert into public.mkt_tasks
  (client_id, task, title, notes, task_type, priority, overdue, due_date, due_time, recurring, recurrence_rule, completed)
select c.id,
  'Add first comment to Hormonely post',
  'Add first comment to Hormonely post',
  'Add link in first comment: hormonely.co.uk — guide relevant to today post topic',
  'first_comment', 1, false, current_date, '10:05', true, 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR', false
from public.mkt_clients c
where c.slug = 'hormonely'
and not exists (
  select 1 from public.mkt_tasks t
  where t.client_id = c.id and t.task_type = 'first_comment' and t.recurring = true
);

-- ── Recurring task: YCA LinkedIn post (Tue & Thu) ────────────────────────────
insert into public.mkt_tasks
  (client_id, task, title, notes, task_type, priority, overdue, due_date, due_time, recurring, recurrence_rule, completed)
select c.id,
  'Write and post LinkedIn post',
  'Write and post LinkedIn post',
  'YCA LinkedIn post — Tuesday and Thursday.',
  'linkedin_post', 2, false, current_date, null, true, 'FREQ=WEEKLY;BYDAY=TU,TH', false
from public.mkt_clients c
where c.slug = 'yca'
and not exists (
  select 1 from public.mkt_tasks t
  where t.client_id = c.id and t.task_type = 'linkedin_post' and t.recurring = true
);
