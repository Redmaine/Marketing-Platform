-- Opportunity scanner: make the "Businesses to Replicate" outcome auditable.
--
-- opportunity_scanner_runs.opportunities_found counts SCORED opportunities
-- only. The replicate section is counted nowhere, so a run that surfaced zero
-- opportunities and three businesses to replicate logged an identical row to
-- a run that surfaced nothing at all and sent the "nothing today" notice —
-- both `opportunities_found: 0, email_sent: true`. That ambiguity was hit for
-- real while verifying the two-category rewrite: the run log could not answer
-- what the section actually did, and the function's console output is not
-- reliably retrievable for a background function after the fact.
--
-- replicate_dropped stores the reasons, not just a count, because the useful
-- question about this section is no longer "how many did it find" but "what
-- did it refuse, and why" — a run that drops three entries for missing
-- competitor checks is the filter working, and should be legible as such
-- rather than looking like a quiet day.
alter table public.opportunity_scanner_runs
  add column if not exists replicate_kept integer,
  add column if not exists replicate_dropped jsonb;
