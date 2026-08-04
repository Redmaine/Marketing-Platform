-- =============================================================================
-- 81_hormonely_banned_structure.sql
--
-- Part 8 — Hormonely's queue had 19 posts land needs_attention, content
-- repeating despite the seven-day rotation. Investigated first, not assumed:
--
--   - The seven-day rotation IS already present in Hormonely's master_prompt
--     ("SEVEN DAY CONTENT CYCLE — follow this rotation in order: Monday...
--     Sunday...") — nothing to add there.
--   - The cron (midnight-cron -> fillClientGap, _shared/fill.ts) WAS passing
--     recent published history into the prompt, but only the last 6 posts
--     (recentPublishedSummaries(admin, client.id, 6)) — under a single week
--     on a daily-plus cadence, which is not enough for the model to actually
--     see whether a topic repeated within its own 7-day rotation window, let
--     alone the 30 this brand's own rotation logic needs to reason about.
--     Fixed in code (_shared/fill.ts): bumped to 30, scoped to the cron's
--     fill path only (generate-content's manual button and CRHQ's own
--     pipeline keep their own n=6, deliberately untouched).
--
-- Appended (not overwritten) below, verbatim as specified.
-- =============================================================================

do $$
declare
  v_exists boolean;
begin
  select exists(select 1 from public.mkt_clients where name = 'Hormonely') into v_exists;
  if not v_exists then
    raise exception 'mkt_clients row with name = ''Hormonely'' not found — aborting update';
  end if;

  update public.mkt_clients
  set master_prompt = master_prompt || E'\n\nBANNED HORMONELY STRUCTURE — never generate more than one post per week on the same symptom or topic. Before generating, check the last 30 posts provided above and confirm the topic has not appeared in the last 7 days. If it has, move to the next topic in the rotation.'
  where name = 'Hormonely';
end $$;
