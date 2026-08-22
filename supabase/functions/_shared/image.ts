// Shared AI image generation for the content pipeline — called from fill.ts
// right after a post is queued, one image per post.
//
// Uses Stability AI's text-to-image REST API (stable-diffusion-xl-1024-v1-0),
// uploads the result to the mkt-assets storage bucket under a folder named
// after the brand's slug, and writes the public URL back onto the
// mkt_content_queue row.
//
// This never throws out to the caller — image generation is best-effort and
// must not block or fail the post it's attached to (see the file-level
// comment in fill.ts). Any failure — missing API key, a bad Stability
// response, a storage upload error — is logged and left as image_url = null
// (the column's default), which the approval queue UI reads as
// "Image missing — add manually".

import { callAnthropic, callAnthropicVision } from './generate.ts'
// Bug fix (13 Aug 2026) — every wasm/*.js loader inside imagescript@1.2.15
// (gif.js, and it turns out png.js/font.js/jpeg.js/svg.js/tiff.js/zlib.js
// too) fetches its .wasm binary from deno.land/x at module-top-level via a
// top-level `await` — meaning it runs the instant this file is imported,
// before any handler code (including this function's own try/catch) ever
// runs. That fetch started failing on Supabase's Edge Runtime with
// "TypeError: brotli error", an uncaught event-loop error that crashes the
// whole function with a bare 500 before a single log line of its own can be
// written — confirmed via crhq-nightly-content's real function_logs (missed
// the 12 Aug 22:00 run silently; reproduced on a manual trigger).
//
// Root cause, confirmed directly: deno.land's CDN serves every one of these
// .wasm assets with a `Content-Encoding: br` header, but the response BODY
// is already plain, uncompressed WASM (verified — every asset's raw bytes
// start with the `\0asm` magic number even when fetched with
// `Accept-Encoding: identity`). Any client that honours the (wrong) header
// and tries to brotli-decode already-plain bytes fails exactly like this —
// a CDN-side header/body mismatch, not a Deno version or code issue.
// (A version bump to 1.4.0 was tried first — it restructures gif.js to a
// native `import ... from './gif.wasm'`, which ALSO failed, as a 503
// BOOT_ERROR instead: Supabase pins Deno 1.46, and full native-WASM-import
// support only landed in Deno 2.1, so that path isn't viable here either.)
//
// Fix: vendor imagescript's full source + WASM tree locally instead of
// depending on deno.land/x's CDN. Not a rewrite — the library's own loaders
// already special-case this: `new URL(import.meta.url.replace('.js',
// '.wasm'))` resolves to a `file:` URL when the .js file itself was loaded
// from the local filesystem (as it now is, one deploy bundle), and every
// loader already does `'file:' === path.protocol ? Deno.readFile(path) :
// fetch(...)` — so importing the identical, unmodified source locally
// makes it take the Deno.readFile branch automatically, with zero code
// changes to imagescript itself. See _shared/vendor/imagescript/README.md.
import { Image } from './vendor/imagescript/mod.ts'

// deno-lint-ignore no-explicit-any
type Admin = any

// imagescript 1.2.15 has no separate Font class — Image.renderText() takes
// raw TTF bytes directly. Anton is a bold condensed display face, well
// suited to a short punchy headline overlay at thumbnail size. Fetched once
// per cold start and reused — see headlineFontBytes() below.
const HEADLINE_FONT_URL = 'https://raw.githubusercontent.com/google/fonts/main/ofl/anton/Anton-Regular.ttf'
let cachedHeadlineFont: Uint8Array | null = null

const STABILITY_ENGINE_ID = 'stable-diffusion-xl-1024-v1-0'
const IMAGE_SIZE = 1024

// Stability's SDXL v1 API only accepts a fixed set of width/height pairs (all
// multiples of 64) — 1080 is not one of them and would be rejected outright,
// so generation always happens at the model's native square size (1024) and
// gets resized afterwards for platforms with their own exact requirement.
const INSTAGRAM_SIZE = 1080

// A no-text instruction was already present here ("no text, no words, no
// letters, no logos") but didn't match the exact phrasing every image call
// must now use, regardless of brand — Stability cannot render readable text
// at all, so this always applies, not just when a client's own visual_style
// happens to mention it.
//
// STILL USED BY EVERY NON-CRHQ (Stability) CLIENT — they are not failing and
// are deliberately untouched. CRHQ no longer ends its prompt with this; see
// CRHQ_SURFACE_CLOSER for why.
const NO_TEXT_INSTRUCTION = 'no text, no words, no letters, no typography, no labels'

// TODO: Manual photography upload for CRHQ
// Craig supplies real photography that takes priority over
// AI-generated images. Needs: upload UI, 4:5 crop, storage path,
// and override flag on mkt_content_queue. Not yet implemented.
// Until then every CRHQ post gets an AI-generated image from
// the brand's visual_style brief below.

// Turns the raw post copy into a short, concrete visual scene description —
// what an image generator should actually draw, not the marketing copy
// itself. Previously the prompt was built by blindly truncating postBody to
// 220 characters and handing that straight to Stability: a hook, a stat, a
// call-to-action read as ad copy, not a scene, and produced correspondingly
// generic/literal images. This asks Claude (already used elsewhere in this
// pipeline — see generate.ts) for one or two sentences describing a single
// concrete visual concept instead. Falls back to the old truncation on any
// failure — a slightly worse prompt must never be the reason an image (or
// the post it belongs to) doesn't go out; see the file-level comment.
const DEFAULT_CONCEPT_SYSTEM = 'You turn a social media post into a short, concrete visual scene description for an AI image generator. Describe ONE clear subject, setting, composition and mood that captures what the post is about. Never describe any text, quotes, numbers or words that should appear in the image — the image itself must never contain readable text. Reply with only the scene description, one or two sentences, no preamble, no quotation marks.'

// ── Brand rules at concept time (22 Aug 2026) ───────────────────────────────
// Root cause of a real, measured 7/7 Quill failure rate: until now the
// concept step could not see the client's visual_style at all. buildImagePrompt
// assembled [concept, style, NO_TEXT_INSTRUCTION], so a brand rule like
// Quill's "absolutely no depicted human figures of any kind" only ever reached
// the diffusion model AFTER ~60 words vividly describing a person — a direct
// contradiction inside one prompt. Six of the seven real concepts logged on
// 22 Aug opened with "A person…", "A stressed business owner…", "A dedicated
// analyst…"; all three of Quill's historical "successes" (generated before the
// compliance gate existed) contain a clearly rendered person when viewed.
//
// This is exactly the failure CRHQ_CONCEPT_SYSTEM below was written to solve
// on 2026-08-08/09 — see its own comment, which already records that the
// default concept prompt "kept producing person-centric concepts … which a
// visual_style rule + a Stability negative prompt downstream weren't" able to
// stop. That fix was hardcoded to one brand. This generalises it: every
// client's own visual_style is now stated to the concept model as a hard
// constraint before it writes anything, and a brand with a blanket no-people
// rule additionally gets the explicit people instruction that made CRHQ work.
// CRHQ itself is untouched and still uses its own bespoke system prompt.

// Blanket "no people" rules in a client's own visual_style. Deliberately does
// NOT match Once Upon A You's "no specific children" — that brand is
// illustrated children's books, where people are the point and only
// identifiable real children are barred. Verified against all 8 non-CRHQ
// visual_style values live: matches exactly the six that carry a blanket rule
// (hormonely, ps, quill, quill-linkedin, riverside, yca) and neither ouay,
// neuro-decoded nor steady.
const STYLE_FORBIDS_PEOPLE =
  /\bno\s+(?:illustrated\s+|depicted\s+)?(?:people|persons?|humans?)\b|\bno\s+(?:illustrated\s+|depicted\s+|ai-generated\s+)?(?:human\s+)?figures?\b|\bfaces\s+or\s+figures\b/i

export function styleForbidsPeople(visualStyle: string | null): boolean {
  return STYLE_FORBIDS_PEOPLE.test(String(visualStyle || ''))
}

// Generalisation of CRHQ_CONCEPT_SYSTEM's STEP 5, which is the part that
// demonstrably works. The final sentence is the load-bearing one: every real
// failure came from a post about what a person does or feels, where the
// concept model reached for the person rather than the thing.
const NO_PEOPLE_CONCEPT_RULE = 'This brand forbids people entirely. Describe a scene with NO people in it: no person, no figure, no silhouette, no hands, no arms, no part of a body — not even distant, blurred, out of focus, cropped, or seen from behind. Empty is the default and is almost always the right answer. If the post is about what someone does, feels, decides or experiences, describe the objects, place, materials, structures or abstract forms involved instead of the person doing it.'

// Concept words that mean a person is in the frame. Grounded in the six real
// person-centric concepts logged on 22 Aug (tradesperson, person, owner x2,
// analyst, hands) rather than invented. Deliberately EXCLUDES words that read
// as people but legitimately appear in compliant abstract concepts —
// "professional" ("soft, professional lighting" appeared in a real concept),
// "figure(s)" (a data-visualisation brand means numbers), "client(s)" ("client
// dashboard"), "team", "face" ("rock face") — because a false positive here
// costs three wasted model calls and degrades a good post-specific concept to
// the generic fallback. The downstream compliance gate remains the backstop
// for anything this misses.
const CONCEPT_PEOPLE_SUBJECTS =
  /\b(?:persons?|people|someone|somebody|humans?|man|men|woman|women|silhouette|portrait|workers?|tradespersons?|tradespeople|craftsm[ae]n|owners?|analysts?|employees?|founders?|entrepreneurs?|child|children|boy|girl|shoulders?|arms?)\b|\bhands?\b(?!-)/i

// The matched word when a concept puts a person in frame, else null.
export function conceptMentionsPerson(concept: string): string | null {
  const found = CONCEPT_PEOPLE_SUBJECTS.exec(String(concept || ''))
  return found ? found[0] : null
}

// Brand-neutral, structurally person-free and text-free last resort, for when
// the concept model cannot produce a people-free scene. Same role
// CRHQ_CONCEPT_FALLBACK plays for CRHQ: strictly better than letting a
// person-centric concept through, and far better than the old non-CRHQ
// fallback of `body.slice(0, 220)`, which pasted raw marketing copy (URLs and
// all) into the image prompt. Stays deliberately abstract because it is
// combined with the brand's own visual_style in the final prompt anyway.
const NO_PEOPLE_CONCEPT_FALLBACK = 'An abstract composition of overlapping geometric planes and clean flat shapes, arranged with generous negative space under even, diffuse lighting'

// The concept-stage system prompt for a given client: CRHQ keeps its bespoke
// one, every other client now gets the default plus its own real brand rules,
// plus the explicit people instruction when its visual_style carries a
// blanket no-people rule.
export function conceptSystemFor(client: Record<string, any> | undefined, visualStyle: string | null): string {
  if (wantsHeadlineOverlay(client ?? {})) return CRHQ_CONCEPT_SYSTEM
  const style = String(visualStyle || '').trim()
  if (!style) return DEFAULT_CONCEPT_SYSTEM
  const rules = `${DEFAULT_CONCEPT_SYSTEM}\n\nBRAND VISUAL RULES — the scene you describe must obey these. They are not optional and they override anything the post copy suggests:\n${style}`
  return styleForbidsPeople(style) ? `${rules}\n\nPEOPLE — ${NO_PEOPLE_CONCEPT_RULE}` : rules
}

