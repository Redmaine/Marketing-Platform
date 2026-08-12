-- =============================================================================
-- Add 'publish_unverified' to mkt_blog_posts.status.
--
-- publish-approved-blog previously asserted status='published' the instant a
-- GitHub commit succeeded — it never checked whether the site actually
-- redeployed and the post became reachable. Investigated live (12 Aug 2026):
-- three of the six GITHUB_BRANDS sites (yca, ps, quill — the three static-
-- HTML sites, connected to Netlify via a deploy-key-only git integration with
-- no GitHub webhook, unlike the three markdown/React sites which use a real
-- Netlify GitHub App installation) never redeploy on push at all. Several
-- Quill and PS posts sat in the database as 'published' for days while 404ing
-- (Quill) or silently serving the homepage instead (PS, via Netlify's SPA
-- catch-all redirect masking what would otherwise be a 404) on the live site.
--
-- 'publish_unverified' is the honest third state this created: the GitHub
-- commit genuinely succeeded (so 'publish_failed' would be wrong — nothing
-- about the publish attempt itself failed) but the function could not confirm
-- within its poll budget that the resulting live_url actually serves this
-- post. Distinct from 'published' deliberately, so:
--   - ContentQueue's blog-dependent gating (`blog.status !== 'published'`)
--     correctly keeps treating it as not-yet-live and keeps dependent social
--     posts blocked, instead of releasing them against a page that isn't real.
--   - Blog.jsx's existing "needs attention" filter (`status !== 'published' &&
--     status !== 'rejected'`) already surfaces it with no UI-side filter
--     change needed — only the status badge/button labels needed updating.
--
-- Run in the Supabase SQL editor.
-- =============================================================================

ALTER TABLE public.mkt_blog_posts DROP CONSTRAINT mkt_blog_posts_status_check;

ALTER TABLE public.mkt_blog_posts
  ADD CONSTRAINT mkt_blog_posts_status_check
  CHECK (status = ANY (ARRAY['draft'::text, 'approved'::text, 'published'::text, 'publish_failed'::text, 'publish_unverified'::text, 'rejected'::text]));
