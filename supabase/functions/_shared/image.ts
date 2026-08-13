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

import { callAnthropic } from './generate.ts'
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
const CRHQ_CONCEPT_SYSTEM = 'You turn a social media post into a short, concrete visual scene description for an AI image generator that will render it in an editorial ink-wash illustration style — never photorealistic. Describe ONE clear setting, composition and mood that captures what the post is about, drawing from a wide range of possible settings (coastal and maritime, government or parliamentary buildings, outdoor and field locations, city streets, courtrooms, transport and infrastructure, or an interior only when it is genuinely the best fit) — do not default to an office, briefing room, or security operations centre unless the story is unambiguously about that exact thing. Critically: never describe a person\'s face, expression, or a close-up or portrait of a person — no "a man reading," no "an official looking concerned," nothing that puts a human face in frame. If a human presence belongs in the scene, describe it only as a distant figure, a silhouette, hands, or a figure seen from behind — never facial detail. Prefer scenes built around objects, architecture, landscape or symbolic detail over scenes built around a person. Never describe any text, quotes, numbers or words that should appear in the image. Reply with only the scene description, one or two sentences, no preamble, no quotation marks.'

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
async function quillAlternatingStreamWantsImage(admin: Admin, clientId: string, platform: string, excludeId: string): Promise<boolean> {
  const { data, error } = await admin
    .from('mkt_content_queue')
    .select('image_url')
    .eq('client_id', clientId).eq('platform', platform).eq('content_type', 'post')
    .neq('id', excludeId)
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

  const apiKey = Deno.env.get('STABILITY_AI_API_KEY')
  if (!apiKey) {
    console.error(`[image] ${client.name}: STABILITY_AI_API_KEY not set — skipping image for ${contentQueueId}`)
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
    const negativePrompt = wantsHeadlineOverlay(client) ? CRHQ_NEGATIVE_PROMPT : undefined
    const rawBytes = await callStabilityAI(prompt, apiKey, negativePrompt)
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