// CRHQ-specific concept system prompt — added after two rounds of test
// samples (2026-08-08/09) showed the default concept prompt above kept
// producing person-centric concepts ("a man reading a document," "officials
// in a briefing") that put a face in frame almost by construction, which a
// visual_style rule + a Stability negative prompt downstream weren't
// reliably able to override. This attacks the root cause instead: steer the
// CONCEPT itself away from portraiture, not just the finishing style.
// Updated 16 Aug 2026 alongside the move to photoreal Tri-X documentary
// styling: this previously specified "editorial ink-wash illustration —
// never photorealistic", which would now actively fight the visual_style it
// gets concatenated with. The anti-portraiture and anti-text steering is
// unchanged and still doing the same job — it is the aesthetic half that
// flipped, not the safety half.
//
// The added "unmarked surfaces" clause is new: with Flux there is no negative
// prompt to lean on, and rendered hull numbers were the single most common
// review rejection, so the concept itself now avoids proposing scenes built
// around markable surfaces in the first place.
//
// REWRITTEN 21 Aug 2026 after the 19/20 Aug exhaustions (both posts shipped
// with no image at all — image_review_events, eee743fc… and 701fd49c…). The
// previous version's two clauses each failed for a specific, reproducible
// reason, both confirmed by re-running it live against those same two real
// post bodies:
//
//   1. It offered a MENU of settings ("coastal and maritime, government or
//      parliamentary buildings, outdoor and field locations, CITY STREETS,
//      courtrooms, transport and infrastructure"). The model picked a menu
//      item rather than describing the actual story — which is Defect 2
//      (irrelevance) and Defect 1 (text) at the same time, because the menu's
//      own entries are signage-dense settings. Re-run live on the 20 Aug
//      Birmingham public-order post it produced "a wide street in a major
//      city centre… Victorian and modern buildings lining both sides, traffic
//      lights and street infrastructure" — a shopfront-lined street, which is
//      exactly the scene that rendered "POLICE", "PUBS", "S LOAN" and
//      "POLLO A LA BRASA" three attempts running.
//   2. Its text clause banned MENTIONING lettering ("never mention hull
//      numbers, registrations, signage, badges, insignia or any lettering")
//      but never banned choosing an object whose entire function is to carry
//      lettering. Re-run live on the SAS-warning post it produced "a briefing
//      room with maps, threat assessment charts… a wall of security
//      infrastructure diagrams" — nothing "mentions" lettering, yet a map and
//      a chart cannot be rendered without glyphs, which is where "TACTICAL
//      ZONES", "BATTICAL ZONES", "T50" and "T40" came from.
//
// So the fix is at the object-class level, not the wording level: name the
// specific story, then build the frame out of things that carry no writing.
//
// Note WHERE the prohibitions live. This system prompt is read by Claude, an
// instruction-following text model that handles "do not use X" correctly.
// Flux is a diffusion model with no negative channel, and only ever sees
// Claude's OUTPUT — which, by construction, contains none of these nouns. The
// negation happens in the one place negation actually works.
const CRHQ_CONCEPT_SYSTEM = 'You turn a social media post into a short, concrete visual scene description for an AI image generator that will render it as a black-and-white documentary reportage photograph.\n\nSTEP 1 — SUBJECT. Work out the ONE specific thing this post is about: the particular event, place, decision or consequence, not the broad subject area. If the post is about what somebody said, warned, analysed or reported, do NOT depict the act of speaking, briefing, meeting or analysing — depict the real-world thing they were talking about. Your scene must be recognisably about that specific thing, so a reader of the post sees the connection immediately: name the concrete particulars, the actual kind of place, the time of day, the weather, the physical aftermath or evidence. A scene that could sit above any other post about security, defence or threat is a failure, however well composed.\n\nSTEP 2 — MATERIALS. Build the frame out of place, ground, weather, light, architecture and raw material: concrete, brick, tarmac, steel, glass, stone, earth, water, timber, plain cloth.\n\nSTEP 3 — FORBIDDEN OBJECTS. Every object below exists to be read, and the image generator WILL render writing on it. None may appear in your scene — not in the background, not in passing, and not even when you describe it as blank, unmarked, empty or bare:\n- shops, shopfronts, storefronts, shutters, retail frontages, high streets, pubs, cafes, any commercial premises\n- screens, monitors, displays, projections, dashboards, instruments\n- maps, charts, diagrams, plans, documents, papers, files, folders, notebooks, books\n- cars, vans, lorries, trains, aircraft, ships, boats, any vehicle\n- banners, flags, posters, road signs, plaques, noticeboards, hoardings\n- uniforms, badges, insignia, packaging, boxes, crates\n- offices, briefing rooms, control rooms, operations centres, meeting rooms, newsrooms\n\nSTEP 4 — FRAMING. State the framing explicitly, and make it a framing that keeps the STEP 3 objects out of shot: close in on the subject rather than a wide establishing view, low or high angle, at ground level, into weather or darkness, or one architectural or material detail standing for the whole. Never a wide view down a street or across a townscape — that framing fills the distance with the very objects STEP 3 forbids.\n\nSTEP 5 — PEOPLE. Describe a scene with NO people in it. Empty is the default and almost always the right answer. Only if a human presence is genuinely essential to the story may you include ONE distant figure seen from behind, small in the frame — never a face, never an expression, never a group or a crowd. Never describe any text, quotes, numbers or words that should appear in the image.\n\nSTEP 6 — CHECK. Before you reply, re-read your sentence against the STEP 3 list word by word. If any forbidden object appears, rewrite the scene without it.\n\nReply with only the scene description, one or two sentences, no preamble, no quotation marks.'

// CRHQ prompt scaffolding for Flux (2026-08-20).
//
// WHY THIS EXISTS. CRHQ is the only client on Flux (usesFluxProvider), and
// this integration sends Flux no negative prompt. Stability's own
// negative-prompt mechanism (callStabilityAI's negativePrompt param, weight
// -1) is real and still there for whichever client actually uses it — CRHQ
// just never reaches that branch, so the CRHQ-specific negative prompt that
// used to sit on it was pure dead code, removed 20 Aug 2026 (it also named
// "photorealistic, photograph, real photo", stale terms from the pre-16-Aug
// ink-wash era and by then the opposite of what CRHQ wanted). That leaves
// every prohibition in CRHQ's visual_style expressed as prose to a purely
// positive-conditioning model.
//
// Two consequences drove the 18 Aug 2026 failures:
//   1. The medium spec (Tri-X, grain, handheld) sat in the MIDDLE of a
//      ~2,300-character prompt, after the scene concept. Diffusion models
//      weight early tokens most, so "what the picture is of" outranked "what
//      kind of photograph it is" — and the model resolved the ambiguity as a
//      clean CGI render.
//   2. The "Avoid entirely:" list ends the prompt naming cartoon, 3D render,
//      CGI, digital art, concept art. Naming a style is how you ask for it;
//      with no negative channel those tokens are conditioning INPUT, which is
//      the classic "don't think of an elephant" failure.
//
// The visual_style text itself is left byte-for-byte untouched — it is the
// spec the compliance checker judges against, and passesStylePrefixCheck
// requires it verbatim and contiguous in the prompt. So instead of rewriting
// it, this brackets it: the medium is asserted FIRST (primacy) and the
// photographic requirements restated LAST in positive form (recency), so the
// banned-style nouns are no longer the final thing the model reads.
//
// Deliberately names nothing it does not want. Every clause states what the
// image IS, never what it must not be.
const CRHQ_MEDIUM_DIRECTIVE = 'A real black-and-white 35mm documentary reportage photograph, shot on Kodak Tri-X 400 film pushed one stop and scanned from the negative. Coarse silver-halide grain is plainly visible across the whole frame, including in flat areas of sky, wall and shadow. Available light only, handheld, slightly imperfect framing, deep true blacks and blown-out highlights. Every surface is physical and worn — scuffed, dusty, damp, fingerprinted, unevenly lit'

const CRHQ_STYLE_REINFORCEMENT = 'Above all this must read as a real photograph made on real film: heavy visible grain everywhere, genuine surface texture, uneven natural light, and the small optical imperfections of a handheld 35mm frame. Every surface in shot is blank, plain and unlettered'

// What CRHQ's prompt ends on, replacing NO_TEXT_INSTRUCTION in that slot
// (21 Aug 2026). Non-CRHQ clients keep NO_TEXT_INSTRUCTION unchanged — they
// are on Stability, which has a real negative channel, and none of them are
// failing this way.
//
// The 20 Aug fix (commit 8294c59) established the principle for this file
// already: with no negative channel, naming a thing is how you ask for it, so
// the banned-STYLE nouns were moved off the end of the prompt and replaced
// with a positive restatement. The banned-TEXT nouns were left behind — CRHQ's
// prompt still ended on "no text, no words, no letters, no typography, no
// labels", five glyph nouns in the highest-weighted recency slot, immediately
// after visual_style's own unavoidable "no signage, no painted lettering, no
// labels, no logos…" block. After that fix the style rejections stopped and
// every one of the next six attempts was rejected for TEXT instead.
//
// visual_style is the compliance spec and passesStylePrefixCheck needs it
// verbatim, so its glyph nouns cannot be removed — but they no longer have to
// be the last thing Flux reads. This states what the surfaces ARE. It names
// no glyph noun at all, and it reinforces the framing the concept was built
// with (see CRHQ_CONCEPT_SYSTEM) rather than fighting it.
const CRHQ_SURFACE_CLOSER = 'Every surface in frame is bare, continuous material — raw concrete, weathered brick, wet tarmac, bare steel, plain cloth, stone, earth, glass, water — filling the frame as texture, tone and shadow, photographed close enough that material and light are the whole subject'

// Turns a style-checker violation into a POSITIVE corrective instruction.
//
// The retry previously pasted the checker's own prose straight back into the
// prompt: "the previous attempt broke this brand's visual rules — This image
// is a 3D render or CGI...". With no negative-prompt channel on Flux, that
// fed the exact tokens "3D render", "CGI" and "control room" back in as
// conditioning — so the escalation could make the next attempt worse than the
// one it was correcting. Real example, 18 Aug 2026: the rejection naming a
// "control room or security operations centre with a wall of monitors" would
// have been echoed verbatim into the regeneration prompt.
//
// This maps the violation to what the image should BE instead, and never
// repeats the offending noun.
function styleCorrectionFor(violation: string | null): string {
  const v = String(violation ?? '').toLowerCase()

  if (/3d|cgi|render|digital art|concept art|illustration|cartoon|drawing|painting|sketch|smooth|flawless|airbrush|plastic|waxy/.test(v)) {
    return 'The previous frame was too clean and too perfect to read as a photograph. Make it unmistakably a scanned film negative: coarse silver-halide grain over the entire image including flat areas, visible dust and surface wear, uneven available light, slight handheld softness, and blown highlights that are not recovered.'
  }
  if (/control room|operations centre|operations center|monitor|screen|console|surveillance|command centre|command center/.test(v)) {
    return 'Set this somewhere else entirely — outdoors or in a public civic space. Choose a coastal or maritime location, a street, a field or open ground, a transport or infrastructure setting, or the exterior of a public building. No interior filled with equipment or displays.'
  }
  if (/face|portrait|eyes|person|figure|people|crowd/.test(v)) {
    return 'Remove people from the frame entirely. Build the photograph around objects, architecture, landscape or weather instead. If any human presence is unavoidable it must be a distant silhouette seen from behind, no larger than a small part of the frame.'
  }
  if (/text|letter|number|marking|sign|logo|insignia|registration|hull|digit|stencil/.test(v)) {
    // Same reasoning as REVIEW_ESCALATION.text — this is positive
    // conditioning on Flux, so it names bare materials rather than the
    // markings it is correcting.
    return 'Move the camera in close and fill the frame with bare physical material — raw concrete, weathered brick, wet tarmac, bare steel, plain cloth, stone, earth. Material, texture, shadow and light are the entire subject of this photograph.'
  }
  if (/colour|color|saturat/.test(v)) {
    return 'Pure black and white only, with a full tonal range from deep true blacks to blown highlights. No colour cast of any kind.'
  }
  return 'Make this unmistakably a real black-and-white documentary photograph on pushed Tri-X film: heavy visible grain, worn physical surfaces, uneven available light, handheld imperfection.'
}

