-- =============================================================================
-- 09_storage.sql — public bucket for client logos (onboarding-scrape)
-- =============================================================================
insert into storage.buckets (id, name, public) values ('mkt-assets', 'mkt-assets', true)
on conflict (id) do nothing;

-- Public read of marketing assets; writes happen server-side via the service role
-- (onboarding-scrape), which bypasses RLS — so no write policy is needed here.
drop policy if exists "mkt_assets_public_read" on storage.objects;
create policy "mkt_assets_public_read" on storage.objects
  for select using (bucket_id = 'mkt-assets');
