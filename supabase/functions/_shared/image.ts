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
import { Image } from 'https://deno.land/x/imagescript@1.2.15/mod.ts'

// deno-lint-ignore no-explicit-any
type Admin = any

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

// TODO: Manual photography upload for CRHQ Instagram
// Craig supplies real photography that takes priority over
// AI-generated images. Needs: upload UI, 4:5 crop, storage path,
// and override flag on mkt_content_queue. Not yet implemented.
// Until then every CRHQ Instagram post gets an AI-generated image from
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
async function summariseToVisualConcept(postBody: string): Promise<string> {
  const body = String(postBody || '').replace(/\s+/g, ' ').trim()
  if (!body) return ''
  const system = 'You turn a social media post into a short, concrete visual scene description for an AI image generator. Describe ONE clear subject, setting, composition and mood that captures what the post is about. Never describe any text, quotes, numbers or words that should appear in the image — the image itself must never contain readable text. Reply with only the scene description, one or two sentences, no preamble, no quotation marks.'
  try {
    const concept = await callAnthropic(system, `Post:\n${body.slice(0, 1000)}`, 150)
    return concept.replace(/\s+/g, ' ').trim() || body.slice(0, 220)
  } catch (e) {
    console.error(`[image] visual-concept summary failed, falling back to truncated post body — ${String((e as Error)?.message ?? e)}`)
    return body.slice(0, 220)
  }
}

// Post copy (summarised into a visual concept, not passed through raw) +
// brand visual style, both folded into one prompt, with the no-text
// instruction always appended last regardless of brand.
async function buildImagePrompt(postBody: string, visualStyle: string | null): Promise<string> {
  const concept = await summariseToVisualConcept(postBody)
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
  console.error(`[image] ${client.name}: image generation disabled for platform "${platform}" — ${reason}`)
}

interface StabilityArtifact { base64: string; finishReason: string }

async function callStabilityAI(prompt: string, apiKey: string): Promise<Uint8Array> {
  const res = await fetch(`https://api.stability.ai/v1/generation/${STABILITY_ENGINE_ID}/text-to-image`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      text_prompts: [{ text: prompt, weight: 1 }],
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
  // CRHQ is configured Instagram-only. Checked before the deny-list below
  // because it's deliberate configuration, whereas the deny-list is the
  // automatic post-failure kill-switch.
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

  const apiKey = Deno.env.get('STABILITY_AI_API_KEY')
  if (!apiKey) {
    console.error(`[image] ${client.name}: STABILITY_AI_API_KEY not set — skipping image for ${contentQueueId}`)
    return
  }

  const prompt = await buildImagePrompt(postBody, client.visual_style)

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
    const rawBytes = await callStabilityAI(prompt, apiKey)
    const bytes = await resizeForPlatform(rawBytes, platform)

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