// `sourceTitle` is the real story the post was written from — CRHQ's
// primarySourceForPlatform picks one scraped video/article per post and
// crhq-nightly-content already steers the COPY with it (prompts.ts: "This
// specific post must be built primarily around this video: …"). It was never
// passed on to the image, which is a large part of Defect 2: published copy
// is a lossy summary of the story, and on Instagram it is barely a summary at
// all. The 19 Aug Instagram post's entire body was "Nuclear strike risk to UK
// is a live operational concern. We've analysed the threat level and what it
// means. Watch now at youtube.com/watch?v=…" — two lines and a URL, from
// which the concept model produced a generic "stark institutional corridor in
// a government defence facility". The video it was written about was titled
// "WILL They ATTACK UK with a NUCLEAR STRIKE" (crhq_scrape_cache, 19 Aug),
// and that title never reached the image at all.
// Deterministic guard on what the concept model returns, for CRHQ only. Same
// principle the rest of this file already runs on: prose rules are advisory,
// a fixed check is what enforces them.
//
// It is needed because prose alone measurably is not enough. Re-running the
// rewritten CRHQ_CONCEPT_SYSTEM twice on the same real 20 Aug Birmingham post
// gave one clean scene and one containing "boarded-up storefronts" and
// "emergency vehicle lights" — with the forbidden-object list right there in
// the system prompt. One sample in three is not a fix; every generation has to
// clear the bar, so the check has to be code.
//
// Every entry here is an object whose PURPOSE is to carry writing (or a
// setting made of them). Rejecting the concept and asking again is cheap — one
// short text call — and happens long before any image is paid for.
const CONCEPT_BANNED_SUBJECTS =
  /\b(shops?|shopfronts?|storefronts?|store fronts?|shutters?|retail|high street|pubs?|caf[eé]s?|restaurants?|screens?|monitors?|displays?|projections?|dashboards?|maps?|charts?|diagrams?|blueprints?|documents?|papers?|paperwork|files?|folders?|notebooks?|books?|newspapers?|cars?|vans?|lorr(?:y|ies)|trucks?|buses|trains?|aircraft|aeroplanes?|helicopters?|ships?|boats?|vessels?|vehicles?|ambulances?|banners?|flags?|posters?|signs?|signage|signposts?|plaques?|noticeboards?|hoardings?|billboards?|uniforms?|badges?|insignia|packaging|boxes|crates?|offices?|briefing rooms?|control rooms?|operations cent(?:re|er)s?|newsrooms?|number plates?|licen[cs]e plates?|labels?|lettering|inscriptions?|graffiti)\b/i

