-- =============================================================================
-- 72_adrian_linkedin_no_fabrication.sql
--
-- Incident fix: the Adrian Fielding — LinkedIn brand (migration 71)
-- generated "We hired someone last week who turned down a higher salary to
-- join us." Redmaine has no employees — this was a first-person invented
-- fact that passed the review pipeline (reviewPost's fabrication check only
-- ever covered named-business/case-study fabrication, not first-person
-- personal claims about hiring/employees/team/testimonials — see
-- _shared/review.ts for the corresponding code-side fix).
--
-- Appends (does not replace) the CRITICAL instruction to this client's
-- existing master_prompt, verbatim as specified.
-- =============================================================================

update public.mkt_clients
set master_prompt = master_prompt || E'\n\n' ||
  'CRITICAL: Adrian Fielding is a solo founder. Redmaine has no employees. Never fabricate hiring decisions, team members, client testimonials, or any first-person claim that cannot be verified from the platform''s own data. If you cannot ground a claim in something that actually happened in the Redmaine operation this week, do not make the claim. Write only what is true.'
where slug = 'adrian-linkedin';
