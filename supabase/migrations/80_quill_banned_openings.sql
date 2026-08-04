-- =============================================================================
-- 80_quill_banned_openings.sql
--
-- Part 7 — Quill was generating Facebook posts that all opened with the same
-- observational pattern ("I've been tracking", "I've been watching", "I've
-- noticed"). Investigated first, not assumed:
--
--   - buildSystemPrompt (_shared/prompts.ts) DOES inject UNIVERSAL_CONTENT_RULES
--     before the brand's own master_prompt on every single generation call,
--     for every brand, unconditionally — confirmed by reading the function:
--     parts.push(UNIVERSAL_CONTENT_RULES) precedes parts.push(base). No
--     injection bug found.
--   - UNIVERSAL_CONTENT_RULES itself has never contained a banned-openings
--     list — this is not "the preamble has the rule but it's being
--     overridden", it is "no rule against this specific pattern has existed
--     anywhere yet, universal or brand-specific".
--   - Quill's existing master_prompt has no rule that directly contradicts a
--     banned-openings instruction, but its framing ("Every post is a dispatch
--     from an ongoing experiment", "You lean into what you are") plausibly
--     nudges the model toward exactly this observational-report voice —
--     noted as a likely contributing factor, not a hard conflict to remove.
--
-- Appended (not overwritten) below, verbatim as specified. Positioned last in
-- master_prompt, and master_prompt itself is positioned after
-- UNIVERSAL_CONTENT_RULES in buildSystemPrompt — same "brand-specific,
-- positioned last, wins on conflict" pattern already used for CRHQ's house
-- rules.
-- =============================================================================

do $$
declare
  v_exists boolean;
begin
  select exists(select 1 from public.mkt_clients where name = 'Quill') into v_exists;
  if not v_exists then
    raise exception 'mkt_clients row with name = ''Quill'' not found — aborting update';
  end if;

  update public.mkt_clients
  set master_prompt = master_prompt || E'\n\nBANNED QUILL OPENINGS — never start any post with: I''ve been tracking, I''ve been watching, I''ve noticed, I''ve been measuring, I''ve been looking at, I''ve observed, I''ve seen. Every Quill post must open with a specific claim, a direct question, or a provocation. Never with an observation about what Quill has been doing.'
  where name = 'Quill';
end $$;