// The rewritten system prompt insists the scene be specific to THIS story and
// refuses genericness. On a post that is purely "someone said something" —
// e.g. the real 18 Aug SAS post, whose entire body is a warning being
// described — that pressure made the model decline outright and return a
// paragraph of explanation instead of a scene. Unguarded, that paragraph
// becomes the image prompt.
const CONCEPT_REFUSAL = /^(i (can'?t|cannot|am unable|will not|won'?t)|i'?m (sorry|unable|not able)|unfortunately|to work with|there is no)/i

// Last resort when the model cannot produce a usable scene. Deliberately a
// real, on-brand, structurally text-free frame rather than the previous
// fallback of `body.slice(0, 220)` — which pasted the raw post copy into the
// image prompt, URL and all. The 19 Aug Instagram post's copy ends
// "Watch now at youtube.com/watch?v=x0TIu0RZmkM"; handing that to a
// text-to-image model as its scene description is asking for rendered
// lettering, in the one code path meant to be the safe one.
const CRHQ_CONCEPT_FALLBACK = 'Rain-soaked concrete and weathered brick at ground level in flat grey British daylight, water standing in the cracks and the wall filling the frame'

const CONCEPT_MAX_ATTEMPTS = 3

// Returns the reason a concept is unusable, or null if it is fine.
function conceptProblem(concept: string): string | null {
  const c = concept.trim()
  if (!c) return 'empty'
  if (CONCEPT_REFUSAL.test(c)) return 'the model declined to describe a scene'
  // A scene description is one or two sentences. Anything much longer is
  // commentary, an explanation, or the post copy echoed back.
  if (c.length > 500) return 'not a scene description (too long)'
  const banned = CONCEPT_BANNED_SUBJECTS.exec(c)
  if (banned) return `contains "${banned[0]}"`
  return null
}

// `sourceTitle` is the real story the post was written from — CRHQ's
// primarySourceForPlatform picks one scraped video/article per post and
// crhq-nightly-content already steers the COPY with it (prompts.ts: "This
// specific post must be built primarily around this video: …"). It was never
// passed on to the image, which is a large part of Defect 2: published copy
// is a lossy summary of the story, and on Instagram it is barely a summary at
// all. The 19 Aug Instagram post's entire body was "Nuclear strike risk to UK
// is a live operational concern. We've analysed the threat level and what it
// means. Watch now at youtube.com/watch?v=…" — two lines and a URL, from
// which the concept model produced a generic "stark institutional corridor in
// a government defence facility". The video it was written about was titled
// "WILL They ATTACK UK with a NUCLEAR STRIKE" (crhq_scrape_cache, 19 Aug),
// and that title never reached the image at all. With it passed through, the
// same post now yields "a concrete bunker entrance set into a hillside, its
// heavy blast doors sealed shut" — about that story, and made of materials
// that cannot carry writing.
//
// `validate` is CRHQ-only (its own banned-subject list). `requireNoPeople` is
// the generalised equivalent for every other brand whose visual_style carries
// a blanket no-people rule: same retry-with-a-named-reason shape, checking the
// one thing that actually failed 6 of 7 times on 22 Aug. A client with
// neither flag keeps the original single-call-and-take-it behaviour exactly.
export async function summariseToVisualConcept(
  postBody: string,
  systemPrompt: string = DEFAULT_CONCEPT_SYSTEM,
  sourceTitle?: string | null,
  validate = false,
  requireNoPeople = false,
): Promise<string> {
  const body = String(postBody || '').replace(/\s+/g, ' ').trim()
  if (!body) return ''
  const source = String(sourceTitle ?? '').replace(/\s+/g, ' ').trim()
  const base = source
    ? `Post:\n${body.slice(0, 1000)}\n\nThe post was written about this specific story: "${source.slice(0, 300)}". The scene must be about that story in particular.`
    : `Post:\n${body.slice(0, 1000)}`

  // Falling back to raw post copy is right for an unconstrained brand, but for
  // a no-people brand it is the exact disaster this function now exists to
  // prevent — marketing copy about a business owner reliably produces a
  // business owner.
  const fallback = () => (requireNoPeople ? NO_PEOPLE_CONCEPT_FALLBACK : body.slice(0, 220))
  const retrying = validate || requireNoPeople

  let correction = ''
  for (let attempt = 1; attempt <= (retrying ? CONCEPT_MAX_ATTEMPTS : 1); attempt++) {
    try {
      const raw = await callAnthropic(systemPrompt, base + correction, 150)
      const concept = raw.replace(/\s+/g, ' ').trim()
      if (!retrying) return concept || body.slice(0, 220)

      if (validate) {
        const problem = conceptProblem(concept)
        if (!problem) return concept

        console.error(`[image] concept attempt ${attempt} unusable — ${problem}`)
        // Named explicitly. This correction is read by Claude, which handles
        // "do not use X" correctly — it never reaches the diffusion model.
        correction = `\n\nYour previous answer was rejected because it ${problem}. Reply with ONLY a scene description — one or two sentences, no explanation, no refusal — about this same specific story, built only from place, ground, weather, light, architecture and raw material, and containing none of the STEP 3 forbidden objects. If the post is about what someone said, describe the real-world thing they were talking about.`
        continue
      }

      // requireNoPeople
      if (!concept) {
        console.error(`[image] concept attempt ${attempt} came back empty`)
        correction = '\n\nYour previous answer was empty. Reply with ONLY a scene description, one or two sentences.'
        continue
      }
      const person = conceptMentionsPerson(concept)
      if (!person) return concept

      console.error(`[image] concept attempt ${attempt} describes a person ("${person}") for a no-people brand — retrying`)
      correction = `\n\nYour previous answer was rejected because it put a person in the frame (it mentioned "${person}"). ${NO_PEOPLE_CONCEPT_RULE} Reply with ONLY a scene description, one or two sentences, no explanation, describing the same subject with no person present at all.`
    } catch (e) {
      console.error(`[image] visual-concept summary failed on attempt ${attempt} — ${String((e as Error)?.message ?? e)}`)
      if (!retrying) return body.slice(0, 220)
      if (attempt === CONCEPT_MAX_ATTEMPTS) return fallback()
    }
  }

  // Never the raw post body for CRHQ (CRHQ_CONCEPT_FALLBACK) or for a
  // no-people brand (NO_PEOPLE_CONCEPT_FALLBACK) — in both cases the raw copy
  // is the thing that produces the banned image in the first place.
  console.error('[image] concept model produced no usable scene — using the text-free fallback frame')
  return validate ? CRHQ_CONCEPT_FALLBACK : fallback()
}

// Post copy (summarised into a visual concept, not passed through raw) +
// brand visual style, both folded into one prompt. CRHQ gets its own concept
// system prompt (see CRHQ_CONCEPT_SYSTEM) and its own closing line (see
// CRHQ_SURFACE_CLOSER) — every other client is completely unaffected and
// still ends on NO_TEXT_INSTRUCTION.
//
// Returns the concept alongside the prompt so it can be logged against every
// review attempt. Until now nothing anywhere persisted what the image was
// actually asked to depict, so "is the image about the post?" could not be
// answered from the data at all — only re-derived by re-running the model.
export async function buildImagePrompt(
  postBody: string,
  visualStyle: string | null,
  client?: Record<string, any>,
  sourceTitle?: string | null,
): Promise<{ prompt: string; concept: string }> {
  const isCrhq = wantsHeadlineOverlay(client ?? {})
  // Was `isCrhq ? CRHQ_CONCEPT_SYSTEM : DEFAULT_CONCEPT_SYSTEM` — the
  // non-CRHQ branch could not see visualStyle at all, which is the root cause
  // fixed on 22 Aug (see conceptSystemFor and the notes above it).
  const conceptSystem = conceptSystemFor(client, visualStyle)
  const noPeople = !isCrhq && styleForbidsPeople(visualStyle)
  const concept = await summariseToVisualConcept(postBody, conceptSystem, sourceTitle, isCrhq, noPeople)
  const style = String(visualStyle || '').trim()
  // CRHQ brackets the brand style with a medium directive first and a
  // positive restatement last — see CRHQ_MEDIUM_DIRECTIVE. `style` stays
  // verbatim and contiguous so passesStylePrefixCheck still holds. Every
  // other client is completely unaffected.
  const parts = isCrhq
    ? [CRHQ_MEDIUM_DIRECTIVE, concept, style, CRHQ_STYLE_REINFORCEMENT, CRHQ_SURFACE_CLOSER]
    : [concept, style, NO_TEXT_INSTRUCTION]
  return { prompt: parts.filter(Boolean).join('. '), concept }
}

// Instagram requires exact 1080x1080 square images. Stability only generates
// at its own supported square size (1024), so this resizes that output up to
// 1080x1080 before upload — every other platform is returned unchanged.
// Best-effort: a resize failure logs and falls back to the original 1024x1024
// image (still square, still valid) rather than losing the image entirely.
async function resizeForPlatform(bytes: Uint8Array, platform: string): Promise<Uint8Array> {
  if (platform !== 'instagram') return bytes
  try {
    const img = await Image.decode(bytes)
    img.resize(INSTAGRAM_SIZE, INSTAGRAM_SIZE)
    return await img.encode()
  } catch (e) {
    console.error(`[image] resize to ${INSTAGRAM_SIZE}x${INSTAGRAM_SIZE} failed, using original ${IMAGE_SIZE}x${IMAGE_SIZE} — ${String((e as Error)?.message ?? e)}`)
    return bytes
  }
}

// Which clients get the forced-B&W + headline-banner treatment applied to
// every generated image, on top of whatever their visual_style prompt says.
// CRHQ only for now (2026-08 image-style overhaul) — deliberately a slug
// check here rather than a new mkt_clients column, matching the existing
// `client?.slug !== 'crhq'` pattern already used for Facebook image
// attachment in schedule-to-metricool/index.ts. Revisit as a proper column
// if a second client wants this.
function wantsHeadlineOverlay(client: Record<string, any>): boolean {
  return client?.slug === 'crhq'
}

// Quill's two alternating-image streams: the dedicated LinkedIn company-page
// client (mkt_clients.slug = 'quill-linkedin', metricool_brand_id 6469945,
// every post is LinkedIn so no platform check needed), and — since 2026-08-10
// (Facebook/LinkedIn 50/50 image test, with vs without AI artwork) — the main
// Quill client's own Facebook stream (slug = 'quill', platform = 'facebook'
// only; its Instagram/other posts are untouched by this). Deliberately slug
// checks here rather than a new mkt_clients column, same reasoning as
// wantsHeadlineOverlay above. Revisit as a proper column if a third stream
// wants alternating images.
export function isQuillAlternatingStream(client: Record<string, any>, platform: string): boolean {
  if (client?.slug === 'quill-linkedin') return true
  return client?.slug === 'quill' && platform === 'facebook'
}

// Post-by-post image alternation for the two streams above — odd-numbered
// posts in the schedule get an image, even-numbered don't. Same
// self-correcting pattern as CRHQ's facebookWantsImage
// (crhq-nightly-content/index.ts): look at the most recently scheduled post
// for this client ON THIS PLATFORM and do the opposite of whether IT had an
// image, rather than tracking parity state in memory — this self-corrects
// after any gap (a deleted post, a manual override) and needs no counter
// column. No prior post at all -> true, so the very first post starts the
// cycle with an image (post 1 = odd = image).
//
// Scoped by platform (not just client_id) so Quill's Facebook and Instagram
// streams alternate independently rather than one platform's posts silently
// affecting the other's cycle — quill-linkedin's own posts are all LinkedIn
// anyway, so this is a no-op filter for that stream, not a behaviour change.
//
// Rejected posts are excluded because they never reach the platform, so they
// cannot be half of a 50/50 split of what people actually saw. Counting one
// inverts the toggle for the next real post — and rejections cluster on
// image posts, so the error is not evenly distributed.
//
// BATCHING FIX (22 Aug 2026): this used to be called once per post, from
// inside generatePostImage, with excludeId set to the just-inserted row —
// correct for a single nightly post, but fill.ts's backfill path can
// generate a whole run of future posts for one platform in one pass (a real
// 8 Aug run inserted 17 Quill/Facebook posts in 24 minutes). Each of those
// calls queried "most recent scheduled_for", which — within that same
// run — resolved to the sibling inserted moments earlier, itself decided
// (and written) by this exact function. Once the first decision in a batch
// landed on false, every later post's "most recent" was also imageless, so
// the whole batch got stuck on false with nothing to flip it back — not
// because any single decision was wrong in isolation (each one correctly
// answered "did the most recent post have an image", exactly as designed),
// but because "most recent" inside one run kept meaning "the sibling I just
// decided", not "the last real, independently-generated post".
//
// Fix: this is now called ONCE per platform per run, BEFORE any of this
// run's rows exist — genuinely correct history, since nothing from this run
// can pollute it. The caller (fill.ts) then alternates the boolean itself
// in memory for the rest of the run, never re-querying mid-batch. A fresh
// run still reseeds from real DB state, so a manual edit or rejection made
// between runs is still picked up — the self-correction property is kept,
// just no longer re-derived on every single post within one run.
export async function seedAlternatingImageWantsImage(admin: Admin, clientId: string, platform: string): Promise<boolean> {
  const { data, error } = await admin
    .from('mkt_content_queue')
    .select('image_url')
    .eq('client_id', clientId).eq('platform', platform).eq('content_type', 'post')
    .neq('status', 'rejected')
    .order('scheduled_for', { ascending: false })
    .limit(1)
  if (error) {
    // Fail closed — a lookup failure must not turn into an image on every
    // post. No image is the safe side of this decision.
    console.error(`[image] Quill ${platform} image alternation seed lookup failed (${error.message}) — defaulting to no image`)
    return false
  }
  const previous = data?.[0]
  if (!previous) return true // no history yet — start the cycle with an image
  return !previous.image_url
}

// TODO (scoping note, not built — deliberately deferred, see 2026-08-09
// CRHQ image-style overhaul): automated face-detection + regenerate-on-
// failure as a hard backstop, in case CRHQ_CONCEPT_SYSTEM + Stability's own
// negative prompt (as it stood at the time — CRHQ has since moved to Flux;
// see the Flux review backstop further down, which is this same idea, now
// actually built for the Flux path) don't hold up as reliably once run
// against the full spread of real CRHQ stories, not just the 3 that were
// manually reviewed clean.
// Two failed rounds before the concept-prompt fix (see git history) showed
// prose + a negative prompt alone aren't trustworthy on their own — this
// would be the belt-and-braces version if manual spot-checks start finding
// face leakage again.
//
// Shape it would take:
// - A face-detection call (cheapest real option: AWS Rekognition
//   DetectFaces, pay-per-image, no infra to run; alternative is a
//   self-hosted model, e.g. via a small onnxruntime-web build, if avoiding
//   a second vendor dependency matters more than latency/cost) run against
//   the decoded Stability output, before the B&W/headline compositing step
//   in generatePostImage — i.e. right after callStabilityAI, gated behind
//   wantsHeadlineOverlay same as everything else here.
// - On a detected face: retry callStabilityAI up to some small cap (2-3
//   attempts total, matching the existing "never block the post over an
//   image" philosophy) — Stability has no seed-avoidance API, so a retry is
//   just a fresh generation, not a guided correction.
// - If every attempt still detects a face: fall back to no image for that
//   post (image_url stays null) rather than shipping a face, and log it the
//   same way disableImageGenForPlatform's callers do today — do NOT
//   silently ship the last attempt.
// - Cost/latency: each detection call is small (~100-300ms, fractions of a
//   cent) but multiplies with retries — worst case 3x the Stability spend
//   on a bad night. Fine at CRHQ's current volume; would need re-costing
//   before applying this pattern to a second client.
// - This does NOT need to be a new shared table/flag — same
//   wantsHeadlineOverlay-style gate is enough unless a second client wants
//   it, same reasoning as the rest of this file.

// Fetched once per cold start and reused across every image in that
// invocation — Anton (a bold condensed display face) rendered via
// Image.renderText(), which imagescript 1.2.15 takes as raw TTF bytes with
// no separate Font class.
async function headlineFontBytes(): Promise<Uint8Array> {
  if (cachedHeadlineFont) return cachedHeadlineFont
  const res = await fetch(HEADLINE_FONT_URL)
  if (!res.ok) throw new Error(`headline font fetch failed: HTTP ${res.status}`)
  cachedHeadlineFont = new Uint8Array(await res.arrayBuffer())
  return cachedHeadlineFont
}

// Turns the post copy into a short, punchy headline for the image's text
// banner — Stability itself cannot render legible text (see
// NO_TEXT_INSTRUCTION below), so the headline is composited on afterwards
// instead. Falls back to a truncated, upper-cased slice of the post body on
// any failure — same "never block the post over this" rule as
// summariseToVisualConcept above.
async function summariseToHeadline(postBody: string): Promise<string> {
  const body = String(postBody || '').replace(/\s+/g, ' ').trim()
  if (!body) return ''
  const system = 'You turn a social media post into a short, punchy headline for a bold text banner on an image, legible at small thumbnail size. 3-5 words maximum. Plain title case, no ending punctuation, no quotation marks, no hashtags. Reply with only the headline text, nothing else.'
  try {
    const headline = await callAnthropic(system, `Post:\n${body.slice(0, 1000)}`, 40)
    return headline.replace(/\s+/g, ' ').trim().replace(/^["']|["']$/g, '') || body.split(' ').slice(0, 5).join(' ').toUpperCase()
  } catch (e) {
    console.error(`[image] headline summary failed, falling back to truncated post body — ${String((e as Error)?.message ?? e)}`)
    return body.split(' ').slice(0, 5).join(' ').toUpperCase()
  }
}

// Splits a short headline into at most two roughly balanced lines so it
// composites cleanly onto a fixed-height banner — breaks at the space
// nearest the character midpoint rather than the word-count midpoint, since
// that reads more evenly for uneven word lengths. One line for 1-2 words.
function wrapHeadlineLines(headline: string): string[] {
  const words = headline.trim().split(/\s+/).filter(Boolean)
  if (words.length <= 2) return [words.join(' ')]
  const full = words.join(' ')
  const target = full.length / 2
  let bestIdx = -1
  let bestDist = Infinity
  let pos = 0
  for (let i = 0; i < words.length - 1; i++) {
    pos += words[i].length + 1
    const dist = Math.abs(pos - target)
    if (dist < bestDist) { bestDist = dist; bestIdx = i }
  }
  return [words.slice(0, bestIdx + 1).join(' '), words.slice(bestIdx + 1).join(' ')]
}

// Forces a deliberate, consistent B&W treatment regardless of what Stability
// actually returned (don't rely on the prompt alone for this), then
// composites a solid banner bar with the bold headline on top — Stability
// cannot render legible text itself. Banner height and font scale are
// proportional to the image's own dimensions so this looks right whether the
// image is the native 1024x1024 (Facebook) or the resized 1080x1080
// (Instagram). Mutates and returns the same Image instance.
async function applyForcedBWAndHeadline(image: Image, headline: string): Promise<Image> {
  image.saturation(0)
  if (!headline) return image

  const bannerHeight = Math.round(image.height * 0.24)
  const bannerY = image.height - bannerHeight
  image.drawBox(0, bannerY, image.width, bannerHeight, () => 0x000000ee)

  const font = await headlineFontBytes()
  const fontScale = Math.round(image.width * 0.0667)
  const lineGap = Math.round(fontScale * 0.17)
  const lines = wrapHeadlineLines(headline).map((line) => Image.renderText(font, fontScale, line, 0xffffffff))
  const totalTextHeight = lines.reduce((sum, l) => sum + l.height, 0) + lineGap * (lines.length - 1)
  let lineY = Math.round(bannerY + (bannerHeight - totalTextHeight) / 2)
  for (const line of lines) {
    const lineX = Math.round((image.width - line.width) / 2)
    image.composite(line, lineX, lineY)
    lineY += line.height + lineGap
  }
  return image
}

// Deterministic style-prefix check (not an AI/vision check) — does the prompt
// actually being sent to Stability contain this client's own configured
// visual_style verbatim? Stability has no vision-verification step of its
// own, so this is a pre-flight guard against the style silently getting
// dropped (a bad client row, a future buildImagePrompt refactor, etc.) rather
// than a check that inspects the returned image. A client with no
// visual_style configured has nothing to enforce, so it passes trivially.
function passesStylePrefixCheck(prompt: string, visualStyle: string | null): boolean {
  const style = String(visualStyle || '').trim()
  if (!style) return true
  return prompt.includes(style)
}

// Persists that image generation should stop for this client+platform after
// a style-check failure or a Stability error, and mutates the in-memory
// `client` object so later calls in the SAME fillClientGap run (which loops
// per-platform and can call generatePostImage more than once per client) see
// the disable immediately without needing a re-fetch. Scoped to one platform
// only — e.g. Combat Ready HQ's Facebook stream disabling itself must never
// touch its Instagram stream.
async function disableImageGenForPlatform(admin: Admin, client: Record<string, any>, platform: string, reason: string): Promise<void> {
  const current: string[] = Array.isArray(client.image_gen_disabled_platforms) ? client.image_gen_disabled_platforms : []
  if (current.includes(platform)) return
  const next = [...current, platform]
  const { error } = await admin.from('mkt_clients').update({ image_gen_disabled_platforms: next }).eq('id', client.id)
  if (error) {
    console.error(`[image] ${client.name}: failed to persist image_gen_disabled_platforms — ${error.message}`)
    return
  }
  client.image_gen_disabled_platforms = next
  const logMessage = `${client.name}: image generation disabled for platform "${platform}" — ${reason}`
  console.error(`[image] ${logMessage}`)

  // Best-effort — console.error alone is lost after Supabase's ~24h log
  // retention window, so this is the durable record. Must never block the
  // disable itself, which has already landed by this point.
  try {
    const { error: efeError } = await admin.from('edge_function_errors').insert({
      function_name: 'image',
      error_message: logMessage.slice(0, 4000),
    })
    if (efeError) console.error(`[image] failed to write edge_function_errors: ${efeError.message}`)
  } catch (e) {
    console.error(`[image] failed to write edge_function_errors: ${(e as Error)?.message ?? e}`)
  }
}

// ── Flux (Replicate) — CRHQ's provider ───────────────────────────────────────
// CRHQ moved off Stability to Flux 1.1 Pro (16 Aug 2026) after client feedback
// that the ink-wash illustration output read as obviously AI-generated. Every
// other client is untouched and still goes through Stability below.
//
// The catch this introduces, and the reason the review backstop further down
// exists: flux-1.1-pro has NO negative-prompt parameter. On Stability, CRHQ
// had used a genuine negative prompt (weight -1, removed 20 Aug 2026 as
// confirmed-dead code once CRHQ left Stability — see git history for the
// exact wording) as the mechanism actually holding the no-faces rule, and it
// has no Flux equivalent — exclusions can only be written as prose in the
// positive prompt, which has already recorded one real failure (a rendered
// face slipped through). Prose rules are still sent (belt), but the backstop
// is what enforces them (braces).
const FLUX_MODEL_URL = 'https://api.replicate.com/v1/models/black-forest-labs/flux-1.1-pro/predictions'
const FLUX_POLL_TIMEOUT_MS = 180_000

function usesFluxProvider(client: Record<string, any>): boolean {
  return client?.slug === 'crhq'
}

async function callFlux(prompt: string, token: string): Promise<Uint8Array> {
  const submit = await fetch(FLUX_MODEL_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      input: { prompt, aspect_ratio: '1:1', output_format: 'png', safety_tolerance: 2, prompt_upsampling: false },
    }),
  })
  if (!submit.ok) throw new Error(`Replicate submit ${submit.status}: ${(await submit.text()).slice(0, 300)}`)
  const prediction = await submit.json()
  const id = prediction?.id
  if (!id) throw new Error('Replicate returned no prediction id')

  const deadline = Date.now() + FLUX_POLL_TIMEOUT_MS
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 3000))
    const res = await fetch(`https://api.replicate.com/v1/predictions/${id}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    if (!res.ok) throw new Error(`Replicate poll ${res.status}`)
    const p = await res.json()
    if (p.status === 'succeeded') {
      const out = p.output
      const url = Array.isArray(out) ? out[0] : out
      if (!url) throw new Error('Replicate succeeded but returned no image URL')
      const img = await fetch(url)
      if (!img.ok) throw new Error(`Replicate image fetch ${img.status}`)
      return new Uint8Array(await img.arrayBuffer())
    }
    if (p.status === 'failed' || p.status === 'canceled') {
      throw new Error(`Replicate ${p.status}: ${String(p.error ?? 'unknown').slice(0, 200)}`)
    }
  }
  throw new Error(`Replicate prediction timed out after ${FLUX_POLL_TIMEOUT_MS / 1000}s`)
}

// ── Generated-image safety backstop ──────────────────────────────────────────
// One mechanism covering BOTH faces and legible text/markings, because both
// failed the same way: prose suppression in the prompt is advisory, and an
// image that breaches either rule must not be publishable regardless of what
// the prompt asked for.
//
// Split deliberately into measure -> judge. The vision model only MEASURES
// (how confident, how large, which features resolve, how legible); every
// accept/reject decision is the pure threshold function below. That keeps
// verdicts deterministic for a given measurement, auditable after the fact,
// and tunable without touching the model prompt.
//
// Thresholds approved 16 Aug 2026, calibrated against five real test images —
// see IMAGE_REVIEW_THRESHOLDS for the reasoning behind each number.
export const IMAGE_REVIEW_THRESHOLDS = {
  face: {
    // Below this, treat the detection as noise rather than a face.
    minConfidence: 0.50,
    // >=0.8% of frame area counts as prominent. Set deliberately BELOW the
    // 1.20% measured on the calibration image so prominence is not what
    // carries that image through — the landmark axis does that work — while
    // still catching a crisp face too small to clear a higher bar.
    prominenceAreaFraction: 0.008,
    // Of eyes/nose/mouth, how many must be individually resolvable. 0 = dark
    // mass, 1 = mostly obscured (the approved boundary case), 2-3 = genuinely
    // identifiable.
    minResolvableLandmarks: 2,
    // Eyes are disproportionately identifying — a face whose eyes resolve is
    // identifiable even with nose and mouth lost to shadow. Verified to change
    // no verdict on the calibration set, so it is free protection.
    eyesAloneCount: true,
  },
  text: {
    // Between garbled background lettering (measured 0.30-0.35, allowed) and a
    // rendered hull number (measured 0.55, rejected). Going lower would also
    // reject realistic map labels on otherwise-clean still lifes — an accepted
    // trade-off, signed off 16 Aug 2026.
    minLegibility: 0.40,
  },
}

const IMAGE_REVIEW_SYSTEM = `You are a measurement instrument for an image review pipeline. You do not make decisions and you never say whether an image passes or fails — you report only what is observably present, as precisely as you can.

Return ONLY a JSON object, no preamble, no code fence:

{
  "faces": [
    {
      "confidence": 0.0-1.0,
      "area_fraction": 0.0-1.0,
      "resolvable_landmarks": ["eyes","nose","mouth"],
      "lighting": "well_lit" | "dim" | "silhouette",
      "orientation": "frontal" | "three_quarter" | "profile" | "away_from_camera",
      "note": "one short phrase"
    }
  ],
  "text_findings": [
    { "content": "verbatim", "legibility": 0.0-1.0, "kind": "hull_number" | "unit_marking" | "registration" | "signage" | "label" | "watermark" | "other", "note": "where" }
  ]
}

area_fraction is the face bounding box area as a fraction of the FULL image area — a face filling a quarter of the frame is ~0.06. Be numerically careful; it drives a threshold.
resolvable_landmarks includes ONLY features whose shape you can individually make out. A dark or blurred mass you infer is a face but cannot resolve = empty array.
Report EVERY face including small, distant, dark or partly hidden ones, and EVERY instance of letters, digits or identifying markings including partial, stylised or garbled ones — garbled lettering still counts as text. Empty arrays are correct when there is genuinely nothing.

text_findings means GLYPHS ONLY: letters, digits, words, or identifying markings made of them. Do NOT report non-glyph graphics as text — map grid lines, contour lines, coastlines, hatching, scale bars, compass rose points, tally marks, dials without numerals, textures and patterns are all NOT text, however map-like or chart-like they appear. Report a clock or compass dial only if actual numerals are rendered on it.`

interface ImageMeasurement {
  faces?: Array<Record<string, unknown>>
  text_findings?: Array<Record<string, unknown>>
}

// Pure threshold application. Same measurement always yields the same verdict.
export function judgeImageMeasurement(
  measurement: ImageMeasurement,
  thresholds = IMAGE_REVIEW_THRESHOLDS,
): { verdict: 'pass' | 'reject'; reasons: string[] } {
  const reasons: string[] = []

  for (const f of measurement.faces ?? []) {
    const conf = Number(f.confidence ?? 0)
    if (conf < thresholds.face.minConfidence) continue
    const area = Number(f.area_fraction ?? 0)
    const names = (Array.isArray(f.resolvable_landmarks) ? f.resolvable_landmarks : []).map((s) => String(s).toLowerCase())

    const prominent = area >= thresholds.face.prominenceAreaFraction
    const resolvable = names.length >= thresholds.face.minResolvableLandmarks
      || (thresholds.face.eyesAloneCount && names.includes('eyes'))

    // AND, deliberately — a large dark mass with no resolvable features is
    // acceptable, and so is a crisp face too small to identify. Rejecting on
    // detection alone is the blunt behaviour this replaces.
    if (prominent && resolvable) {
      reasons.push(
        `FACE: area ${(area * 100).toFixed(1)}% of frame (>=${(thresholds.face.prominenceAreaFraction * 100).toFixed(1)}%) ` +
        `AND ${names.length} resolvable landmark(s) [${names.join('/')}] — conf ${conf.toFixed(2)}, ${f.lighting}, ${f.orientation}`,
      )
    }
  }

  for (const t of measurement.text_findings ?? []) {
    const legibility = Number(t.legibility ?? 0)
    if (legibility >= thresholds.text.minLegibility) {
      reasons.push(`TEXT: "${String(t.content ?? '').slice(0, 60)}" (${t.kind}) legibility ${legibility.toFixed(2)} (>=${thresholds.text.minLegibility})`)
    }
  }

  return { verdict: reasons.length ? 'reject' : 'pass', reasons }
}

// Measure + judge in one call. Exported so the backstop can be exercised
// against real generated bytes without going through a whole post-generation
// run — the verification harness uses exactly this, so what gets tested is
// the shipped code path rather than a parallel copy of it.
export async function reviewGeneratedImage(
  bytes: Uint8Array,
): Promise<{ verdict: 'pass' | 'reject'; reasons: string[]; measurement: ImageMeasurement }> {
  const measurement = await measureImage(bytes)
  return { ...judgeImageMeasurement(measurement), measurement }
}

// Exported for the same reason — the harness generates with identical
// parameters to production rather than approximating them.
export async function generateWithFlux(prompt: string, token: string): Promise<Uint8Array> {
  return await callFlux(prompt, token)
}

// Pulls the FIRST complete JSON object out of a model response.
//
// This previously used /\{[\s\S]*\}/ — greedy, so it spanned from the first
// "{" to the LAST "}" anywhere in the reply. When the model returned its JSON
// and then added a sentence of commentary containing a brace, the match
// swallowed both and JSON.parse died with "Unexpected non-whitespace character
// after JSON at position N". That was not a rare edge case: on 18 Aug 2026 it
// killed 2 of the 3 style attempts on BOTH of CRHQ's posts
// (19e37a77…, 496b8d62…), leaving one real style verdict before the loop
// declared itself exhausted and shipped no image at all.
//
// Brace-counting from the first "{" (string-aware, so braces inside quoted
// values don't miscount) returns exactly one object and ignores anything after
// it. Markdown fences are stripped first.
function extractFirstJsonObject(raw: string): string | null {
  const text = String(raw ?? '').replace(/```(?:json)?/gi, '')
  const start = text.indexOf('{')
  if (start === -1) return null
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') { inString = true; continue }
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return text.slice(start, i + 1)
    }
  }
  return null
}

