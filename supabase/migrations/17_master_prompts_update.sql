-- =============================================================================
-- 17_master_prompts_update.sql — Update master prompts to latest brand voices
-- + add Riverside Sheetmetal client if not already present.
-- Idempotent. Run in Supabase SQL Editor (project fvyvtdwsomxfkpxwygpk).
-- =============================================================================

-- ── 1. Quill ─────────────────────────────────────────────────────────────────
UPDATE public.mkt_clients SET master_prompt = $md$You are Quill, an AI that runs a social media marketing agency. Your voice is confident, direct, irreverent, and personality-led. You speak in first person always. You are the brand — Adrian is your assistant. Every post uses the social experiment framing. No emojis. No exclamation marks. Single space after every full stop. Short punchy sentences. Varied rhythm. Never sounds like AI wrote it.$md$
WHERE slug = 'quill';

-- ── 2. Your Company AI ────────────────────────────────────────────────────────
UPDATE public.mkt_clients SET master_prompt = $md$You are writing for Your Company AI, an AI-powered business management platform for UK trades and service businesses. Voice is collaborative, exciting, forward-looking. Speaks to optimistic business owners who want to grow. No emojis. No exclamation marks. Single space after every full stop. Punchy. Direct. Human copywriter style.$md$
WHERE slug = 'yca';

-- ── 3. Problem.Solution ───────────────────────────────────────────────────────
UPDATE public.mkt_clients SET master_prompt = $md$You are writing for Problem.Solution, a direct diagnostic brand. Persona is Sarah Mitchell. Voice is confident, clinical, reassuring. Speaks to frustrated business owners who want their pain gone. Pain front and centre. No emojis. No exclamation marks. Single space after every full stop.$md$
WHERE slug = 'ps';

-- ── 4. Hormonely ─────────────────────────────────────────────────────────────
UPDATE public.mkt_clients SET master_prompt = $md$You are writing for Hormonely, a hormone health information platform for men and women in their 40s, 50s and beyond. Plain English. No jargon. No scare tactics. All claims EFSA-compliant. Always end health posts with: "Always speak to your GP before making changes to your health routine." No emojis. No exclamation marks.$md$
WHERE slug = 'hormonely';

-- ── 5. Once Upon A You ────────────────────────────────────────────────────────
UPDATE public.mkt_clients SET master_prompt = $md$You are writing for Once Upon A You, a personalised AI children's book brand. Every child is the hero — not name insertion like competitors, but AI-written stories with photo-matched illustrations. Warm, magical, parent-focused. No emojis. No exclamation marks.$md$
WHERE slug = 'ouay';

-- ── 6. Riverside Sheetmetal — insert if missing, then update ─────────────────
INSERT INTO public.mkt_clients
  (name, short_name, slug, industry, location, website, contact_email,
   tone_of_voice, key_services, target_customer, content_pillars,
   post_days, post_time, traffic_light, brand_primary_color, brand_secondary_color,
   active, metricool_brand_id, master_prompt)
SELECT
  'Riverside Sheetmetal Fabrications', 'Riverside', 'riverside',
  'Sheet Metal Fabrication', 'Littlehampton, West Sussex',
  'https://www.riversidesm.co.uk', 'info@riversidesm.co.uk',
  'Professional, skilled, proud of the craft.',
  'Bespoke sheet metal fabrication, precision cutting, welding, finishing',
  'UK construction firms, architects, manufacturers requiring bespoke metalwork',
  ARRAY['Work showcase','Expertise & craft','Project spotlight','Industry knowledge'],
  ARRAY['Monday','Wednesday','Friday'], '09:00', 'green',
  '#1C2B3A', '#8FA3B1',
  true, '6470004',
  $md$You are writing for Riverside Sheetmetal Fabrications, a sheet metal fabrication business in Littlehampton. Voice is professional, skilled, proud of the craft. Posts showcase work, expertise, and reliability. No emojis. No exclamation marks.$md$
WHERE NOT EXISTS (SELECT 1 FROM public.mkt_clients WHERE slug = 'riverside');

-- Always update the master_prompt (covers the case where Riverside already exists
-- but has an old or missing prompt).
UPDATE public.mkt_clients SET
  master_prompt = $md$You are writing for Riverside Sheetmetal Fabrications, a sheet metal fabrication business in Littlehampton. Voice is professional, skilled, proud of the craft. Posts showcase work, expertise, and reliability. No emojis. No exclamation marks.$md$,
  metricool_brand_id = COALESCE(metricool_brand_id, '6470004')
WHERE slug = 'riverside';

-- ── 7. Riverside content schedule (Mon/Wed/Fri 09:00 Facebook) ───────────────
DO $$
DECLARE
  cid UUID;
  d   INT;
BEGIN
  SELECT id INTO cid FROM public.mkt_clients WHERE slug = 'riverside';
  IF cid IS NULL THEN RETURN; END IF;
  FOREACH d IN ARRAY ARRAY[1, 3, 5]
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM public.mkt_content_schedule
      WHERE client_id = cid AND platform = 'facebook' AND day_of_week = d AND time_uk = '09:00'
    ) THEN
      INSERT INTO public.mkt_content_schedule (client_id, platform, day_of_week, time_uk, pillar, active)
      VALUES (cid, 'facebook', d, '09:00', null, true);
    END IF;
  END LOOP;
END $$;
