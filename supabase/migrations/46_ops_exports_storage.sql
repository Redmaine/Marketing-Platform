-- =============================================================================
-- 46_ops_exports_storage.sql — public bucket for the daily-status.json export
-- =============================================================================
insert into storage.buckets (id, name, public) values ('ops-exports', 'ops-exports', true)
on conflict (id) do nothing;

-- Public read (the export contains no personal data — schedule/queue counts
-- only); writes happen server-side via the service role (generate-daily-status),
-- which bypasses RLS — so no write policy is needed here.
drop policy if exists "ops_exports_public_read" on storage.objects;
create policy "ops_exports_public_read" on storage.objects
  for select using (bucket_id = 'ops-exports');
