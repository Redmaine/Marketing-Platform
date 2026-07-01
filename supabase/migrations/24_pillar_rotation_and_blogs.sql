-- =============================================================================
-- 24_pillar_rotation_and_blogs.sql
-- 1. last_pillar_used on mkt_clients — deterministic pillar rotation.
-- 2. mkt_blog_posts — weekly blog generation + approval queue.
-- 3. Confirms connected_platforms exists on mkt_clients (added in migration 20).
-- 4. Confirms metricool_post_id exists on mkt_scheduled_posts (added in migration 16).
-- Idempotent. Run in Supabase SQL Editor (project fvyvtdwsomxfkpxwygpk).
-- =============================================================================

-- ── 1. Pillar rotation ────────────────────────────────────────────────────────
ALTER TABLE public.mkt_clients
  ADD COLUMN IF NOT EXISTS last_pillar_used text;

-- ── 2. Blog posts ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS mkt_blog_posts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid REFERENCES mkt_clients(id) ON DELETE CASCADE,
  title text NOT NULL,
  slug text NOT NULL,
  meta_title text,
  meta_description text,
  content_html text NOT NULL,
  status text DEFAULT 'draft' CHECK (status IN ('draft','approved','published')),
  publish_date date,
  created_at timestamptz DEFAULT now(),
  published_at timestamptz
);
ALTER TABLE mkt_blog_posts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "blog_posts_owner" ON mkt_blog_posts;
CREATE POLICY "mkt_blog_posts_admin_all" ON mkt_blog_posts
  FOR ALL USING (public.mkt_is_admin()) WITH CHECK (public.mkt_is_admin());
CREATE POLICY "mkt_blog_posts_client_read" ON mkt_blog_posts
  FOR SELECT USING (client_id IN (SELECT public.mkt_user_client_ids()));

CREATE INDEX IF NOT EXISTS mkt_blog_posts_client_publish
  ON mkt_blog_posts (client_id, publish_date DESC);

-- ── 3. Confirm connected_platforms (migration 20) ────────────────────────────
ALTER TABLE public.mkt_clients
  ADD COLUMN IF NOT EXISTS connected_platforms text[] DEFAULT ARRAY['facebook'];

-- ── 4. Confirm metricool_post_id on mkt_scheduled_posts (migration 16) ───────
ALTER TABLE public.mkt_scheduled_posts
  ADD COLUMN IF NOT EXISTS metricool_post_id TEXT;

-- ── Verify ────────────────────────────────────────────────────────────────────
-- SELECT column_name FROM information_schema.columns
--   WHERE table_name = 'mkt_clients' AND column_name = 'last_pillar_used';
-- SELECT table_name FROM information_schema.tables WHERE table_name = 'mkt_blog_posts';
-- SELECT column_name FROM information_schema.columns
--   WHERE table_name = 'mkt_clients' AND column_name = 'connected_platforms';
-- SELECT column_name FROM information_schema.columns
--   WHERE table_name = 'mkt_scheduled_posts' AND column_name = 'metricool_post_id';
