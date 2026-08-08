-- =============================================================================
-- 89_yca_blog_accuracy_rule.sql
--
-- Appends a BLOG ACCURACY RULE to YCA's master_prompt (mkt_clients.slug =
-- 'yca'), listing the features actually confirmed live in the YCA platform
-- and explicitly banning payroll, MTD VAT, bank reconciliation, and any
-- other unbuilt feature from being represented as live to prospects or
-- customers. Applied directly against the live row via REST (see below);
-- this file documents that change in git, matching the append-only text
-- exactly as specified — no other part of the existing master_prompt was
-- touched.
--
-- Documentation only — the UPDATE below is idempotent (only appends if the
-- rule isn't already present), safe to run again.
-- =============================================================================

UPDATE public.mkt_clients
SET master_prompt = master_prompt || E'\n\nBLOG ACCURACY RULE: Only write about features that are confirmed live in the YCA platform. Confirmed live features: Staff Rota, Bills and Expenses, Production Manager, Job Management, Invoicing, Tap to Pay, COSHH library, Asset QR codes, QR clock in/out, Automated review requests, AI pricing check, Voice input, Multi-company switcher, Driver allocation, Toolbox talk AI. DO NOT write about payroll, MTD VAT, bank reconciliation, or any feature not in this list. These are not built and must never be represented as live to prospects or customers.'
WHERE slug = 'yca'
  AND master_prompt NOT LIKE '%BLOG ACCURACY RULE:%';