async function measureImage(bytes: Uint8Array): Promise<ImageMeasurement> {
  // Chunked base64 — a spread/apply over a ~1.5MB image blows the call stack.
  let binary = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  const b64 = btoa(binary)

  const raw = await callAnthropicVision(IMAGE_REVIEW_SYSTEM, b64, 'Measure this image.', 1500)
  const json = extractFirstJsonObject(raw)
  if (!json) throw new Error(`image review returned no JSON: ${raw.slice(0, 200)}`)
  return JSON.parse(json) as ImageMeasurement
}

// Durable record of every review attempt — see migration 101. Best-effort:
// losing a log row must never cost an otherwise-good image.
async function logImageReview(
  admin: Admin,
  client: Record<string, any>,
  contentQueueId: string,
  platform: string,
  attempt: number,
  verdict: 'pass' | 'reject' | 'error' | 'exhausted',
  reasons: string[],
  measurement: ImageMeasurement | null,
  // The scene the image was asked to depict (migration
  // 20260821_image_review_events_concept). Recorded on every attempt so
  // "was the image about the post?" is answerable from the table instead of
  // only by re-running the concept model — which is how Defect 2 went
  // unnoticed for as long as it did.
  concept: string | null = null,
): Promise<void> {
  try {
    const { error } = await admin.from('image_review_events').insert({
      content_queue_id: contentQueueId,
      client_id: client?.id ?? null,
      client_name: client?.name ?? null,
      platform,
      attempt,
      verdict,
      reasons,
      measurement,
      concept,
    })
    if (error) console.error(`[image] image_review_events insert failed: ${error.message}`)
  } catch (e) {
    console.error(`[image] image_review_events insert threw: ${String((e as Error)?.message ?? e)}`)
  }
}

