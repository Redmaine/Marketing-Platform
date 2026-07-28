-- 61_crhq_visual_style_coffee_and_fb_images.sql
--
-- Three CRHQ content changes. All are data-only updates to the single
-- mkt_clients row for slug 'crhq'; every statement is idempotent and scoped by
-- slug, so no other brand can be touched by a re-run.
--
-- 1. visual_style — the previous brief ("near black background, dramatic
--    cinematic lighting, ... high production value") was producing images that
--    read as obviously AI-generated: composited, studio-lit, over-polished.
--    Replaced with a documentary/photojournalism brief aimed at looking like a
--    real photograph. Note this string is also enforced verbatim at image time
--    by passesStylePrefixCheck (_shared/image.ts) — the prompt sent to
--    Stability must contain it exactly, so it must not be reformatted here.
--
-- 2. master_prompt — the prompt never mentioned the coffee side of the
--    business, so the shop at combatreadyhq.co.uk never appeared in content.
--    Appended rather than replaced, guarded so a re-run cannot duplicate it.
--
-- 3. image_gen_platforms — adds 'facebook'. This is the enabling change for
--    the alternating Facebook images added to crhq-nightly-content: the
--    allow-list in _shared/image.ts returns early for any platform not listed,
--    so the cadence logic in that function could never fire while this stayed
--    Instagram-only. Safe to widen because midnight-cron skips CRHQ entirely
--    (slug guard, see midnight-cron/index.ts) — crhq-nightly-content is the
--    only caller that generates CRHQ posts, and it decides per-post whether to
--    request an image. The allow-list now means "images are permitted here";
--    the every-other-post cadence lives in the function.

-- 1. Visual style — documentary, not cinematic.
UPDATE public.mkt_clients
SET visual_style = 'documentary photograph, black and white or desaturated colour, raw photojournalism style, military equipment or operations in natural environment, grain and texture, not AI-generated, no composite imagery, no studio lighting, no polished effects, no text overlays, Magnum Photos aesthetic, gritty and real'
WHERE slug = 'crhq';

-- 2. Coffee / shop content, appended to the existing master prompt.
UPDATE public.mkt_clients
SET master_prompt = master_prompt || E'\n\n' ||
  'COFFEE AND SHOP CONTENT: Approximately 1 in every 5 posts should reference the CRHQ shop at combatreadyhq.co.uk. The shop sells five premium military-themed coffee blends: Battle Brew, Covert Ops, In The Shadows, Combat Ready, and Op Decaf. Discount code YOUTUBE10 is active. Coffee content should feel like a natural extension of the CRHQ brand — tactical, considered, never jarring alongside serious news content. Never make coffee posts feel like generic product promotion. Frame them around the brand identity: serious people, serious coffee.'
WHERE slug = 'crhq'
  AND master_prompt IS NOT NULL
  AND master_prompt NOT LIKE '%COFFEE AND SHOP CONTENT%';

-- 3. Permit Facebook images (cadence is decided in crhq-nightly-content).
UPDATE public.mkt_clients
SET image_gen_platforms = ARRAY['instagram', 'facebook']::text[]
WHERE slug = 'crhq'
  AND NOT ('facebook' = ANY (COALESCE(image_gen_platforms, ARRAY[]::text[])));
