-- =============================================================================
-- 36_website_posts.sql — mkt_website_posts: publish-to-website blog posts
--
-- Distinct from mkt_blog_posts (migration 24) — that table holds weekly
-- AI-generated blog drafts which get *repurposed into social posts* via
-- approve-blog. This table is the new "Blog" admin section: a post written
-- or pasted by Adrian (or seeded from the weekly AI draft) that gets
-- published directly to a brand's live website via the publish-blog-post
-- edge function (GitHub commit + Netlify deploy trigger).
--
-- Apply via `supabase db query --linked`, not `db push` (see migration 35's
-- history — the schema_migrations ledger has a pre-existing gap).
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.mkt_website_posts (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id           uuid NOT NULL REFERENCES public.mkt_clients(id) ON DELETE CASCADE,
  title               text NOT NULL,
  slug                text NOT NULL,
  body                text NOT NULL DEFAULT '',
  excerpt             text,
  featured_image_url  text,
  seo_keyword         text,
  status              text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published')),
  published_at        timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (client_id, slug)
);

ALTER TABLE public.mkt_website_posts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "mkt_website_posts_admin_all" ON public.mkt_website_posts;
CREATE POLICY "mkt_website_posts_admin_all" ON public.mkt_website_posts
  FOR ALL USING (public.mkt_is_admin()) WITH CHECK (public.mkt_is_admin());

-- Client portal users may only ever see their own brand's already-published
-- posts — drafts stay agency-side.
DROP POLICY IF EXISTS "mkt_website_posts_client_read" ON public.mkt_website_posts;
CREATE POLICY "mkt_website_posts_client_read" ON public.mkt_website_posts
  FOR SELECT USING (
    status = 'published'
    AND client_id IN (SELECT public.mkt_user_client_ids())
  );

CREATE INDEX IF NOT EXISTS mkt_website_posts_client_status
  ON public.mkt_website_posts (client_id, status, created_at DESC);