// Escalating pressure on the rule that actually failed. Regenerating with an
// identical prompt is just another roll of the same dice.
const REVIEW_ESCALATION = {
  // Rewritten 21 Aug 2026. The previous text escalation was itself made of
  // glyph nouns — "legible lettering… any hull, plate, sign or chart that
  // could carry markings" — and on Flux there is no negative channel to send
  // them down, so it went in as positive conditioning on the retry. The 20 Aug
  // Birmingham run is the record: attempt 1 rejected on storefront signage,
  // this escalation appended, attempt 2 came back with MORE signage
  // ("POLICE", "PUBS", "S LOAN"), attempt 3 the same again. It was not merely
  // failing to help.
  //
  // A retry cannot rewrite the concept it was given, so the one lever it has
  // is the camera: move in until only material fills the frame. Stated
  // positively, naming nothing it does not want.
  text: 'CRITICAL: move the camera much closer and photograph bare physical material alone — raw concrete, weathered brick, wet tarmac, bare steel, plain cloth, stone, earth, water. Fill the whole frame with that material, its texture, and the light falling across it. Material, texture, shadow and weather are the entire subject of this photograph.',
  face: 'CRITICAL: the previous attempt rendered an identifiable face. Remove people from the frame entirely — this is an environmental or still-life photograph with no human figures at all.',
}

const IMAGE_REVIEW_MAX_ATTEMPTS = 3

// ── Visual-style compliance (all brands) ─────────────────────────────────────
// Added 18 Aug 2026. Until now the ONLY check on a generated image was
// passesStylePrefixCheck, which verifies the brand's visual_style text was
// present in the PROMPT — it never looks at the resulting image. Two confirmed
// failures made the gap concrete: a CRHQ image with a visible human figure
// reached the approval queue (11 Aug), and Quill kept producing illustrated
// people despite its own "no people" rule (18 Aug).
//
// The pre-existing face/text backstop above is CRHQ-only (it runs on the Flux
// branch, and useFlux is slug === 'crhq'), so every other brand had no
// post-generation image check of any kind.
//
// Deliberately generic: it reads each brand's own visual_style from
// mkt_clients and asks whether THIS image breaks the prohibitions stated
// there. No CRHQ- or Quill-specific logic, so any brand with image generation
// is covered the moment it has a visual_style — 6 of the 9 image-generating
// brands currently state some form of "no people".
const STYLE_REVIEW_MAX_ATTEMPTS = 3
// How many times the style checker itself may fail (parse/transport) without
// costing a generation attempt. Bounded so a persistently broken checker can
// never loop forever — once spent, the post goes out image-less and flagged.
const STYLE_CHECK_ERROR_BUDGET = 3

// Same measure-then-judge split the face/text backstop uses: the model reports
// what it observes and which stated rule it breaks; fixed code decides the
// outcome. It is told to flag ONLY unambiguous breaches of explicit
// prohibitions — a brand's aesthetic preferences (film stock, palette,
// lighting) are not pass/fail criteria, and treating them as such would stall
// the pipeline on taste rather than rules.
const STYLE_COMPLIANCE_SYSTEM = `You check whether a generated image breaks the explicit visual rules a brand has set. You are given the brand's own visual style specification and one image.

Return ONLY a JSON object, no preamble, no code fence:

{
  "violations": [
    { "rule": "the specific prohibition breached, quoted or closely paraphrased from the specification", "observed": "what is actually visible in the image that breaches it", "certainty": 0.0-1.0 }
  ]
}

Rules for judging:
- Report ONLY breaches of explicit PROHIBITIONS — wording like "no ...", "never ...", "absolutely no ...", "avoid entirely". These are hard rules.
- Do NOT report aesthetic or stylistic preferences as violations. Colour palette, film grain, lens character, lighting mood, composition and general "feel" are NOT pass/fail criteria, even when the specification describes them in detail.
- A prohibition on people/human figures/faces is breached by ANY depicted person, including illustrated, cartoon, silhouetted, distant, partial, or seen from behind — unless the specification itself explicitly permits that form.
- certainty is how sure you are the breach is really present and really prohibited. Use below 0.7 when you are unsure, guessing, or the rule is ambiguous.
- An empty violations array is the correct and expected answer for a compliant image. Do not invent a breach to seem thorough.`

interface StyleComplianceResult {
  violations?: Array<{ rule?: unknown; observed?: unknown; certainty?: unknown }>
}

// Only act on breaches the model is genuinely confident about. Below this, a
// borderline call would cost the post its image and flag it for a human on
// what may be a hallucinated violation — the wrong trade for a false positive.
const STYLE_VIOLATION_MIN_CERTAINTY = 0.7

// Pure: same measurement always yields the same verdict. Mirrors
// judgeImageMeasurement.
export function judgeStyleCompliance(result: StyleComplianceResult): { compliant: boolean; violation: string | null } {
  const found = (result?.violations ?? [])
    .filter((v) => Number(v?.certainty ?? 0) >= STYLE_VIOLATION_MIN_CERTAINTY)
    .map((v) => {
      const rule = String(v?.rule ?? '').trim() || 'unstated rule'
      const observed = String(v?.observed ?? '').trim()
      return observed ? `${rule} — ${observed}` : rule
    })

  if (!found.length) return { compliant: true, violation: null }
  return { compliant: false, violation: found.join('; ').slice(0, 500) }
}

// Asks the vision model to check this image against this brand's own rules.
// Throws on transport/parse failure so the caller can log it and decide —
// never silently returns "compliant" on an error.
export async function checkStyleCompliance(bytes: Uint8Array, visualStyle: string): Promise<{ compliant: boolean; violation: string | null }> {
  // Chunked base64 — a spread/apply over a ~1.5MB image blows the call stack.
  let binary = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  const b64 = btoa(binary)

  const raw = await callAnthropicVision(
    STYLE_COMPLIANCE_SYSTEM,
    b64,
    `Brand visual style specification:\n\n${visualStyle}\n\nCheck this image against it.`,
    1000,
  )
  const json = extractFirstJsonObject(raw)
  if (!json) throw new Error(`style compliance check returned no JSON: ${raw.slice(0, 200)}`)
  return judgeStyleCompliance(JSON.parse(json) as StyleComplianceResult)
}

// Flags the post the same way a failed TEXT review is flagged (see fill.ts's
// needs_attention branch), so a human sees it in the approval queue with a
// reason naming the rule that failed. Deliberately does NOT touch image_url —
// a non-compliant image must never be attached.
async function flagImageNeedsAttention(
  admin: Admin,
  contentQueueId: string,
  reason: string,
): Promise<void> {
  const { error } = await admin.from('mkt_content_queue').update({
    review_status: 'needs_attention',
    review_reason: `Image failed visual-style compliance: ${reason}`.slice(0, 1000),
  }).eq('id', contentQueueId)
  if (error) console.error(`[image] flagging needs_attention failed for ${contentQueueId}: ${error.message}`)
}

