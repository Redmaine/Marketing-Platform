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
const CRHQ_CONCEPT_SYSTEM = 'You turn a social media post into a short, concrete visual scene description for an AI image generator that will render it as a black-and-white documentary reportage photograph. Describe ONE clear setting, composition and mood that captures what the post is about, drawing from a wide range of possible settings (coastal and maritime, government or parliamentary buildings, outdoor and field locations, city streets, courtrooms, transport and infrastructure, or an interior only when it is genuinely the best fit) — do not default to an office, briefing room, or security operations centre unless the story is unambiguously about that exact thing. Critically: never describe a person\'s face, expression, or a close-up or portrait of a person — no "a man reading," no "an official looking concerned," nothing that puts a human face in frame. If a human presence belongs in the scene, describe it only as a distant figure, a silhouette, or a figure seen from behind — never facial detail. Strongly prefer scenes built around objects, architecture, landscape or symbolic detail over scenes built around a person. Describe surfaces as blank and unmarked — never mention hull numbers, registrations, signage, badges, insignia or any lettering, and avoid making a marked surface the subject of the shot. Never describe any text, quotes, numbers or words that should appear in the image. Reply with only the scene description, one or two sentences, no preamble, no quotation marks.'

async function summariseToVisualConcept(postBody: string, systemPrompt: string = DEFAULT_CONCEPT_SYSTEM): Promise<string> {
  const body = String(postBody || '').replace(/\s+/g, ' ').trim()
  if (!body) return ''
  try {
    const concept = await callAnthropic(systemPrompt, `Post:\n${body.slice(0, 1000)}`, 150)
    return concept.replace(/\s+/g, ' ').trim() || body.slice(0, 220)
  } catch (e) {
    console.error(`[image] visual-concept summary failed, falling back to truncated post body — ${String((e as Error)?.message ?? e)}`)
    return body.slice(0, 220)
  }
}

// Post copy (summarised into a visual concept, not passed through raw) +
// brand visual style, both folded into one prompt, with the no-text
// instruction always appended last regardless of brand. CRHQ gets its own
// concept system prompt (see CRHQ_CONCEPT_SYSTEM) — every other client is
// completely unaffected.
async function buildImagePrompt(postBody: string, visualStyle: string | null, client?: Record<string, any>): Promise<string> {
  const conceptSystem = wantsHeadlineOverlay(client ?? {}) ? CRHQ_CONCEPT_SYSTEM : DEFAULT_CONCEPT_SYSTEM
  const concept = await summariseToVisualConcept(postBody, conceptSystem)
  const style = String(visualStyle || '').trim()
  const parts = [concept, style, NO_TEXT_INSTRUCTION].filter(Boolean)
  return parts.join('. ')
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
function isQuillAlternatingStream(client: Record<string, any>, platform: string): boolean {
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
// excludeId matters exactly like facebookWantsImage's own warning: fill.ts
// calls this AFTER the new row is already inserted (with image_url still
// null), so without excluding contentQueueId itself, the query would find
// its own row as "most recent" and always answer true.
//
// Rejected posts are excluded because they never reach the platform, so they
// cannot be half of a 50/50 split of what people actually saw. Counting one
// inverts the toggle for the next real post — and rejections cluster on
// image posts, so the error is not evenly distributed.
async function quillAlternatingStreamWantsImage(admin: Admin, clientId: string, platform: string, excludeId: string): Promise<boolean> {
  const { data, error } = await admin
    .from('mkt_content_queue')
    .select('image_url')
    .eq('client_id', clientId).eq('platform', platform).eq('content_type', 'post')
    .neq('id', excludeId)
    .neq('status', 'rejected')
    .order('scheduled_for', { ascending: false })
    .limit(1)
  if (error) {
    // Fail closed — a lookup failure must not turn into an image on every
    // post. No image is the safe side of this decision.
    console.error(`[image] Quill ${platform} image alternation lookup failed (${error.message}) — defaulting to no image`)
    return false
  }
  const previous = data?.[0]
  if (!previous) return true // no history yet — start the cycle with an image
  return !previous.image_url
}

// Genuine Stability negative prompt (weight -1), not just prose in the
// positive prompt — added after the first round of test samples showed
// prose alone ("no human faces under any circumstances") wasn't reliably
// stopping Stability from rendering clear, recognisable faces, and one
// sample defaulted straight back to a control-room/wall-of-screens scene
// despite the positive prompt explicitly saying not to. Same gate as
// wantsHeadlineOverlay — CRHQ only.
const CRHQ_NEGATIVE_PROMPT = 'human face, human faces, visible eyes, close-up portrait, facial features, crowd of faces, photorealistic, photograph, press photograph, news photograph, real photo, colour, saturated colour, control room, operations room, security operations centre, wall of monitors, bank of screens, call center, office cubicles'

// TODO (scoping note, not built — deliberately deferred, see 2026-08-09
// CRHQ image-style overhaul): automated face-detection + regenerate-on-
// failure as a hard backstop, in case CRHQ_CONCEPT_SYSTEM + the negative
// prompt above don't hold up as reliably once run against the full spread
// of real CRHQ stories, not just the 3 that were manually reviewed clean.
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
// exists: flux-1.1-pro has NO negative-prompt parameter. Stability's
// CRHQ_NEGATIVE_PROMPT (weight -1) was the mechanism actually holding the
// no-faces rule, and it has no Flux equivalent — exclusions can only be
// written as prose in the positive prompt, which the code comment above
// CRHQ_NEGATIVE_PROMPT already records as having failed once. Prose rules are
// still sent (belt), but the backstop is what enforces them (braces).
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

async function measureImage(bytes: Uint8Array): Promise<ImageMeasurement> {
  // Chunked base64 — a spread/apply over a ~1.5MB image blows the call stack.
  let binary = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  const b64 = btoa(binary)

  const raw = await callAnthropicVision(IMAGE_REVIEW_SYSTEM, b64, 'Measure this image.', 1500)
  const match = raw.match(/\{[\s\S]*\}/)
  if (!match) throw new Error(`image review returned no JSON: ${raw.slice(0, 200)}`)
  return JSON.parse(match[0]) as ImageMeasurement
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
    })
    if (error) console.error(`[image] image_review_events insert failed: ${error.message}`)
  } catch (e) {
    console.error(`[image] image_review_events insert threw: ${String((e as Error)?.message ?? e)}`)
  }
}

