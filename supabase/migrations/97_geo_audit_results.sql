-- =============================================================================
-- 97_geo_audit_results.sql — geo_audit_results: geo-site-audit's output
--
-- One row per audit run (not upserted — a domain can be re-audited over time
-- and every run is kept as history, same reasoning as crhq_scrape_cache).
-- client_id is nullable: set for Redmaine's own brands (source='internal'),
-- left null for external prospect domains that aren't in mkt_clients at all
-- (source='prospect').
--
-- Written by geo-site-audit using the service role (bypasses RLS), same
-- pattern as crhq_scrape_cache (migration 40) — no insert policy needed.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.geo_audit_results (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  domain                   text NOT NULL,
  client_id                uuid REFERENCES public.mkt_clients(id),
  checked_at               timestamptz NOT NULL DEFAULT now(),
  has_schema_markup        boolean NOT NULL,
  has_faq_schema           boolean NOT NULL,
  has_llms_txt             boolean NOT NULL,
  pricing_published        boolean NOT NULL,
  last_content_update_date date,
  score                    integer NOT NULL CHECK (score BETWEEN 0 AND 100),
  findings                 jsonb NOT NULL DEFAULT '[]'::jsonb,
  source                   text NOT NULL CHECK (source IN ('internal', 'prospect'))
);

ALTER TABLE public.geo_audit_results ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "geo_audit_results_admin_read" ON public.geo_audit_results;
CREATE POLICY "geo_audit_results_admin_read" ON public.geo_audit_results
  FOR SELECT USING (public.mkt_is_admin());

CREATE INDEX IF NOT EXISTS geo_audit_results_domain_checked_at
  ON public.geo_audit_results (domain, checked_at DESC);

CREATE INDEX IF NOT EXISTS geo_audit_results_client_id
  ON public.geo_audit_results (client_id);
