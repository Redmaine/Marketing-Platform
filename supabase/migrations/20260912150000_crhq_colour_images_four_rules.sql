-- CRHQ images: back on, in colour, with four rules enforced at review.
-- 12 Sep 2026, Adrian ("correct" to the investigation's question).
--
-- WHAT THE INVESTIGATION FOUND, so the reasoning is on the record:
--
--   * CRHQ image generation had been OFF on both platforms since 6 Sep
--     (image_gen_disabled_platforms = {facebook,instagram}; Craig was
--     supplying real photos via Drive — commit 9988987). No image had been
--     generated since 6 Sep 22:00. That is reversed below.
--   * The configured visual_style, the concept prompt, the medium directive
--     AND a post-generation image.saturation(0) all made the images BLACK
--     AND WHITE on purpose. Rule 1 ("colour only") was not being missed by
--     the prompt; the prompt said the opposite. The style text is rewritten
--     here; the code side is in _shared/image.ts.
--   * The headline overlay was WHITE (0xffffffff) — neither black nor the
--     yellow rule 2 asks for. Now 0xffd400ff.
--   * The review ran on the RAW frame, before the B&W treatment and the
--     banner were composited, so it could never have checked either. It now
--     measures colour from the raw pixels and checks the composite's banner
--     for yellow text before the image is attached.
--   * The concept prompt already forbade every vehicle, aircraft and ship;
--     it now forbids military hardware by name as well, and the reviewer
--     reports any that appears. Rule 4 is enforced as a PRESENCE ban, not
--     an age test — "does this tank read as pre-2006" is not a judgement a
--     vision model makes reliably enough to build a rule on. The model
--     still records apparent_era, for the log.
--
-- The visual_style below is the previous text with the medium changed from
-- Tri-X black and white to Portra colour, "saturated colour" removed from
-- the avoid list (it was the one thing rule 1 requires), monochrome added
-- to it, and military hardware added to the hard rules.

UPDATE public.mkt_clients
SET visual_style = 'Documentary reportage photography, in full natural colour. Shot on a Sony A7 IV with a 35mm f/2 lens, available light only, handheld, deep depth of field, slight motion blur where movement is implied. Rendered as Kodak Portra 400 pushed one stop: pronounced film grain, true-to-life colour that is neither garish nor muted into monochrome, deep shadows, highlights left blown rather than recovered, tonal range that rolls off gradually instead of clipping cleanly.

Texture and imperfection are the point — visible film grain across the entire frame, natural skin texture on any visible hands or forearms including pores and knuckle creases, individual fibres and visible weave in tactical fabric, webbing, canvas and wool, scuffed and worn equipment surfaces, dust, damp, sweat, chipped paint, fingerprints on metal, dirt in the seams. Nothing clean, nothing new, nothing evenly lit.

Vary the scene and setting for every image based on the actual story — do not default to the same repeated location or composition. Draw from a wide range of settings: coastal and maritime scenes, government and parliamentary buildings, outdoor and field settings, city streets, courtrooms, transport and infrastructure, or an interior only when it is genuinely the most fitting choice. A story about security, intelligence or threat topics does not automatically mean a control room, operations centre, or wall of monitors — actively choose a different setting unless the story is unambiguously about surveillance technology itself. The scene must be recognisably about the specific story the post tells, not generic defence imagery.

Absolutely no human faces of any kind, including in a crowd or at a distance — this is a hard rule, not a preference. Where a human presence is implied, show only silhouettes or figures seen from behind — never any part of a face, never eyes. Never depict or name any real public figure.

Absolutely no military hardware of any era — no tanks, armoured vehicles, artillery, missiles, warships, submarines, military aircraft, helicopters, drones, firearms or weapons, whether in service, historic, as a model or as a memorial. This is a hard rule.

Unmarked and unlettered: every surface is blank. No hull numbers, no registration plates, no unit markings, no stencilled codes, no signage, no painted lettering, no labels, no logos, no insignia, no flags, no digits of any kind anywhere in the frame. No real markings that could identify a specific real organisation, unit, vessel or person.

Avoid entirely: black and white, monochrome, sepia, desaturated or colour-graded-to-grey treatments; cartoon, illustration, drawing, painting, ink wash, sketch, 3D render, CGI, digital art, concept art, plastic or waxy skin, airbrushing, beauty retouching, smooth flawless surfaces.',
    image_gen_disabled_platforms = '{}'
WHERE slug = 'crhq';
