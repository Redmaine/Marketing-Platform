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

// deno-lint-ignore no-explicit-any
type Admin = any

const STABILITY_ENGINE_ID = 'stable-diffusion-xl-1024-v1-0'
const IMAGE_SIZE = 1024

// Post copy + brand visual style, both folded into one prompt. Truncated to a
// short summary rather than the full post — Stability's prompt field is
// meant for a scene description, not a wall of marketing copy — and a
// clean/no-text steer is added since every visual_style entry already reads
// as a clean background/illustration brief, never a request for on-image copy.
function buildImagePrompt(postBody: string, visualStyle: string | null): string {
  const summary = String(postBody || '').replace(/\s+/g, ' ').trim().slice(0, 220)
  const style = String(visualStyle || '').trim()
  const parts = [summary, style, 'no text, no words, no letters, no logos'].filter(Boolean)
  return parts.join('. ')
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

  const prompt = buildImagePrompt(postBody, client.visual_style)

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
    const bytes = await callStabilityAI(prompt, apiKey)

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
