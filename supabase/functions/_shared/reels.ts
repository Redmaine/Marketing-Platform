// CRHQ Instagram Reels — v1 shared logic (upload + captioning).
//
// SCOPE, deliberately narrow. Craig/Adrian supply an ALREADY-VERTICAL clip
// (15-45s). This module does NOT crop, reframe or transcode: video
// transcoding cannot run in a Supabase Edge Function at all (hard limits of
// 2s CPU and 256MB memory — transcoding is almost pure CPU), and building it
// elsewhere (Netlify+ffmpeg, or a paid video API) is disproportionate to a
// few seconds of manual work in CapCut or YouTube Studio's own export.
//
// What it DOES do reuses paths already proven in this codebase:
//   - Supabase Storage public URLs, exactly as _shared/image.ts does for
//     generated images (same 'mkt-assets' bucket, same slug-named folder).
//   - Replicate async submit->poll, exactly as image.ts's callFlux does. The
//     heavy work runs on Replicate's GPU; this function only does HTTP and
//     waiting, which is I/O and so does not count against the 2s CPU limit.
//
// The captioning model is fictions-ai/autocaption: it transcribes and burns
// in word-synced captions in one step (~27s on an L40S, ~$0.026/run).
// Confirmed to exist and to take a video in / captioned video out.

// deno-lint-ignore no-explicit-any
type Admin = any

const BUCKET = 'mkt-assets'

// Community models must be run through /v1/predictions with an explicit
// version hash. The /v1/models/{owner}/{name}/predictions shortcut that
// image.ts's callFlux uses works ONLY for Replicate's official models
// (flux-1.1-pro is one) — pointing it at this model returns a bare 404, which
// is exactly what the first real end-to-end run hit.
const AUTOCAPTION_PREDICTIONS_URL = 'https://api.replicate.com/v1/predictions'

// Pinned deliberately, not floating. A bare model reference lets Replicate
// change the output from under us silently — the same class of problem as an
// unpinned dependency, and far harder to notice when the artefact is a video
// a human only glances at. Resolved live from Replicate's own API on
// 1 Sep 2026. To upgrade: GET /v1/models/fictions-ai/autocaption, take
// latest_version.id, and re-verify a real clip before switching.
const AUTOCAPTION_VERSION = '18a45ff0d95feb4449d192bbdc06b4a6df168fa33def76dfc51b78ae224b599b'

// Autocaption's own typical run is ~27s; this is a generous ceiling for a
// cold start plus a longer clip, still well inside the Edge Function wall
// clock (150s free / 400s paid). Polling is I/O, so the 2s CPU cap is not
// the binding constraint here — wall clock is.
const CAPTION_POLL_TIMEOUT_MS = 240_000
const CAPTION_POLL_INTERVAL_MS = 3000

// Guardrails on what a human may upload. Not arbitrary:
//   - 45s is the stated upper bound of the clip format; Reels allow longer
//     but this pipeline is scoped to short repurposed cuts.
//   - 100MB keeps the download->upload round trip comfortably inside the
//     256MB Edge Function memory limit, since the file is held in memory
//     between fetching it from Replicate and writing it to Storage.
export const MAX_VIDEO_BYTES = 100 * 1024 * 1024
export const ALLOWED_VIDEO_TYPES = ['video/mp4', 'video/quicktime']

export interface UploadedClip {
  publicUrl: string
  path: string
  bytes: number
  contentType: string
}

// Stores the raw supplied clip and returns its public URL. Mirrors image.ts's
// upload step: same bucket, same brand-slug folder, upsert:true so a re-upload
// for the same queue row replaces cleanly rather than 409-ing.
export async function uploadSourceClip(
  admin: Admin,
  clientSlug: string,
  contentQueueId: string,
  bytes: Uint8Array,
  contentType: string,
): Promise<UploadedClip> {
  if (!ALLOWED_VIDEO_TYPES.includes(contentType)) {
    throw new Error(`unsupported video type "${contentType}" — allowed: ${ALLOWED_VIDEO_TYPES.join(', ')}`)
  }
  if (bytes.byteLength === 0) throw new Error('uploaded clip is empty (0 bytes)')
  if (bytes.byteLength > MAX_VIDEO_BYTES) {
    throw new Error(`clip is ${(bytes.byteLength / 1048576).toFixed(1)}MB — over the ${MAX_VIDEO_BYTES / 1048576}MB limit`)
  }

  const ext = contentType === 'video/quicktime' ? 'mov' : 'mp4'
  const path = `${clientSlug || 'unknown-brand'}/reels/${contentQueueId}-source.${ext}`
  const { error } = await admin.storage.from(BUCKET).upload(path, bytes, { contentType, upsert: true })
  if (error) throw new Error(`source clip upload failed: ${error.message}`)

  const { data } = admin.storage.from(BUCKET).getPublicUrl(path)
  if (!data?.publicUrl) throw new Error('source clip uploaded but no public URL was returned')
  return { publicUrl: data.publicUrl, path, bytes: bytes.byteLength, contentType }
}

