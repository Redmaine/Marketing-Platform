-- =============================================================================
-- 10_reports_storage.sql — private bucket for generated report PDFs
-- generate-pdf writes here (service role) and returns a long-lived signed URL,
-- which is stored in mkt_reports.pdf_url. Private — no public read policy.
-- =============================================================================
insert into storage.buckets (id, name, public) values ('mkt-reports', 'mkt-reports', false)
on conflict (id) do nothing;
