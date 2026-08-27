-- =============================================================================
-- 102_opportunity_scanner_search_queries.sql
--
-- Records the actual web-search queries each opportunity-scanner run issued,
-- not just how many it issued.
--
-- Why this was missing and why it matters: the scanner is the single largest
-- AI API cost line in the portfolio, and its competitor check has now failed
-- to find a real, findable UK competitor five separate times (a CV builder,
-- Meez, an RTW compliance tool, an MTD bookkeeping tool, and the 27 Aug
-- meal-plan SaaS finding that missed Meal Matcher, Coachway, MUNCH and
-- Cherrypick). Every one of those investigations hit the same wall: the run
-- log recorded web_searches as a COUNT (opportunity_scanner_runs.web_searches,
-- migration 20260817_opportunity_scanner_research_telemetry.sql) and threw the
-- query strings away, so "what did it actually search?" — the one question
-- that separates a bad judgement from a bad query — could only ever be
-- answered by guessing from the prompt.
--
-- The worker already saw each query: it arrives on the streamed
-- server_tool_use block. It just incremented a counter and discarded it.
-- Now captured and stored here.
--
-- jsonb array of strings, in the order the model issued them. Null for runs
-- that searched nothing (an early error, a hard timeout before the first
-- search), which is distinct from '[]' — the latter would claim a run
-- searched and found no queries worth recording, which cannot happen.
-- =============================================================================

alter table public.opportunity_scanner_runs
  add column if not exists search_queries jsonb;

comment on column public.opportunity_scanner_runs.search_queries is
  'The actual web-search queries this run issued, in order, as a jsonb array of strings. Null when the run issued none. Added 27 Aug 2026 — before this, only the count was kept, which made every missed-competitor investigation guesswork.';
