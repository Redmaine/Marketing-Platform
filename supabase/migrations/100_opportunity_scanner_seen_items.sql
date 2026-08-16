-- Persistent repeat-prevention for the opportunity scanner.
--
-- Root cause this fixes: there was no exclusion table anywhere in this
-- codebase. The three sections each handled repeats differently, and only
-- one of them actually worked off persisted state:
--
--   * Scored Opportunities / Businesses to Replicate — a HARDCODED list of
--     ~24 business names baked into the prompt string in
--     netlify/functions/opportunity-scanner-worker-background.mjs. Manually
--     curated, never written to by code, so it only "works" for as long as
--     someone keeps hand-editing it. It does not learn from past runs.
--   * YCA Prospects — real dedup, but against outreach_prospects (the
--     outreach platform's own table), which is why that one genuinely works.
--   * UK Legislation Watch — nothing at all. Items were never recorded after
--     being emailed and never checked before inclusion, so the same handful
--     of major changes (MTD, Employment Rights Act, Companies House reform)
--     resurfaced every single run. That is the reported bug.
--
-- This table is the missing persistence layer. Keyed by a normalised form of
-- the item title (see normaliseKey in the worker) so trivial rewordings of
-- the same legislation collapse onto one row rather than counting as new.
--
-- `section` is deliberately a free text tag rather than an enum: legislation
-- is the only writer today, but opportunities/replicate can be migrated off
-- the hardcoded prompt list onto this same table later without a schema
-- change.
create table if not exists public.opportunity_scanner_seen_items (
  id            uuid primary key default gen_random_uuid(),
  section       text        not null,
  item_key      text        not null,
  title         text        not null,
  first_seen_at timestamptz not null default now(),
  last_seen_at  timestamptz not null default now(),
  times_seen    integer     not null default 1
);

-- The dedup contract. Also the ON CONFLICT target the worker upserts against
-- — a partial or non-unique index here would break that with
-- "no unique or exclusion constraint matching the ON CONFLICT specification"
-- (same failure mode as migrations 87 / 20260810_mkt_post_performance_uniq).
create unique index if not exists opportunity_scanner_seen_items_section_key_uniq
  on public.opportunity_scanner_seen_items (section, item_key);

-- Supports the worker's "recent items for this section" lookup, which is
-- ordered by last_seen_at and windowed to the last N days.
create index if not exists opportunity_scanner_seen_items_section_last_seen_idx
  on public.opportunity_scanner_seen_items (section, last_seen_at desc);

-- Service-role only, same as opportunity_scanner_runs: the worker is the sole
-- reader and writer, and nothing in any browser-facing app touches this.
alter table public.opportunity_scanner_seen_items enable row level security;