// Submits the clip to autocaption and polls to completion. Returns the
// captioned video's Replicate URL. Throws (never returns a partial or a
// silently-unprocessed original) so a caller can record a real failure —
// attaching an UNcaptioned clip while reporting success would be exactly the
// silent-wrong-output failure this codebase has been bitten by elsewhere.
export async function generateCaptionedVideo(sourceUrl: string, token: string): Promise<string> {
  const submit = await fetch(AUTOCAPTION_PREDICTIONS_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      version: AUTOCAPTION_VERSION,
      input: {
        video_file_input: sourceUrl,
        // The model's own schema documents these two as the Reels-appropriate
        // values ("4.0 is good for reels", "10 is good for reels"); its
        // defaults (7.0 / 20) are tuned for landscape video and produce
        // oversized, over-wide caption lines on a 9:16 frame.
        fontsize: 4.0,
        MaxChars: 10,
        output_video: true,
        // We only want the burned-in video; the editable transcript JSON is
        // a second artefact this pipeline has nothing to do with.
        output_transcript: false,
      },
    }),
  })
  if (!submit.ok) {
    throw new Error(`Replicate autocaption submit ${submit.status}: ${(await submit.text()).slice(0, 400)}`)
  }
  const prediction = await submit.json()
  const id = prediction?.id
  if (!id) throw new Error('Replicate autocaption returned no prediction id')

  const deadline = Date.now() + CAPTION_POLL_TIMEOUT_MS
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, CAPTION_POLL_INTERVAL_MS))
    const res = await fetch(`https://api.replicate.com/v1/predictions/${id}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    if (!res.ok) throw new Error(`Replicate autocaption poll ${res.status}`)
    const p = await res.json()
    if (p.status === 'succeeded') {
      const out = p.output
      const url = typeof out === 'string' ? out : Array.isArray(out) ? out[0] : null
      if (!url) throw new Error('Replicate autocaption succeeded but returned no video URL')
      return String(url)
    }
    if (p.status === 'failed' || p.status === 'canceled') {
      throw new Error(`Replicate autocaption ${p.status}: ${String(p.error ?? 'unknown').slice(0, 300)}`)
    }
  }
  throw new Error(`Replicate autocaption timed out after ${CAPTION_POLL_TIMEOUT_MS / 1000}s`)
}

// Copies the captioned result into our own Storage. NOT optional: Replicate's
// output URLs are temporary, so attaching one directly to a scheduled post
// would work in a same-day test and then 404 by the time Metricool actually
// publishes it — a failure that would look fine in every check made on the
// day it was built.
export async function storeCaptionedVideo(
  admin: Admin,
  clientSlug: string,
  contentQueueId: string,
  replicateUrl: string,
): Promise<string> {
  const res = await fetch(replicateUrl)
  if (!res.ok) throw new Error(`fetching captioned video from Replicate failed: ${res.status}`)
  const bytes = new Uint8Array(await res.arrayBuffer())
  if (bytes.byteLength === 0) throw new Error('captioned video came back empty (0 bytes)')

  const path = `${clientSlug || 'unknown-brand'}/reels/${contentQueueId}.mp4`
  const { error } = await admin.storage.from(BUCKET).upload(path, bytes, {
    contentType: 'video/mp4',
    upsert: true,
  })
  if (error) throw new Error(`captioned video upload failed: ${error.message}`)

  const { data } = admin.storage.from(BUCKET).getPublicUrl(path)
  if (!data?.publicUrl) throw new Error('captioned video uploaded but no public URL was returned')
  return data.publicUrl
}

// Full caption step for one queue row: submit -> poll -> store -> write back.
// Records real state at every stage so a stall is distinguishable from a
// failure, and a failure states why.
export async function captionQueuedReel(
  admin: Admin,
  clientSlug: string,
  contentQueueId: string,
  sourceUrl: string,
  token: string,
): Promise<{ videoUrl: string }> {
  await admin.from('mkt_content_queue')
    .update({ caption_status: 'processing', caption_error: null })
    .eq('id', contentQueueId)

  try {
    const replicateUrl = await generateCaptionedVideo(sourceUrl, token)
    const videoUrl = await storeCaptionedVideo(admin, clientSlug, contentQueueId, replicateUrl)
    const { error } = await admin.from('mkt_content_queue')
      .update({ video_url: videoUrl, caption_status: 'complete', caption_error: null })
      .eq('id', contentQueueId)
    if (error) throw new Error(`writing video_url back failed: ${error.message}`)
    return { videoUrl }
  } catch (e) {
    const msg = String((e as Error)?.message ?? e)
    // video_url deliberately left null — a row must never look ready to post
    // when captioning did not actually produce anything.
    await admin.from('mkt_content_queue')
      .update({ caption_status: 'failed', caption_error: msg.slice(0, 500) })
      .eq('id', contentQueueId)
    throw e
  }
}
