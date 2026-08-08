-- =============================================================================
-- 90_yca_remove_payroll_reference.sql
--
-- YCA's master_prompt (mkt_clients.slug = 'yca') described "HR with payroll"
-- as one of the 11 modules in its WHAT YCA DOES section — directly
-- contradicting migration 89's BLOG ACCURACY RULE, which explicitly bans
-- writing about payroll as a live feature. Fixed: "HR with payroll" ->
-- "HR".
--
-- Also checked the same field for "MTD VAT" and "bank reconciliation" — the
-- only occurrences were in the BLOG ACCURACY RULE's own prohibition
-- sentence ("DO NOT write about payroll, MTD VAT, bank reconciliation, or
-- any feature not in this list"), not describing them as live. Removed the
-- explicit names there too per instruction — this does NOT weaken the rule,
-- since the sentence's catch-all ("...or any feature not in this list")
-- already prohibits every feature not on the confirmed-live list, payroll/
-- MTD VAT/bank reconciliation included. Now reads "DO NOT write about any
-- feature not in this list."
--
-- Applied directly against the live row and read back to confirm zero
-- remaining case-insensitive matches for "payroll", "mtd vat", or "bank
-- reconciliation" anywhere in master_prompt. This migration documents the
-- same change as an idempotent UPDATE.
-- =============================================================================

UPDATE public.mkt_clients
SET master_prompt = replace(
  replace(
    master_prompt,
    'invoicing, HR with payroll, job costing',
    'invoicing, HR, job costing'
  ),
  'DO NOT write about payroll, MTD VAT, bank reconciliation, or any feature not in this list.',
  'DO NOT write about any feature not in this list.'
)
WHERE slug = 'yca';
