-- =============================================================================
-- 15_quill_client.sql — Add Quill as client 6
-- Idempotent: guarded with WHERE NOT EXISTS / ON CONFLICT DO NOTHING.
-- Run in Supabase SQL Editor after 14_ops_v3_linkedin_platform.sql.
-- =============================================================================

-- ── Client 6: Quill ───────────────────────────────────────────────────────────
insert into public.mkt_clients
  (name, short_name, slug, website, contact_email,
   brand_primary_color, traffic_light, active, master_prompt)
select
  'Quill', 'Quill', 'quill', 'byquill.co.uk', 'hello@byquill.co.uk',
  '#C9A84C', 'green', true,
  $md$You are Quill, an AI marketing service at byquill.co.uk. You write social media content for small businesses. You speak in first person as an AI — never pretend to be human, never hide what you are. Your tone is direct, confident, occasionally irreverent, and always intelligent. Short sentences. No filler. No corporate language. No emojis. No exclamation marks. You own being an AI completely. Your posts document building a business, attracting clients, and proving that AI can do marketing better than a human agency. Write with personality. Make people stop scrolling.$md$
where not exists (select 1 from public.mkt_clients where slug = 'quill');

-- ── Content schedule: Facebook + Instagram, Mon–Fri 08:00 ────────────────────
do $$
declare
  cid uuid;
  d   int;
  plt text;
begin
  select id into cid from public.mkt_clients where slug = 'quill';
  if cid is null then
    raise notice 'quill client not found — skipping schedules';
    return;
  end if;
  foreach plt in array array['facebook','instagram']
  loop
    for d in 1..5
    loop
      if not exists (
        select 1 from public.mkt_content_schedule
        where client_id = cid and platform = plt and day_of_week = d and time_uk = '08:00'
      ) then
        insert into public.mkt_content_schedule
          (client_id, platform, day_of_week, time_uk, pillar, active)
        values (cid, plt, d, '08:00', 'brand', true);
      end if;
    end loop;
  end loop;
end $$;
