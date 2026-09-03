-- =============================================================================
-- 102_outreach_prospects_places_fields.sql
--
-- Fields for the Google Places enrichment stage (salon/hair/beauty slice
-- first: 17,154 prospects, of which 16,937 have no website_url and ALL
-- 17,154 have no postcode — verified against the live table, not assumed).
--
-- WHY A SEPARATE ADDRESS COLUMN. outreach_prospects already has location,
-- city and country, but those come from Companies House bulk data and are a
-- registered-office TOWN, not a street address ("Aylesbury", "Plymouth,
-- Devon"). Places returns a full formatted address, which is a different
-- fact about a different thing (the trading premises) and must not overwrite
-- the Companies House location — the two are cross-checked against each
-- other during verification, so collapsing them into one column would
-- destroy the only signal that says "this match is in the wrong town".
--
-- POSTCODE: outreach_prospects.postcode already exists and is empty for
-- every row in this slice. Places returns the postcode BOTH inside the
-- formatted address string AND as a discrete addressComponents entry
-- (types: ['postal_code']). The worker prefers the discrete component and
-- falls back to a UK-postcode regex over the formatted address, so this
-- column gets a real postcode rather than a substring guess.
--
-- RATINGS: only the two numeric fields. Individual review text is
-- deliberately NOT captured or stored anywhere — the outreach copy only ever
-- needs "rated 4.9 from 75 reviews", and storing review prose would mean
-- holding third-party authored content we have no need for and no licence to
-- reuse.
-- =============================================================================

ALTER TABLE public.outreach_prospects
  -- Full trading address as Places returned it, verbatim. Never parsed down
  -- or "tidied" — the raw string is what we can defend if a match is queried.
  ADD COLUMN IF NOT EXISTS address text,
  -- Numeric rating and review count, for the outreach personalisation line.
  ADD COLUMN IF NOT EXISTS google_rating numeric(2,1),
  ADD COLUMN IF NOT EXISTS google_rating_count integer,
  -- The Places id of the ACCEPTED match. Kept so a decision can be re-audited
  -- against the exact listing it was based on, and so a re-run can tell
  -- "already matched" from "never attempted".
  ADD COLUMN IF NOT EXISTS google_place_id text,
  -- 'accepted' | 'unverified' | 'rejected' | 'not_found'. Mirrors the outcome
  -- written to outreach_enrichment_attempts so the prospect row alone can be
  -- filtered without joining, but the attempts row remains the full record.
  ADD COLUMN IF NOT EXISTS places_status text,
  -- Short human-readable reason for that status, e.g.
  -- "name+city+type matched (score 0.92)" or
  -- "rejected: country GB expected, got JM".
  ADD COLUMN IF NOT EXISTS places_confidence text,
  ADD COLUMN IF NOT EXISTS places_checked_at timestamptz;

COMMENT ON COLUMN public.outreach_prospects.address IS
  'Full formatted trading address from Google Places, verbatim. Distinct from location/city, which are the Companies House registered town and are used to VERIFY this, not to be replaced by it.';
COMMENT ON COLUMN public.outreach_prospects.google_rating IS
  'Numeric Places rating (e.g. 4.9). Review TEXT is deliberately never stored.';
COMMENT ON COLUMN public.outreach_prospects.google_rating_count IS
  'Number of Places reviews behind google_rating. Null when the listing carries no reviews — not every verified match has one.';
COMMENT ON COLUMN public.outreach_prospects.places_status IS
  'accepted | unverified | rejected | not_found. Same vocabulary as the outcome on the matching outreach_enrichment_attempts row.';

-- Lets a resumable run skip prospects already attempted without scanning the
-- attempts table, and makes "how many are still unattempted" a cheap count.
CREATE INDEX IF NOT EXISTS outreach_prospects_places_status_idx
  ON public.outreach_prospects (places_status)
  WHERE places_status IS NOT NULL;

-- ── Extend the enrichment-attempt vocabulary for this stage ────────────────
-- outreach_enrichment_attempts was built for the email pilot and its CHECK
-- constraints still say so: stage IN ('website','email') and outcome without
-- 'rejected'. Caught by attempting a real insert, not by inspection — the
-- worker would have failed on its first write against every prospect.
--
-- 'rejected' is added rather than folded into 'not_found' because they are
-- genuinely different facts and the brief depends on telling them apart:
-- not_found  = Places returned nothing for this query.
-- rejected   = Places returned candidates and every one FAILED verification
--              (wrong country, wrong business, contradicting type).
-- Collapsing them would hide the entire reason this verification step exists.
--
-- 'robots_disallowed' is carried over deliberately: a first attempt at this
-- constraint omitted it and Postgres refused the migration because real
-- pilot rows already used it. Re-stating an enum means re-stating ALL of it.
ALTER TABLE public.outreach_enrichment_attempts
  DROP CONSTRAINT IF EXISTS outreach_enrichment_attempts_stage_check;
ALTER TABLE public.outreach_enrichment_attempts
  ADD CONSTRAINT outreach_enrichment_attempts_stage_check
  CHECK (stage = ANY (ARRAY['website'::text, 'email'::text, 'places'::text]));

ALTER TABLE public.outreach_enrichment_attempts
  DROP CONSTRAINT IF EXISTS outreach_enrichment_attempts_outcome_check;
ALTER TABLE public.outreach_enrichment_attempts
  ADD CONSTRAINT outreach_enrichment_attempts_outcome_check
  CHECK (outcome = ANY (ARRAY['found'::text, 'not_found'::text, 'unverified'::text,
                              'unreachable'::text, 'blocked'::text, 'error'::text,
                              'robots_disallowed'::text, 'rejected'::text]));
