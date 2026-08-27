-- =============================================================================
-- 103_opportunity_scanner_replicate_findings.sql
--
-- Full evidence trail for the rebuilt "Businesses to Replicate" section
-- (26 Aug 2026 rewrite) — one row per candidate the model actually examined,
-- kept or dropped, with the real search queries and the real evidence found.
--
-- Why this exists: opportunity_scanner_runs.replicate_dropped already stores
-- a per-run JSON blob of what was rejected and why (migration
-- 20260817_opportunity_scanner_replicate_audit.sql), but it is one blob per
-- RUN, not one row per FINDING — you cannot query "every business ever found
-- with reviews-based evidence" or "how many times has this exact business
-- been surfaced" without parsing JSON out of every run row by hand. That is
-- the exact evidence-gap pattern that already broke diagnosis twice this
-- month: the legislation section before opportunity_scanner_seen_items
-- existed, and the old idea-then-competitor-check replicate section before
-- search_queries existed on opportunity_scanner_runs. This table is built so
-- it cannot recur a third time for this section's rebuild.
--
-- One row per candidate PER RUN (kept and dropped both) — a business found
-- and rejected today, then found and accepted next month, is two rows, and
-- that history is the point: it shows whether the bar is being applied
-- consistently, not just what shipped.
create table if not exists public.opportunity_scanner_replicate_findings (
  id                uuid primary key default gen_random_uuid(),
  run_id            uuid references public.opportunity_scanner_runs(id) on delete set null,
  created_at        timestamptz not null default now(),

  -- Identity
  name              text not null,
  url               text,
  idea_key          text,

  -- Outcome
  kept              boolean not null,
  drop_reasons      jsonb,              -- null when kept=true

  -- The evidence-of-traction gate (requirement 1) — one of
  -- companies_house | reviews | hiring | growth_signal, plus what was
  -- actually found and where.
  evidence_type     text,
  evidence_detail   text,
  evidence_source   text,

  -- Adrian's three questions (requirement 2), stored as the structured
  -- objects the model returned, not summarised prose — replicate (customer +
  -- mechanism), improve (gap_type + detail + evidence_source), low_capital
  -- (model + why). jsonb rather than separate columns: the shape is still
  -- settling and jsonb keeps every raw field queryable via ->> without a
  -- migration for each one.
  replicate         jsonb,
  improve           jsonb,
  low_capital       jsonb,

  -- The actual search queries used — discovery (finding the candidate) and
  -- verification (confirming the evidence and the gap) kept distinct, since
  -- a finding with real discovery queries but no verification queries is a
  -- different failure from the reverse.
  discovery_queries    jsonb,
  verification_queries jsonb
);

create index if not exists opportunity_scanner_replicate_findings_run_idx
  on public.opportunity_scanner_replicate_findings (run_id);
create index if not exists opportunity_scanner_replicate_findings_name_idx
  on public.opportunity_scanner_replicate_findings (lower(name));
create index if not exists opportunity_scanner_replicate_findings_kept_idx
  on public.opportunity_scanner_replicate_findings (kept, created_at desc);

-- Service-role only, same as every other opportunity-scanner table — the
-- worker is the sole reader/writer.
alter table public.opportunity_scanner_replicate_findings enable row level security;
