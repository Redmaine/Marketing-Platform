-- =============================================================================
-- 73_adrian_linkedin_no_images.sql
--
-- Personal LinkedIn posts for Adrian Fielding must never get an
-- AI-generated image — LinkedIn personal posts perform better without one
-- when the content is substantive.
--
-- mkt_clients has no column literally named image_required. The real
-- mechanism (_shared/image.ts's generatePostImage) is:
--   - image_gen_platforms      (migration 51) — a per-client ALLOW-list.
--     Empty/unset (this client's current state) means "no restriction" —
--     i.e. every platform gets an image by default. This is the "platform
--     currently attaches an image to all posts regardless of brand"
--     behaviour the brief describes, confirmed by reading the code before
--     writing this migration.
--   - image_gen_disabled_platforms (migration 44) — a per-client DENY-list,
--     checked after the allow-list. This is the correct column for "always
--     suppress this platform's images for this client" — it's exactly the
--     purpose it was built for, just normally written by the code itself
--     after a Stability failure rather than set up front by hand.
--
-- Setting the deny-list (not touching the allow-list, which must stay empty
-- so it keeps applying "no restriction" to every OTHER platform this client
-- might ever use) is the minimal, correct fix.
-- =============================================================================

update public.mkt_clients
set image_gen_disabled_platforms = array_append(image_gen_disabled_platforms, 'linkedin')
where slug = 'adrian-linkedin'
  and not ('linkedin' = any(image_gen_disabled_platforms));
