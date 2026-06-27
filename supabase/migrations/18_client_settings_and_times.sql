-- =============================================================================
-- 18_client_settings_and_times.sql
-- Populates tone_of_voice, key_services, target_customer, and post_time
-- for all 6 clients. Idempotent.
-- Run in Supabase SQL Editor (project fvyvtdwsomxfkpxwygpk).
-- =============================================================================

-- ── Quill ────────────────────────────────────────────────────────────────────
UPDATE public.mkt_clients SET
  tone_of_voice   = 'Confident, direct, irreverent, personality-led. First person always. Social experiment framing.',
  key_services    = 'AI social media marketing service for small businesses',
  target_customer = 'UK small business owners who want social media run by AI without hiring an agency',
  post_time       = '08:00'
WHERE slug = 'quill';

-- ── Your Company AI ──────────────────────────────────────────────────────────
UPDATE public.mkt_clients SET
  tone_of_voice   = 'Collaborative, exciting, forward-looking. Human copywriter style. Speaks to optimistic business owners.',
  key_services    = 'AI-powered business management — invoicing, HR, job costing, fleet, compliance, quoting',
  target_customer = 'UK trade and service business owners aged 30–55 (plumbers, electricians, builders, cleaning firms)',
  post_time       = '08:00'
WHERE slug = 'yca';

-- ── Problem.Solution ─────────────────────────────────────────────────────────
UPDATE public.mkt_clients SET
  tone_of_voice   = 'Confident, clinical, diagnostic, reassuring. Persona: Sarah Mitchell. Pain front and centre.',
  key_services    = 'Direct business diagnostics and solutions — we find the problem, we fix the problem',
  target_customer = 'UK small business owners who have a specific pain point and want it resolved fast',
  post_time       = '09:00'
WHERE slug = 'ps';

-- ── Hormonely ────────────────────────────────────────────────────────────────
UPDATE public.mkt_clients SET
  tone_of_voice   = 'Plain English, calm, evidence-led. EFSA-compliant. No jargon, no scare tactics.',
  key_services    = 'Hormone health information and EFSA-compliant supplement guidance for men and women 40+',
  target_customer = 'Men and women aged 40–65 in the UK experiencing hormone-related health changes',
  post_time       = '19:00'
WHERE slug = 'hormonely';

-- ── Riverside Sheetmetal ─────────────────────────────────────────────────────
UPDATE public.mkt_clients SET
  tone_of_voice   = 'Professional, skilled, proud of the craft. Showcases work, expertise, and reliability.',
  key_services    = 'Bespoke sheet metal fabrication — precision cutting, welding, powder coating, bespoke finishing',
  target_customer = 'UK construction firms, architects, and manufacturers requiring bespoke precision metalwork',
  post_time       = '07:30'
WHERE slug = 'riverside';

-- ── Once Upon A You ──────────────────────────────────────────────────────────
UPDATE public.mkt_clients SET
  tone_of_voice   = 'Warm, magical, parent-focused. Emotional and celebratory. Every child is the hero.',
  key_services    = 'Personalised AI children''s books — AI-written stories with photo-matched illustrations',
  target_customer = 'UK parents aged 25–45 buying a unique, personalised gift for children aged 3–10',
  post_time       = '20:00'
WHERE slug = 'ouay';
