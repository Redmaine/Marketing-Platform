-- =============================================================================
-- 49_crhq_prompt_no_metrics.sql — CRHQ posts were referencing invented/
-- estimated engagement figures (view counts, coverage-outcome claims). The
-- worst offender was code-level (buildUserMessage in _shared/prompts.ts
-- injected "(N views)" straight from the scrape cache into the prompt,
-- fixed separately in that file) — this migration adds an explicit,
-- unambiguous prohibition to CRHQ's own master_prompt so the constraint
-- holds regardless of what the scrape block does or doesn't include.
--
-- Appends to the existing master_prompt (23_crhq_client_seed.sql) rather
-- than replacing it — the brand voice/content-pillar guidance is unchanged,
-- this only adds a new hard constraint at the end.
--
-- Run in the Supabase SQL editor.
-- =============================================================================

UPDATE public.mkt_clients
SET master_prompt = master_prompt || E'\n\nNEVER reference engagement metrics, viewer/subscriber numbers, coverage outcomes, channel performance, or any invented or estimated figure — for this brand''s own content or anyone else''s. When referencing what Combat Ready HQ has actually covered, reference only the channel name (Combat Ready HQ), the topic/title, and the URL provided (website or the specific video/article link) — nothing else about it. If no real recent content has been provided for this post, do not invent any — write from the content pillars and channel name only.'
WHERE slug = 'crhq';
