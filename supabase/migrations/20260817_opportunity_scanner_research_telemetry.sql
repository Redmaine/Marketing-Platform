-- Opportunity scanner: record whether the model actually did the research.
--
-- On 17 Aug four Section A runs produced one genuinely good finding (136.3s)
-- and three empty sections (50.9s, 74.3s, 97.8s). Nothing in the run log or
-- the code could distinguish "searched hard, honestly found nothing" from
-- "declined without searching" — the only signal was wall-clock duration,
-- which is circumstantial. fetchResearchText was parsing the SSE stream for
-- text_delta events and explicitly discarding everything else, including the
-- two events that answer this directly.
--
-- web_searches  — one per server_tool_use block, i.e. per web_search the model
--                 actually issued. This is the real evidence of effort: an
--                 empty section behind 12 searches is a genuine negative
--                 result; an empty section behind 0-1 searches is a bail.
-- stop_reason   — 'max_tokens' means the answer was truncated, which silently
--                 destroys whichever fenced block hadn't been emitted yet.
--                 The 50.9s run returned no ```replicate block at all, which
--                 is exactly that signature, and nothing reported it.
-- research_ms   — the Anthropic call itself, rather than end-to-end handler
--                 time which also includes email and database work.
-- research_chars— response size, to spot a truncated or stunted answer.
alter table public.opportunity_scanner_runs
  add column if not exists research_ms integer,
  add column if not exists research_chars integer,
  add column if not exists web_searches integer,
  add column if not exists stop_reason text;