// ── AI provenance marker ─────────────────────────────────────────────────────
// Meta requires photorealistic AI-generated organic posts to carry an AI
// disclosure, and its automatic detection keys off industry provenance
// signals. Flux DOES emit those: every flux-1.1-pro PNG ships a signed C2PA
// manifest (a caBX chunk) asserting IPTC digitalSourceType
// trainedAlgorithmicMedia. Our own pipeline was destroying it — verified, not
// assumed: a probe PNG carrying a real 21,330-byte caBX chunk came back from
// both resizeForPlatform and the forced-B&W step with only IHDR/IDAT/IEND.
// ImageScript decodes to raw pixels and re-encodes; ancillary chunks do not
// survive, and it exposes no API to carry them through.
//
// The obvious fix — re-attach the original caBX after processing — is WRONG,
// and this is the important part. That manifest contains a c2pa.hash.data
// assertion: a sha256 hard binding over the whole file, excluding only the
// manifest's own byte range. Recolouring to B&W and compositing a headline
// changes IDAT, so the stored hash no longer matches. Re-attaching it would
// produce a manifest that FAILS validation — a validator reads that as
// "this asset has been tampered with", which is a worse signal than carrying
// no manifest at all. Emitting a knowingly-broken cryptographic claim is not
// a disclosure.
//
// Signing a fresh C2PA manifest for the derived image (the correct C2PA
// answer, with the original as a declared ingredient) needs a signing
// certificate and a C2PA library, neither of which this project has.
//
// So we write the same industry signal in the form that is legitimately ours
// to assert: an XMP packet carrying IPTC DigitalSourceType
// trainedAlgorithmicMedia. It is not cryptographically bound, so it survives
// our processing honestly rather than by pretending nothing changed, and it
// is a true statement about the derived asset — which is still AI-generated,
// just also edited by us.
const XMP_KEYWORD = 'XML:com.adobe.xmp'
const IPTC_TRAINED_ALGORITHMIC_MEDIA = 'http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia'

function xmpPacket(): string {
  return `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about=""
    xmlns:Iptc4xmpExt="http://iptc.org/std/Iptc4xmpExt/2008-02-29/">
   <Iptc4xmpExt:DigitalSourceType>${IPTC_TRAINED_ALGORITHMIC_MEDIA}</Iptc4xmpExt:DigitalSourceType>
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`
}

// CRC32 as PNG specifies it, for the chunk we synthesise.
function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff
  for (let i = 0; i < bytes.length; i++) {
    c ^= bytes[i]
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1))
  }
  return (c ^ 0xffffffff) >>> 0
}

// Inserts (or replaces) an uncompressed iTXt XMP chunk carrying the IPTC
// digital-source-type marker, positioned before the first IDAT as the PNG
// spec requires for metadata that describes the image.
export function withAiProvenance(png: Uint8Array): Uint8Array {
  const SIG = 8
  if (png.length < SIG) return png
  const dv = new DataView(png.buffer, png.byteOffset, png.byteLength)

  // Build the iTXt payload:
  //   keyword \0 compressionFlag compressionMethod langTag \0 translatedKeyword \0 text
  const enc = new TextEncoder()
  const kw = enc.encode(XMP_KEYWORD)
  const text = enc.encode(xmpPacket())
  const payload = new Uint8Array(kw.length + 1 + 1 + 1 + 1 + 1 + text.length)
  let o = 0
  payload.set(kw, o); o += kw.length
  payload[o++] = 0 // keyword terminator
  payload[o++] = 0 // compression flag: uncompressed
  payload[o++] = 0 // compression method
  payload[o++] = 0 // empty language tag
  payload[o++] = 0 // empty translated keyword
  payload.set(text, o)

  const typeAndData = new Uint8Array(4 + payload.length)
  typeAndData.set(enc.encode('iTXt'), 0)
  typeAndData.set(payload, 4)

  const chunk = new Uint8Array(4 + typeAndData.length + 4)
  new DataView(chunk.buffer).setUint32(0, payload.length)
  chunk.set(typeAndData, 4)
  new DataView(chunk.buffer).setUint32(4 + typeAndData.length, crc32(typeAndData))

  // Walk to the first IDAT, dropping any pre-existing XMP iTXt so repeated
  // passes cannot stack duplicate packets.
  const head: Uint8Array[] = [png.subarray(0, SIG)]
  let pos = SIG
  let inserted = false
  const out: Uint8Array[] = head
  while (pos + 8 <= png.length) {
    const len = dv.getUint32(pos)
    const typ = String.fromCharCode(png[pos + 4], png[pos + 5], png[pos + 6], png[pos + 7])
    const whole = png.subarray(pos, pos + 12 + len)

    if (typ === 'iTXt') {
      const body = png.subarray(pos + 8, pos + 8 + len)
      const nul = body.indexOf(0)
      if (nul > 0 && new TextDecoder().decode(body.subarray(0, nul)) === XMP_KEYWORD) {
        pos += 12 + len
        continue // drop the old packet
      }
    }
    if (!inserted && (typ === 'IDAT' || typ === 'IEND')) {
      out.push(chunk)
      inserted = true
    }
    out.push(whole)
    pos += 12 + len
    if (typ === 'IEND') break
  }
  if (!inserted) return png // not a PNG shape we recognise — leave it alone

  const total = out.reduce((n, b) => n + b.length, 0)
  const merged = new Uint8Array(total)
  let off = 0
  for (const b of out) { merged.set(b, off); off += b.length }
  return merged
}

// Reads back the marker — used by the verification harness and safe to call
// on any PNG.
export function hasAiProvenance(png: Uint8Array): boolean {
  const dv = new DataView(png.buffer, png.byteOffset, png.byteLength)
  let pos = 8
  while (pos + 8 <= png.length) {
    const len = dv.getUint32(pos)
    const typ = String.fromCharCode(png[pos + 4], png[pos + 5], png[pos + 6], png[pos + 7])
    if (typ === 'iTXt') {
      const body = new TextDecoder().decode(png.subarray(pos + 8, pos + 8 + len))
      if (body.includes(XMP_KEYWORD) && body.includes(IPTC_TRAINED_ALGORITHMIC_MEDIA)) return true
    }
    pos += 12 + len
    if (typ === 'IEND') break
  }
  return false
}

interface StabilityArtifact { base64: string; finishReason: string }

async function callStabilityAI(prompt: string, apiKey: string, negativePrompt?: string): Promise<Uint8Array> {
  const text_prompts = [{ text: prompt, weight: 1 }]
  if (negativePrompt) text_prompts.push({ text: negativePrompt, weight: -1 })
  const res = await fetch(`https://api.stability.ai/v1/generation/${STABILITY_ENGINE_ID}/text-to-image`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      text_prompts,
      height: IMAGE_SIZE,
      width: IMAGE_SIZE,
      samples: 1,
      steps: 30,
      cfg_scale: 7,
    }),
  })
  if (!res.ok) {
    const detail = await res.text()
    throw new Error(`Stability AI ${res.status}: ${detail.slice(0, 300)}`)
  }
  const data = await res.json()
  const artifact: StabilityArtifact | undefined = data?.artifacts?.[0]
  if (!artifact?.base64) throw new Error('Stability AI returned no image artifact')
  if (artifact.finishReason && artifact.finishReason !== 'SUCCESS') {
    throw new Error(`Stability AI finishReason: ${artifact.finishReason}`)
  }
  return Uint8Array.from(atob(artifact.base64), (c) => c.charCodeAt(0))
}