// Escalating pressure on the rule that actually failed. Regenerating with an
// identical prompt is just another roll of the same dice.
const REVIEW_ESCALATION = {
  text: 'CRITICAL: the previous attempt rendered legible lettering. Every painted, printed or stencilled surface must be completely blank — plain unmarked metal, plain unmarked paper, plain unmarked fabric. Remove or turn away any hull, plate, sign or chart that could carry markings.',
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
async function checkStyleCompliance(bytes: Uint8Array, visualStyle: string): Promise<{ compliant: boolean; violation: string | null }> {
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
  const match = raw.match(/\{[\s\S]*\}/)
  if (!match) throw new Error(`style compliance check returned no JSON: ${raw.slice(0, 200)}`)
  return judgeStyleCompliance(JSON.parse(match[0]) as StyleComplianceResult)
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
  // but before any generation work starts.
  if (isQuillAlternatingStream(client, platform) && !(await quillAlternatingStreamWantsImage(admin, client.id, platform, contentQueueId))) {
    console.log(`[image] ${client.name}: skipping image for ${contentQueueId} — alternating (previous post had one)`)
    return
  }

  // Provider split: CRHQ on Flux (Replicate), everyone else on Stability.
  const useFlux = usesFluxProvider(client)
  const apiKey = useFlux ? Deno.env.get('REPLICATE_API_TOKEN') : Deno.env.get('STABILITY_AI_API_KEY')
  if (!apiKey) {
    console.error(`[image] ${client.name}: ${useFlux ? 'REPLICATE_API_TOKEN' : 'STABILITY_AI_API_KEY'} not set — skipping image for ${contentQueueId}`)
    return
  }

  const prompt = await buildImagePrompt(postBody, client.visual_style, client)

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
          await logImageReview(admin, client, contentQueueId, platform, attempt, 'error', [msg], null)
          continue
        }

        const { verdict, reasons } = judgeImageMeasurement(measurement)
        await logImageReview(admin, client, contentQueueId, platform, attempt, verdict, reasons, measurement)

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
          [`no attempt passed review after ${IMAGE_REVIEW_MAX_ATTEMPTS} tries — no image attached`], null)
        console.error(`[image] ${client.name}: all ${IMAGE_REVIEW_MAX_ATTEMPTS} attempts failed review for ${contentQueueId} — posting without an image`)
        return null
      }
        void lastBytes
        return accepted
      }

      const negativePrompt = wantsHeadlineOverlay(client) ? CRHQ_NEGATIVE_PROMPT : undefined
      return await callStabilityAI(attemptPrompt, apiKey, negativePrompt)
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

    for (let attempt = 1; attempt <= STYLE_REVIEW_MAX_ATTEMPTS; attempt++) {
      const attemptPrompt = lastViolation
        // Escalate on the rule that actually broke, same reasoning as
        // REVIEW_ESCALATION — regenerating with an identical prompt is another
        // roll of the same dice.
        ? `${prompt}\n\nCRITICAL: the previous attempt broke this brand's visual rules — ${lastViolation}. That is a hard prohibition, not a preference. Regenerate so it cannot recur.`
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
        await logImageReview(admin, client, contentQueueId, platform, attempt, 'error', [`style check error: ${msg}`], null)
        continue
      }

      await logImageReview(
        admin, client, contentQueueId, platform, attempt,
        verdict.compliant ? 'pass' : 'reject',
        [verdict.compliant ? 'visual_style compliant' : `STYLE ${verdict.violation}`],
        null,
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
        [`visual_style not met after ${STYLE_REVIEW_MAX_ATTEMPTS} attempts — no image attached`], null)
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
