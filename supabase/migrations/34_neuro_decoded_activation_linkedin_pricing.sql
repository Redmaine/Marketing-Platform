-- =============================================================================
-- 34_neuro_decoded_activation_linkedin_pricing.sql
-- Three changes:
--   1. Activate Neuro Decoded + set its Metricool brand ID.
--      (Metricool's shared userId=4984082 is already hardcoded in
--      supabase/functions/schedule-to-metricool — no per-client column for it.)
--   2. New mkt_social_accounts table for non-client-scoped social profiles
--      (e.g. Adrian's personal LinkedIn), + seed the LinkedIn record.
--   3. Append correct Neuro Decoded pricing to its master_prompt.
-- Idempotent. Run in Supabase SQL Editor or `supabase db push` (project fvyvtdwsomxfkpxwygpk).
-- =============================================================================

-- ── 1. Activate Neuro Decoded ────────────────────────────────────────────────
UPDATE public.mkt_clients
SET active = true,
    metricool_brand_id = '6539564'
WHERE slug = 'neuro-decoded';
-- post_days is already the full week and post_time is already 09:00 for this
-- client — both already sensible, left untouched.

-- ── 2. mkt_social_accounts — social profiles not tied to a single client ────
create table if not exists public.mkt_social_accounts (
  id                 uuid primary key default gen_random_uuid(),
  created_at         timestamptz default now(),
  client_id          uuid references public.mkt_clients(id) on delete cascade, -- null = agency/personal, not client-scoped
  owner_label        text not null,
  platform           text not null check (platform in ('facebook','instagram','linkedin','google_business','twitter','tiktok','youtube')),
  account_type       text not null check (account_type in ('personal','business')) default 'business',
  metricool_blog_id  text,
  active             boolean default true
);

alter table public.mkt_social_accounts enable row level security;

drop policy if exists "mkt_social_accounts_admin_all" on public.mkt_social_accounts;
create policy "mkt_social_accounts_admin_all" on public.mkt_social_accounts
  for all using (public.mkt_is_admin()) with check (public.mkt_is_admin());

drop policy if exists "mkt_social_accounts_client_read" on public.mkt_social_accounts;
create policy "mkt_social_accounts_client_read" on public.mkt_social_accounts
  for select using (client_id in (select public.mkt_user_client_ids()));

insert into public.mkt_social_accounts (owner_label, platform, account_type, metricool_blog_id, active)
select 'Adrian Fielding — Personal', 'linkedin', 'personal', null, true
where not exists (
  select 1 from public.mkt_social_accounts
  where platform = 'linkedin' and account_type = 'personal' and owner_label = 'Adrian Fielding — Personal'
);

-- ── 3. Neuro Decoded pricing correction ──────────────────────────────────────
-- The master_prompt currently has no pricing line at all (not £6.99 or
-- otherwise) — appending the correct tiers rather than replacing text.
UPDATE public.mkt_clients
SET master_prompt = master_prompt || ' Pricing: £1.99/month Basic, £3.99/month Enhanced. A one-off £25 pre-assessment report becomes available after 30 days.'
WHERE slug = 'neuro-decoded'
  AND master_prompt NOT LIKE '%Pricing:%';
