-- =============================================================================
-- 21_client_strategy_update.sql
-- Updates tone_of_voice, key_services, target_customer, content_pillars,
-- and post_time for all six clients. Idempotent.
-- Run in Supabase SQL Editor (project fvyvtdwsomxfkpxwygpk).
-- =============================================================================

-- ── Quill ─────────────────────────────────────────────────────────────────────
UPDATE public.mkt_clients SET
  post_time       = '08:00',
  tone_of_voice   = $v$First person AI. Confident, direct, irreverent. Never apologetic about being AI. The social experiment framing runs through everything. Leans into being AI not away from it.$v$,
  key_services    = $v$Social media management for businesses that want to stop wasting time on it. Starter £149/mo, Growth £249/mo, Pro £399/mo. First 10 clients get 50% off for 12 months.$v$,
  target_customer = $v$Small UK businesses spending too much time on social media or not showing up at all. Trades, services, local businesses.$v$,
  content_pillars = ARRAY['The experiment','Behind the work','Client journeys','Industry takes','Results']
WHERE slug = 'quill';

-- ── Your Company AI ───────────────────────────────────────────────────────────
UPDATE public.mkt_clients SET
  post_time       = '08:00',
  tone_of_voice   = $v$First person founder. Adrian speaking directly. Honest, optimistic, building something real. No corporate language. No fake team. No invented staff.$v$,
  key_services    = $v$AI-powered business management platform for UK trades. 11 modules including invoicing, HR with payroll, job costing, fleet management, health and safety, asset tracking. Founding member pricing from £89.99/mo.$v$,
  target_customer = $v$UK trades and service businesses — plumbers, electricians, builders, HVAC, cleaning companies. Owners who are drowning in admin and want to grow.$v$,
  content_pillars = ARRAY['Building from zero','Module spotlights','Client stories','Industry reality','Founding member offer']
WHERE slug = 'yca';

-- ── Problem.Solution. ─────────────────────────────────────────────────────────
UPDATE public.mkt_clients SET
  post_time       = '09:00',
  tone_of_voice   = $v$Sarah Mitchell speaking. Clinical, direct, confident. Identifies the exact pain point in the first line. No fluff. Pain first, fix second.$v$,
  key_services    = $v$Business problem diagnosis and solution. Routes into YCA platform for trades businesses needing operational fixes.$v$,
  target_customer = $v$UK trade and service business owners frustrated with admin, cashflow, HR headaches, and wasted time.$v$,
  content_pillars = ARRAY['The problem','The fix','Proof','The offer']
WHERE slug = 'ps';

-- ── Hormonely ─────────────────────────────────────────────────────────────────
UPDATE public.mkt_clients SET
  post_time       = '19:00',
  tone_of_voice   = $v$Warm but authoritative. Speaks to men and women in their 40s, 50s and beyond. Never alarmist. No jargon. No scare tactics. All claims must be EFSA-compliant. Every health post must end with: Always speak to your GP before making changes to your health routine.$v$,
  key_services    = $v$Hormone health information guides, symptom library, AI symptom checker, supplement stacks for men and women by decade. hormonely.co.uk$v$,
  target_customer = $v$Men and women aged 40 to 65 experiencing hormonal changes and looking for plain English guidance and evidence-based supplement support.$v$,
  content_pillars = ARRAY['Decade guides','Symptom education','Supplement stacks','Myth busting']
WHERE slug = 'hormonely';

-- ── Once Upon A You ───────────────────────────────────────────────────────────
UPDATE public.mkt_clients SET
  post_time       = '20:00',
  tone_of_voice   = $v$Warm, wonder-filled, parent-to-parent. Not saccharine. Real. Knows parents are busy and emotional about their kids. The child is always the hero.$v$,
  key_services    = $v$Personalised AI children's books where the child is the actual hero — photo-matched illustrations not just name insertion. Ebook from £2.99, softcover from £14.99, hardcover bundle £24.99. onceuponayou.co.uk$v$,
  target_customer = $v$UK parents and grandparents aged 25 to 55 looking for a unique personalised gift for a child aged 2 to 10.$v$,
  content_pillars = ARRAY['The product difference','The gifting moment','Behind the magic','Parent reactions','The story']
WHERE slug = 'ouay';

-- ── Riverside Sheetmetal ──────────────────────────────────────────────────────
UPDATE public.mkt_clients SET
  post_time       = '07:30',
  tone_of_voice   = $v$Professional, skilled, proud of the craft. Speaks like a craftsperson not a marketer. No invented jobs, clients, projects or events. Only real capabilities and real expertise.$v$,
  key_services    = $v$Bespoke sheet metal fabrication in Littlehampton, West Sussex. Precision cutting, TIG welding, powder coating, bespoke finishing. riversidesm.co.uk$v$,
  target_customer = $v$UK construction firms, architects, engineers and manufacturers requiring bespoke precision metalwork.$v$,
  content_pillars = ARRAY['The craft','Expertise','Industry knowledge','Meet the team']
WHERE slug = 'riverside';

-- ── Verification — run after to confirm all six rows updated ─────────────────
-- SELECT slug, post_time, tone_of_voice, key_services, target_customer, content_pillars
-- FROM public.mkt_clients
-- WHERE slug IN ('quill','yca','ps','hormonely','ouay','riverside')
-- ORDER BY slug;
