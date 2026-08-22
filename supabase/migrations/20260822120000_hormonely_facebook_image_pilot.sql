-- =============================================================================
-- 20260822120000_hormonely_facebook_image_pilot.sql
--
-- Pilot: enable Facebook images + 50/50 alternation for Hormonely only, per
-- explicit instruction not to touch the other 6 blocked brands (OUAY, PS,
-- YCA, Steady, Neuro Decoded, Riverside) in this task.
--
-- 1. facebook_image_alternation_enabled — new column, default false. Lets
--    _shared/image.ts's isAlternatingImageStream() opt a client's Facebook
--    stream into the same seed-once-per-run/alternate-in-memory pattern
--    already fixed for Quill (22 Aug), without another hardcoded slug check.
--    False/unset for every client except Hormonely, so this is a no-op for
--    everyone else — the audit's 6 other blocked brands are completely
--    unaffected by this migration.
--
-- 2. image_gen_platforms — adds 'facebook' for Hormonely specifically. A
--    per-client config change, not a change to the underlying allow-list
--    comparison logic in generatePostImage — the logic already correctly
--    treats image_gen_platforms as an explicit per-client allow-list, and
--    changing that comparison to key off connected_platforms instead would
--    have enabled Facebook image generation for all 7 blocked brands at
--    once (they're all Facebook-only), not just Hormonely. Scoped update
--    is the correct fix for a scoped pilot.
-- =============================================================================

alter table public.mkt_clients
  add column if not exists facebook_image_alternation_enabled boolean not null default false;

update public.mkt_clients
set facebook_image_alternation_enabled = true
where slug = 'hormonely';

update public.mkt_clients
set image_gen_platforms = array(select distinct unnest(image_gen_platforms || array['facebook']::text[]))
where slug = 'hormonely'
  and not ('facebook' = any (coalesce(image_gen_platforms, array[]::text[])));