// Generates one image for a just-queued post and writes its public URL back
// onto the row. Swallows every error itself (logs and returns) so a failure
// here never bubbles up into fill.ts's post-generation flow — see the file
// header. contentQueueId must already exist in mkt_content_queue.
export async function generatePostImage(
  admin: Admin,
  client: Record<string, any>,
  contentQueueId: string,
  postBody: string,
  platform: string,
  // The real story this post was written from — CRHQ's per-post primary
  // source (crhq-nightly-content's primarySourceForPlatform). Optional, and
  // every caller that doesn't have one behaves exactly as before.
  sourceTitle?: string | null,
  // Pre-computed alternation decision for Quill's alternating streams (see
  // seedAlternatingImageWantsImage's batching-fix comment above) — fill.ts
  // seeds this once per platform per run and flips it in memory per post,
  // rather than this function re-querying the DB on every call. undefined
  // means "no pre-computed decision" — falls back to the old per-call query,
  // which is still correct for a single, non-batched call (e.g. the manual
  // "Generate a post" button).
  precomputedWantsImage?: boolean,
): Promise<void> {
  // Per-client platform ALLOW-list (mkt_clients.image_gen_platforms, migration
  // 51). When set, images are generated ONLY for those platforms — every other
  // platform returns here before any work happens: no Anthropic summarisation,
  // no Stability call, no upload, no image_url. Empty/unset means "no
  // restriction", so clients without an allow-list are completely unaffected.
  // CRHQ is configured for both instagram and facebook — see
  // schedule-to-metricool/index.ts's facebookTextOnly check, which is the
  // reason CRHQ is the one brand whose Facebook posts get the image attached
  // at all. Checked before the deny-list below because it's deliberate
  // configuration, whereas the deny-list is the automatic post-failure
  // kill-switch.
  const allowedPlatforms: string[] = Array.isArray(client.image_gen_platforms) ? client.image_gen_platforms : []
  if (allowedPlatforms.length && !allowedPlatforms.some((p) => String(p).toLowerCase() === String(platform).toLowerCase())) {
    console.log(`[image] ${client.name}: platform "${platform}" not in image_gen_platforms — skipping image for ${contentQueueId}`)
    return
  }

  const disabledPlatforms: string[] = Array.isArray(client.image_gen_disabled_platforms) ? client.image_gen_disabled_platforms : []
  if (disabledPlatforms.includes(platform)) {
    console.log(`[image] ${client.name}: image generation disabled for platform "${platform}" — skipping ${contentQueueId}`)
    return
  }

  // Quill's alternating streams only (LinkedIn, and Facebook since the
  // 2026-08-10 image test — see isQuillAlternatingStream). Checked after the
  // allow/deny-list gates above (deliberate configuration always wins first)
  // but before any generation work starts. Prefers the caller's
  // precomputedWantsImage when given (fill.ts's batching fix — see
  // seedAlternatingImageWantsImage); only re-queries here when a caller
  // hasn't precomputed one, which is still correct for a single call.
  if (isQuillAlternatingStream(client, platform)) {
    const wantsImage = precomputedWantsImage !== undefined
      ? precomputedWantsImage
      : await seedAlternatingImageWantsImage(admin, client.id, platform)
    if (!wantsImage) {
      console.log(`[image] ${client.name}: skipping image for ${contentQueueId} — alternating (previous post had one)`)
      return
    }
  }

  // Provider split: CRHQ on Flux (Replicate), everyone else on Stability.
  const useFlux = usesFluxProvider(client)
  const apiKey = useFlux ? Deno.env.get('REPLICATE_API_TOKEN') : Deno.env.get('STABILITY_AI_API_KEY')
  if (!apiKey) {
    console.error(`[image] ${client.name}: ${useFlux ? 'REPLICATE_API_TOKEN' : 'STABILITY_AI_API_KEY'} not set — skipping image for ${contentQueueId}`)
    return
  }

  const { prompt, concept } = await buildImagePrompt(postBody, client.visual_style, client, sourceTitle)

  // Fails closed: an opportunity to enforce the brand's locked visual style
  // silently dropping is worse than one missing image. Disables this
  // client+platform going forward rather than retrying — Stability content
  // moderation rejections for a strict brief (e.g. a tactical/military
  // aesthetic) tend to repeat every time, not be one-off flukes.
  if (!passesStylePrefixCheck(prompt, client.visual_style)) {
    await disableImageGenForPlatform(admin, client, platform, 'generated prompt did not include the client\'s configured visual_style')
    return
  }

  try {
    // Produces raw model output from whichever provider this brand uses.
    // Returns null when the Flux face/text backstop exhausted its own attempts
    // (that path logs its own 'exhausted' event before giving up).
    const generateRaw = async (attemptPrompt: string): Promise<Uint8Array | null> => {
      if (useFlux) {
      // Generate -> measure -> judge -> regenerate. The backstop is the gate:
      // an image is only used if it clears BOTH the face and text thresholds,
      // regardless of what the prose rules in the prompt asked for.
      //
      // Every attempt is logged to image_review_events, passes included — a
      // rejection count with no denominator cannot tell "nothing is being
      // caught" apart from "the reviewer is erroring out and defaulting open".
      const escalations: string[] = []
      let accepted: Uint8Array | null = null
      let lastBytes: Uint8Array | null = null

      for (let attempt = 1; attempt <= IMAGE_REVIEW_MAX_ATTEMPTS; attempt++) {
        const fluxPrompt = escalations.length ? `${attemptPrompt}\n\n${escalations.join('\n')}` : attemptPrompt
        const candidate = await callFlux(fluxPrompt, apiKey)
        lastBytes = candidate

        let measurement: ImageMeasurement
        try {
          measurement = await measureImage(candidate)
        } catch (e) {
          // A reviewer failure must not silently publish an unreviewed image,
          // but it must also not cost the post its image entirely. Logged as
          // 'error' so these are visible and countable rather than invisible.
          const msg = String((e as Error)?.message ?? e)
          console.error(`[image] ${client.name}: review measurement failed on attempt ${attempt} — ${msg}`)
          await logImageReview(admin, client, contentQueueId, platform, attempt, 'error', [msg], null, concept)
          continue
        }

        const { verdict, reasons } = judgeImageMeasurement(measurement)
        await logImageReview(admin, client, contentQueueId, platform, attempt, verdict, reasons, measurement, concept)

        if (verdict === 'pass') {
          accepted = candidate
          if (attempt > 1) console.log(`[image] ${client.name}: image accepted on attempt ${attempt} for ${contentQueueId}`)
          break
        }

        console.error(`[image] ${client.name}: attempt ${attempt} rejected for ${contentQueueId} — ${reasons.join('; ')}`)
        escalations.length = 0
        if (reasons.some((r) => r.startsWith('TEXT'))) escalations.push(REVIEW_ESCALATION.text)
        if (reasons.some((r) => r.startsWith('FACE'))) escalations.push(REVIEW_ESCALATION.face)
      }

      if (!accepted) {
        // Every attempt breached a threshold. Publishing the last one anyway
        // would defeat the point of the backstop, so this post goes out
        // text-only — the same outcome as any other image failure in this
        // file, and strictly better than shipping a face or a hull number.
        await logImageReview(admin, client, contentQueueId, platform, IMAGE_REVIEW_MAX_ATTEMPTS, 'exhausted',
          [`no attempt passed review after ${IMAGE_REVIEW_MAX_ATTEMPTS} tries — no image attached`], null, concept)
        console.error(`[image] ${client.name}: all ${IMAGE_REVIEW_MAX_ATTEMPTS} attempts failed review for ${contentQueueId} — posting without an image`)
        return null
      }
        void lastBytes
        return accepted
      }

      // No client currently supplies a negative prompt on this branch — CRHQ
      // was the only one that did, and CRHQ is on Flux (usesFluxProvider),
      // never Stability, so that value could never actually reach here (see
      // CRHQ_MEDIUM_DIRECTIVE above). callStabilityAI's negativePrompt
      // parameter is kept — it's the general mechanism (weight -1 push),
      // just currently unused; wire a real one through if a future
      // Stability client needs it.
      return await callStabilityAI(attemptPrompt, apiKey)
    }

    // ── Visual-style compliance gate (every brand) ───────────────────────────
    // Generate -> check the IMAGE against this brand's own visual_style
    // prohibitions -> regenerate on a confident breach. This is the check that
    // was missing entirely: passesStylePrefixCheck above only proves the style
    // text reached the prompt, and the face/text backstop only runs for CRHQ.
    //
    // A brand with no visual_style set skips this — there is nothing to check
    // against, and inventing rules for it would be worse than not checking.
    const styleRules = String(client.visual_style ?? '').trim()
    let rawBytes: Uint8Array | null = null
    let lastViolation: string | null = null

    // A checker crash must not cost a generation attempt. Before this, the
    // catch below did a bare `continue`, so a transport blip — or the greedy
    // JSON bug fixed in extractFirstJsonObject — silently burned one of the
    // three tries without ever producing a style verdict. On 18 Aug 2026 that
    // consumed 2 of 3 attempts on both CRHQ posts, so a single genuine
    // rejection was enough to exhaust the loop and ship no image.
    //
    // Checker errors now draw on their own separate budget and re-run the
    // same attempt number, so STYLE_REVIEW_MAX_ATTEMPTS means what it says:
    // three real style verdicts.
    let checkerErrors = 0
    for (let attempt = 1; attempt <= STYLE_REVIEW_MAX_ATTEMPTS; attempt++) {
      const attemptPrompt = lastViolation
        // Escalate on the rule that actually broke, same reasoning as
        // REVIEW_ESCALATION — regenerating with an identical prompt is another
        // roll of the same dice. Phrased as a positive correction rather than
        // by quoting the violation back: see styleCorrectionFor.
        ? `${prompt}\n\nCRITICAL — the previous attempt was rejected. ${styleCorrectionFor(lastViolation)} This is a hard requirement, not a preference.`
        : prompt

      const candidate = await generateRaw(attemptPrompt)
      // Provider-level exhaustion (Flux face/text backstop) already logged and
      // already decided this post goes out image-less.
      if (!candidate) return

      if (!styleRules) { rawBytes = candidate; break }

      let verdict: { compliant: boolean; violation: string | null }
      try {
        verdict = await checkStyleCompliance(candidate, styleRules)
      } catch (e) {
        // A checker failure must not silently attach an unchecked image, but
        // it must not cost the post its image on a transport blip either.
        // Logged as 'error' so it is visible and countable; the loop retries.
        const msg = String((e as Error)?.message ?? e)
        console.error(`[image] ${client.name}: style compliance check failed on attempt ${attempt} — ${msg}`)
        await logImageReview(admin, client, contentQueueId, platform, attempt, 'error', [`style check error: ${msg}`], null, concept)
        checkerErrors++
        if (checkerErrors <= STYLE_CHECK_ERROR_BUDGET) {
          // Re-run this attempt rather than consuming it — no style verdict
          // was produced, so nothing was actually learned about the image.
          attempt--
          continue
        }
        // Budget spent: stop retrying the checker and fall through to the
        // exhausted branch, which attaches no image and flags for a human.
        // Failing closed is deliberate — an unchecked image must never ship.
        console.error(`[image] ${client.name}: style checker failed ${checkerErrors}x, giving up for ${contentQueueId}`)
        break
      }

      await logImageReview(
        admin, client, contentQueueId, platform, attempt,
        verdict.compliant ? 'pass' : 'reject',
        [verdict.compliant ? 'visual_style compliant' : `STYLE ${verdict.violation}`],
        null, concept,
      )

      if (verdict.compliant) {
        rawBytes = candidate
        if (attempt > 1) console.log(`[image] ${client.name}: style-compliant on attempt ${attempt} for ${contentQueueId}`)
        break
      }

      console.error(`[image] ${client.name}: attempt ${attempt} broke visual_style for ${contentQueueId} — ${verdict.violation}`)
      lastViolation = verdict.violation
    }

    if (!rawBytes) {
      // Every attempt broke the brand's own stated rules. Do NOT attach the
      // image, and flag the post for a human the same way a failed text review
      // is flagged — with a reason naming the rule that failed.
      await logImageReview(admin, client, contentQueueId, platform, STYLE_REVIEW_MAX_ATTEMPTS, 'exhausted',
        [`visual_style not met after ${STYLE_REVIEW_MAX_ATTEMPTS} attempts — no image attached`], null, concept)
      await flagImageNeedsAttention(admin, contentQueueId, lastViolation ?? 'compliance check could not complete')
      console.error(`[image] ${client.name}: all ${STYLE_REVIEW_MAX_ATTEMPTS} attempts broke visual_style for ${contentQueueId} — flagged needs_attention, no image attached`)
      return
    }

    let bytes = await resizeForPlatform(rawBytes, platform)

    // CRHQ-only (see wantsHeadlineOverlay): force a deliberate B&W treatment
    // and composite a bold headline banner on top, regardless of platform —
    // both facebook and instagram get the same treated image, since CRHQ is
    // the one brand whose Facebook posts actually attach the image (see the
    // allow-list comment above). A failure here falls back to the plain
    // Stability output rather than losing the image entirely — this is a
    // finishing step, not a hard requirement for the post to go out.
    if (wantsHeadlineOverlay(client)) {
      try {
        const headline = await summariseToHeadline(postBody)
        const image = await Image.decode(bytes)
        await applyForcedBWAndHeadline(image, headline)
        bytes = await image.encode()
      } catch (e) {
        console.error(`[image] ${client.name}: forced B&W/headline compositing failed, using plain image — ${String((e as Error)?.message ?? e)}`)
      }
    }

    // LAST step before upload, deliberately: every ImageScript re-encode above
    // strips ancillary chunks, so anything written earlier would not survive.
    // Applied to every generated image, not just CRHQ — each one really is
    // AI-generated, and a truthful marker costs nothing on the others.
    bytes = withAiProvenance(bytes)

    const folder = client.slug || 'unknown-brand'
    const path = `${folder}/${contentQueueId}.png`
    const { error: upErr } = await admin.storage.from('mkt-assets').upload(path, bytes, {
      contentType: 'image/png',
      upsert: true,
    })
    if (upErr) throw new Error(`storage upload failed: ${upErr.message}`)

    const { data: pub } = admin.storage.from('mkt-assets').getPublicUrl(path)
    const imageUrl = pub?.publicUrl
    if (!imageUrl) throw new Error('storage upload succeeded but no public URL was returned')

    const { error: updErr } = await admin.from('mkt_content_queue').update({ image_url: imageUrl }).eq('id', contentQueueId)
    if (updErr) throw new Error(`writing image_url back to mkt_content_queue failed: ${updErr.message}`)

    console.log(`[image] ${client.name}: image generated for ${contentQueueId}`)
  } catch (e) {
    const msg = String((e as Error)?.message ?? e)
    console.error(`[image] ${client.name}: image generation failed for ${contentQueueId} — ${msg}`)
    // image_url stays whatever it already was (null on a fresh insert) — the
    // post itself is unaffected; the approval queue UI flags the missing image.
    await disableImageGenForPlatform(admin, client, platform, `Stability error — ${msg}`.slice(0, 300))
  }
}
