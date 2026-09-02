-- 101_crhq_blog_exclusion.sql
--
-- Quill manages CRHQ's Facebook and Instagram only. Blog was never in scope,
-- but three blog rows were generated on 1 July 2026 (CRHQ's setup day) before
-- scope was narrowed. This removes them and makes the exclusion permanent.
--
-- ── 1. NONE OF THE THREE WAS EVER LIVE. Verified three independent ways on
-- 2 Sep 2026 before deleting anything, because one row looked like it might be.
--
--   f4f3dff5 "The Fragmentation of Regional Security…"  status 'rejected',
--     published_at NULL, live_url NULL, reason "Dated geopolitical content,
--     no longer current". Never published.
--   b5aedd17 "UK Defence Spending 2024…"                status 'rejected',
--     published_at NULL, live_url NULL, reason "Dated, references 2024 in
--     title". Never published.
--   8a1b7abf "Coffee and Credibility: Why CRHQ's Military-Grade Blends…"
--     status 'publish_unverified', approved_at 29 Jul 16:51:50,
--     published_at 29 Jul 16:51:55, live_url NULL. THIS is the one that had
--     to be resolved rather than assumed — it references the coffee shop,
--     which is closed, so if it were live it needed raising with Craig.
--
--   Evidence it is not live:
--   (a) CODE. publish-approved-blog routes by client.slug. GITHUB_BRANDS is
--       {hormonely, neuro-decoded, ouay, riverside, yca, ps, quill}; Branch 2
--       is Steady alone. 'crhq' is in neither, so it falls to Branch 3 —
--       "No deploy target exists at all for the brands still here — nothing
--       is pushed anywhere". Branch 3 returns method:'manual' with an HTML
--       file to download by hand, sets published_at and status, and never
--       sets live_url. That is exactly the state observed, and it is why
--       published_at is set while live_url is NULL: not an inconsistency to
--       repair, but a faithful record of a manual handoff that was never
--       completed.
--   (b) LIVE SITE. https://combatreadyhq.co.uk/blog/coffee-and-credibility-
--       military-blends returns HTTP 200 — but so does every nonsense path on
--       that domain, byte-for-byte identically (36,423 bytes), because the
--       site serves an SPA catch-all. A 200 is therefore not evidence; the
--       body is. The served page contains ZERO occurrences of "Coffee and
--       Credibility", "Military-Grade" or the slug, and its <title> is the
--       site shell, "Combat Ready HQ — Intelligence. Analysis. Combat Ready."
--       (This is the same catch-all trap migration 98 documents for PS.)
--   (c) SITEMAP. https://combatreadyhq.co.uk/sitemap.xml lists exactly:
--       /, /news, /map, /shop, /about, /intelligence, two /news articles and
--       /news/author/craig. There is NO /blog section on the site at all, and
--       nothing matching blog/coffee/credibility.
--
--   Conclusion: nothing to raise with Craig. The coffee post never reached
--   his site. Deleting is safe and needs no client conversation.
--
--   Nothing referenced the three rows: 0 mkt_content_queue rows carry any of
--   their ids, and CRHQ has 0 queue rows with a blog_id, 0 with
--   review_status='blog_dependent' and 0 with platform='blog'.
--
--   NOT preserved by this migration: content_html (4,930 / 5,399 / 6,565
--   chars). Recoverable only from a Supabase point-in-time backup. Two were
--   already rejected as factually dated and the third promotes a closed
--   coffee shop, so none of it is reusable.
--
-- ── 2. WHY A COLUMN AND NOT ANOTHER HARDCODED SLUG.
-- An exclusion already existed, but only as a literal in ONE of the two
-- callers: generate-client-content:244 skipped ensureWeeklyBlog for
-- client.slug !== 'adrian-linkedin'. backfill-content calls the same helper
-- in a loop over every active client with no such check, so that "pattern"
-- was already one caller away from being bypassed. blog_enabled is checked
-- inside ensureWeeklyBlog itself — the single choke point both callers share
-- — so a future third caller inherits it instead of having to remember it.
-- adrian-linkedin is migrated onto the flag here so there is one mechanism,
-- not two.

-- 1. The flag. Default true: every existing brand keeps generating blogs.
ALTER TABLE public.mkt_clients
  ADD COLUMN IF NOT EXISTS blog_enabled boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN public.mkt_clients.blog_enabled IS
  'False = never generate blog posts for this brand. Enforced in _shared/blog.ts ensureWeeklyBlog(), and skips the blog-dependency gate in src/lib/blogDependency.js. For brands whose engagement is social-only or that have no website to publish to.';

-- 2. Turn it off for the two brands that must never get blogs.
--    crhq            — social-only engagement (Facebook + Instagram).
--    adrian-linkedin — a single personal LinkedIn profile, no website at all;
--                      previously enforced by the hardcoded slug check.
UPDATE public.mkt_clients SET blog_enabled = false
WHERE slug IN ('crhq', 'adrian-linkedin');

-- 3. Remove the three out-of-scope CRHQ blog rows (see the evidence above).
DELETE FROM public.mkt_blog_posts
WHERE client_id = 'c14ccad0-21f8-44f0-9464-24f321bea37b'::uuid;
