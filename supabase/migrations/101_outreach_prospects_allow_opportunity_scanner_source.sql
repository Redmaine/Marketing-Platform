-- Fix (26 Aug 2026, YCA Prospects email audit): outreach_prospects_source_check
-- has never allowed 'opportunity_scanner', the literal source value
-- netlify/functions/opportunity-scanner-worker-background.mjs's
-- insertProspects() has inserted since the feature was built (31 Jul 2026,
-- b2d8640). Every insert attempt has failed with a check-constraint
-- violation, silently — insertProspects() catches and logs the error but
-- never throws, so it never surfaced. Confirmed via direct query: zero rows
-- in outreach_prospects have ever carried source = 'opportunity_scanner',
-- despite the scanner having found and attempted to insert prospects on
-- multiple runs (see opportunity_scanner_runs).
--
-- This matters beyond just fixing the bug: the daily email's "YCA Prospects"
-- section was just reduced from full per-entry detail to a single count
-- line ("N new prospects added to outreach today"), specifically because
-- the detail had no review value once prospects are auto-added to the
-- outreach pipeline. That count is only honest if the auto-add genuinely
-- happens — without this fix, it would report a number of prospects that
-- were found but never actually landed in outreach_prospects.
alter table public.outreach_prospects
  drop constraint outreach_prospects_source_check;

alter table public.outreach_prospects
  add constraint outreach_prospects_source_check
  check (source = any (array[
    'companies_house'::text,
    'companies_house_bulk'::text,
    'google_search'::text,
    'csv_import'::text,
    'trade_body'::text,
    'opportunity_scanner'::text
  ]));
