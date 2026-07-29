-- =============================================================================
-- 64_brand_master_prompt_appends.sql
--
-- Parts 4 and 5: append brand-specific guidance to seven brands' existing
-- mkt_clients.master_prompt. APPEND ONLY — every statement concatenates onto
-- the current value and none replaces it.
--
-- Idempotent by construction: each update is guarded by a NOT LIKE check on a
-- distinctive marker line from its own block, so re-running this file cannot
-- append the same text twice. Re-running after an edit to one brand's block
-- will append the new text, which is the intended behaviour.
--
-- Brands are matched on slug, which is the stable key (name is display text
-- and has changed before). Every WHERE also requires the row to exist, and the
-- verification query at the bottom reports exactly which brands were updated.
--
-- Apply via `supabase db query -f ... --linked` — NOT `supabase db push`.
-- =============================================================================

-- ── PART 4 — Quill: pricing and founding offer ──────────────────────────────
UPDATE public.mkt_clients
SET master_prompt = master_prompt || E'\n\n' || $q$PRICING — CURRENT AS OF 29 JULY 2026:
Starter £149/mo — one platform, three posts per week, monthly strategy plan, monthly performance report.
Growth £249/mo — two platforms, five posts per week, one SEO blog post per month. Everything in Starter.
Pro £399/mo — three platforms, daily posting, two SEO blog posts per month, on-page SEO review, priority support. Everything in Growth.

FOUNDING OFFER: The founding offer (50% off for 12 months for first 10 clients) closed 31 July 2026. Never reference the founding offer in any content after that date. If today is after 31 July 2026, do not mention the founding offer under any circumstances.$q$
WHERE slug = 'quill' AND master_prompt NOT LIKE '%PRICING — CURRENT AS OF 29 JULY 2026%';

-- ── PART 5 — Hormonely: seven day content cycle ─────────────────────────────
UPDATE public.mkt_clients
SET master_prompt = master_prompt || E'\n\n' || $q$SEVEN DAY CONTENT CYCLE — follow this rotation in order:
Monday: a specific symptom and what causes it.
Tuesday: a myth debunked with the evidence.
Wednesday: a practical lifestyle change with the reason behind it.
Thursday: a supplement post. EFSA-compliant claims only. Reference specific Hormonely products by name.
Friday: emotional or psychological aspect of hormonal change.
Saturday: a question the audience is already asking, answered plainly.
Sunday: signpost to hormonely.co.uk and the supplement range.

Always reference the audience as people in their 40s, 50s, and 60s — never omit this age range.
Every post ends with exactly this line: Always speak to your GP before making changes to your health routine.
All supplement claims must be EFSA-compliant. No specific health outcome promises. No unsourced statistics. No decade stack claims — stacks are differentiated by men and women, not by decade.$q$
WHERE slug = 'hormonely' AND master_prompt NOT LIKE '%SEVEN DAY CONTENT CYCLE%';

-- ── PART 5 — Neuro Decoded: 13-topic rotation ───────────────────────────────
UPDATE public.mkt_clients
SET master_prompt = master_prompt || E'\n\n' || $q$CONTENT ROTATION — 13 TOPICS IN STRICT SEQUENCE:
1. Time blindness. 2. Rejection sensitive dysphoria. 3. Emotional dysregulation. 4. Working memory problems. 5. Executive dysfunction. 6. ADHD in women. 7. ADHD myths. 8. NHS waiting list reality. 9. Private assessment costs and options. 10. Right to Choose pathway. 11. Trait profile versus diagnosis. 12. Partner perspective. 13. Employer perspective.

Before generating, check the last 7 days of published posts for this brand. Use the next topic in the sequence not covered in the last 7 days. Never repeat a topic within 7 days.
All posts drive to the free 7-day trial at neurodecoded.co.uk.
Every post ends with exactly this line: Neuro Decoded provides trait screening only. A trait profile is not a clinical diagnosis. If you are concerned about your symptoms please speak to your GP.$q$
WHERE slug = 'neuro-decoded' AND master_prompt NOT LIKE '%13 TOPICS IN STRICT SEQUENCE%';

-- ── PART 5 — Steady: pillars and approved statistics ────────────────────────
UPDATE public.mkt_clients
SET master_prompt = master_prompt || E'\n\n' || $q$CONTENT PILLARS IN SEQUENCE:
1. What GLP-1 medication actually does and why it works.
2. Weight regain — the evidence, the reality, what helps.
3. Muscle loss after stopping and how to protect it.
4. Structured support and what it looks like in practice.
5. Cardiometabolic reversal — the health improvements possible after stopping.
6. Emotional side of stopping — anxiety, identity, the psychological transition.
7. Sleep and energy changes after stopping.
8. Habits of the 17.5% who maintained — what they did differently.

