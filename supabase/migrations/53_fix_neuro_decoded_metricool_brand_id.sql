-- =============================================================================
-- 53_fix_neuro_decoded_metricool_brand_id.sql
--
-- Corrects Neuro Decoded's Metricool brand ID. Migration 34 set it to
-- '6539564'; the correct value is '6545782'. schedule-to-metricool passes this
-- straight through as the `blogId` query param on every Metricool scheduler
-- call (see its lines ~155-156), so a wrong ID means every Neuro Decoded post
-- is submitted against a brand that isn't theirs — which is very likely the
-- root cause of the Neuro Decoded Metricool failure investigated earlier
-- (previously concluded to be external/not-code-fixable; a bad blogId fits
-- those symptoms and was not ruled out at the time).
--
-- metricool_brand_id is TEXT (migration 16), hence the quoted value.
--
-- Guarded on the known-bad value so re-running is safe and so it can't
-- silently overwrite a different ID someone has since corrected by hand.
-- If the UPDATE reports 0 rows, check the verification SELECT below — the
-- value has already been changed from '6539564' by some other route.
--
-- Apply in the Supabase SQL editor (this project's convention — see
-- migration 44's header re: the schema_migrations history gap).
-- =============================================================================

UPDATE public.mkt_clients
SET metricool_brand_id = '6545782'
WHERE slug = 'neuro-decoded'
  AND metricool_brand_id IS DISTINCT FROM '6545782';

-- Verification — run after the UPDATE. Expect neuro-decoded => 6545782.
SELECT slug, name, metricool_brand_id, active, connected_platforms
FROM public.mkt_clients
WHERE slug = 'neuro-decoded';
