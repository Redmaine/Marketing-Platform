-- CRHQ: stop the legacy profile fields contradicting the brand brief.
-- 25 Sep 2026. Data half of the instruction-drift fix (code half: the
-- CRHQ_* blocks in supabase/functions/_shared/prompts.ts).
--
-- mkt_clients.industry / key_services / target_customer / tone_of_voice are
-- injected verbatim into every generation prompt by buildUserMessage. They
-- predate master_prompt and nobody has curated them since. Traced from the
-- reconstructed prompt, they were contradicting the brief Adrian actually
-- edits, in four places at once:
--
--   key_services  "180,000 subscribers"        brief: ~189,200
--   key_services  "Discount code YOUTUBE10 active for YouTube viewers"
--                 — the SAME string is in this brand's banned_words. The
--                 platform was feeding the model the code and then never
--                 checking whether it used it (banned_words was read by
--                 nothing anywhere in the codebase until today).
--   key_services  the five named coffee blends — the weekly shop/coffee
--                 prompt explicitly tells the model it does NOT know what
--                 the shop sells and must not name products.
--   tone_of_voice "Think experienced analyst, not commentator"
--                 brief: "Craig's own opinion and analysis... delivered
--                 straight to camera". Analyst-not-commentator is a direct
--                 instruction to write the third-person commentary Adrian
--                 flagged.
--   target_customer "25-55"                    brief: "AUDIENCE: 45-65+"
--
-- These are rewritten to defer to the brief rather than restate it, so there
-- is one source of truth for voice, audience and commercials. Nothing here
-- invents a fact: every figure is either removed or taken from the brief.
update public.mkt_clients set
  key_services = 'YouTube channel covering UK breaking news, UK politics, and UK military and defence headlines. Secondary coverage of international conflicts and global defence. Website combatreadyhq.co.uk carries a live global events map, intelligence briefings and news articles alongside the shop. See the brand brief for subscriber figures, shop and subscription detail — do not state any of it from this field.',
  tone_of_voice = 'Straight-talking, authoritative, direct. Knowledgeable without being academic. No hedging, no waffle. Occasional dry humour but default mode is professional and credible. Never clickbait, never sensationalist, never agenda-driven, never party-political. Voice and point of view are set by the brand brief — write as Craig, in his own words.',
  target_customer = 'UK-based, 45-65+. Ex-military, defence professionals, serious news consumers, people who feel mainstream media under-covers UK news and defence topics.',
  last_pillar_used = last_pillar_used  -- no-op; this table has no updated_at column
where id = 'c14ccad0-21f8-44f0-9464-24f321bea37b';

-- The duplicate, inactive "Combat Ready HQ" row (31a5fb2e-…, no slug, active
-- false, its own 6,202-char master_prompt) is deliberately NOT touched. It is
-- not read by the pipeline (crhq-nightly-content selects by slug 'crhq'), but
-- it is a second copy of the brief that could be edited by mistake — flagged
-- for Adrian rather than deleted by a script.