Every post ends with a natural one-line reference to Steady as the place that helps with this transition. Not a hard sell — a consistent presence.
Every post ends with exactly this line: Steady provides lifestyle and wellbeing guidance only. Always follow the advice of your prescriber or GP.

APPROVED STATISTICS — use these only, with source cited in the post:
Over half of people who stop GLP-1 medication regain weight within a year. Source: Medscape, Obesity Week 2025.
People who stop GLP-1 medication return to their original weight after around 1.7 years on average. Source: University of Oxford, January 2026.
46.5% of patients stopped GLP-1 medication after just one year. Source: study of 125,474 individuals, January 2026.
82.5% of people who stopped Mounjaro regained at least a quarter of their weight within a year. Source: SURMOUNT-4 trial, JAMA Internal Medicine, November 2025.$q$
WHERE slug = 'steady' AND master_prompt NOT LIKE '%APPROVED STATISTICS%';

-- ── PART 5 — OUAY: two audiences and seasonal windows ───────────────────────
-- NOTE: the seasonal block below tells the model what the cadence is. The
-- cadence itself is enforced in code — see midnight-cron/index.ts
-- (seasonalPostingOverride), which detects the same three windows at runtime
-- and switches this brand to daily posting. Prompt text alone changes nothing
-- about scheduling.
UPDATE public.mkt_clients
SET master_prompt = master_prompt || E'\n\n' || $q$TWO AUDIENCES — ROTATE EQUALLY ACROSS THE WEEK:
Audience one: the considered parent or gift-buyer. Buying a meaningful, lasting gift. Emotional, thoughtful. The child is genuinely the hero of their own story.
Audience two: the time-poor gift buyer. Birthday in two days, needs something impressive without effort. Quick, easy, looks thoughtful. Speak to this audience directly without judgment.

Always reference the ebook (£2.99) as the immediate gift option and the hardcover (up to £24.99) as the lasting keepsake — natural upsell in every relevant post.
Always state hardcover delivery is 7 to 10 days when driving toward that product.

SEASONAL POSTING: The cron must detect the following windows and increase OUAY posting to daily during them:
- Six weeks before Christmas (from approximately 13 November each year)
- Two weeks before Mother's Day UK (last Sunday before 31 March each year)
- Two weeks before Father's Day UK (third Sunday of June each year)
Outside these windows, OUAY posts four times per week: Monday, Tuesday, Thursday, Saturday at 20:00.$q$
WHERE slug = 'ouay' AND master_prompt NOT LIKE '%TWO AUDIENCES%';

-- ── PART 5 — Riverside: B2B fabrication voice ───────────────────────────────
UPDATE public.mkt_clients
SET master_prompt = master_prompt || E'\n\n' || $q$Riverside is a capable, reliable B2B fabrication business that makes things in metal to specification, on time, at the right price. Audience: businesses and contractors who need metal fabrication work. Industrial, practical buyers making decisions on capability, reliability, and price.
Never use artisan, craft language, master craftsmen, or precision engineering unless that is literally what Riverside does. No lifestyle language. No consumer tone.$q$
WHERE slug = 'riverside' AND master_prompt NOT LIKE '%capable, reliable B2B fabrication business%';

-- ── PART 5 — PS: Sarah Mitchell voice ───────────────────────────────────────
UPDATE public.mkt_clients
SET master_prompt = master_prompt || E'\n\n' || $q$Voice: Sarah Mitchell. Female. Calm, direct, authoritative, research-led. The voice on the Facebook page and in all content.
Every post leads with a verified stat or piece of research. Source must be confirmed before use.
CTA drives to problemsolution.co.uk.
Never reference YCA or Quill directly in PS content — PS stands alone as a brand.$q$
WHERE slug = 'ps' AND master_prompt NOT LIKE '%Voice: Sarah Mitchell%';

-- ── Verification ────────────────────────────────────────────────────────────
SELECT slug,
       length(master_prompt) AS prompt_len,
       (master_prompt LIKE '%PRICING — CURRENT AS OF 29 JULY 2026%') AS has_quill_pricing,
       (master_prompt LIKE '%SEVEN DAY CONTENT CYCLE%')              AS has_hormonely_cycle,
       (master_prompt LIKE '%13 TOPICS IN STRICT SEQUENCE%')         AS has_nd_rotation,
       (master_prompt LIKE '%APPROVED STATISTICS%')                  AS has_steady_stats,
       (master_prompt LIKE '%TWO AUDIENCES%')                        AS has_ouay_audiences,
       (master_prompt LIKE '%capable, reliable B2B fabrication business%') AS has_riverside_voice,
       (master_prompt LIKE '%Voice: Sarah Mitchell%')                AS has_ps_voice
FROM public.mkt_clients
WHERE slug IN ('quill','hormonely','neuro-decoded','steady','ouay','riverside','ps')
ORDER BY slug;
