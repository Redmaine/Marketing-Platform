// Supabase Edge Function: upload-reel  (Deno)
//
// v1 of the CRHQ Instagram Reels pipeline. Craig/Adrian pick the moment AND
// export it vertically themselves (CapCut / YouTube Studio — a checkbox and a
// few seconds). This takes that clip and does the rest:
//   1. store the raw clip in Supabase Storage (public URL)
//   2. create a mkt_content_queue row (content_type 'reel', status 'draft')
//   3. burn in word-synced captions via Replicate's fictions-ai/autocaption
//   4. store the captioned result and write video_url back
//
// The row then sits in the SAME approval queue as every other piece of CRHQ
// content — no separate review path — and is scheduled by the existing
// schedule-to-metricool once approved.
//
// Deliberately NOT here: horizontal->vertical cropping. Video transcoding
// cannot run in an Edge Function (2s CPU / 256MB hard limits), and building
// it elsewhere is disproportionate to the manual export it replaces. See
// _shared/reels.ts's header.
//
// Invoke (admin JWT, or cron/service-role for scripted use):
//   POST { client_slug, video_base64, content_type, body, scheduled_for? }
//
// Deploy: supabase functions deploy upload-reel
// Secrets: REPLICATE_API_TOKEN (already set — same one the CRHQ image
//          pipeline's Flux calls use).
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { cors, json } from '../_shared/cors.ts'
import { checkCronAuth } from '../_shared/cronAuth.ts'
import { uploadSourceClip, captionQueuedReel, MAX_VIDEO_BYTES, ALLOWED_VIDEO_TYPES } from '../_shared/reels.ts'

// deno-lint-ignore no-explicit-any
type Admin = any

// base64 -> bytes without a spread/apply over the whole payload, which blows
// the call stack on a multi-MB video (the same chunking image.ts already does
// in the other direction for its vision calls).
function base64ToBytes(b64: string): Uint8Array {
  const clean = b64.replace(/^data:[^,]+,/, '')
  const bin = atob(clean)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'POST') return json({ ok: false, error: 'method not allowed' }, 405)

  const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
  const admin: Admin = createClient(SUPABASE_URL, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)

  // Admin-gate on the caller's own JWT, falling back to cron/service-role for
  // scripted invocation — same dual pattern regenerate-post-image uses.
  const userClient = createClient(SUPABASE_URL, Deno.env.get('SUPABASE_ANON_KEY')!, {
    global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } },
  })
  const { data: isAdmin } = await userClient.rpc('mkt_is_admin')
  if (isAdmin !== true) {
    const auth = await checkCronAuth(req, 'upload-reel')
    if (!auth.authorised) return json({ ok: false, error: 'unauthorised' }, 401)
  }

  let payload: Record<string, unknown>
  try {
    payload = await req.json()
  } catch {
    return json({ ok: false, error: 'invalid JSON body' }, 400)
  }

  const clientSlug = String(payload.client_slug ?? '').trim()
  const contentType = String(payload.content_type ?? 'video/mp4')
  const bodyText = String(payload.body ?? '').trim()
  const videoBase64 = String(payload.video_base64 ?? '')

  if (!clientSlug) return json({ ok: false, error: 'client_slug is required' }, 400)
  if (!videoBase64) return json({ ok: false, error: 'video_base64 is required' }, 400)
  if (!bodyText) return json({ ok: false, error: 'body (the caption/post copy) is required' }, 400)
  if (!ALLOWED_VIDEO_TYPES.includes(contentType)) {
    return json({ ok: false, error: `content_type must be one of ${ALLOWED_VIDEO_TYPES.join(', ')}` }, 400)
  }

  const { data: client, error: clientErr } = await admin
    .from('mkt_clients')
    .select('id, name, slug, connected_platforms')
    .eq('slug', clientSlug)
    .maybeSingle()
  if (clientErr) return json({ ok: false, error: `client lookup failed: ${clientErr.message}` }, 500)
  if (!client) return json({ ok: false, error: `no client with slug "${clientSlug}"` }, 404)

  // A Reel is an Instagram artefact. Refusing here rather than discovering it
  // at schedule time keeps the failure next to the human who can fix it.
  const connected: string[] = Array.isArray(client.connected_platforms) ? client.connected_platforms : []
  if (!connected.includes('instagram')) {
    return json({ ok: false, error: `${client.name} has no Instagram connection — cannot queue a Reel` }, 400)
  }

  let bytes: Uint8Array
  try {
    bytes = base64ToBytes(videoBase64)
  } catch (e) {
    return json({ ok: false, error: `could not decode video_base64: ${String((e as Error)?.message ?? e)}` }, 400)
  }
  if (bytes.byteLength > MAX_VIDEO_BYTES) {
    return json({ ok: false, error: `clip is ${(bytes.byteLength / 1048576).toFixed(1)}MB — over the ${MAX_VIDEO_BYTES / 1048576}MB limit` }, 400)
  }

  const token = Deno.env.get('REPLICATE_API_TOKEN')
  if (!token) return json({ ok: false, error: 'REPLICATE_API_TOKEN not configured' }, 500)

  // Row first, so the clip and every later artefact are keyed to a real id.
  // status 'draft' + review_status 'passed': the copy is human-written here,
  // so there is no generated text to review — but it still lands in the same
  // approval queue as everything else and still needs a human approval before
  // schedule-to-metricool will touch it.
  const row: Record<string, unknown> = {
    client_id: client.id,
    platform: 'instagram',
    content_type: 'reel',
    body: bodyText,
    status: 'draft',
    review_status: 'passed',
    // 'human' — the real, existing enum value (constraint allows ai|human|cron),
    // not a new one invented for Reels. Correct on the merits too: the copy is
    // human-written, and fill.ts's hasAutoPostOnDate counts only ai|cron, so a
    // Reel does not consume the brand's one-auto-post-per-day slot.
    generated_by: 'human',
    is_manual: true,
    caption_status: 'pending',
  }
  if (payload.scheduled_for) row.scheduled_for = payload.scheduled_for
  if (payload.pillar) row.pillar = payload.pillar

  const { data: inserted, error: insertErr } = await admin
    .from('mkt_content_queue').insert(row).select('id').single()
  if (insertErr) return json({ ok: false, error: `queue insert failed: ${insertErr.message}` }, 500)
  const contentQueueId = inserted.id as string

  let sourceUrl: string
  try {
    const uploaded = await uploadSourceClip(admin, client.slug, contentQueueId, bytes, contentType)
    sourceUrl = uploaded.publicUrl
    await admin.from('mkt_content_queue').update({ source_video_url: sourceUrl }).eq('id', contentQueueId)
  } catch (e) {
    const msg = String((e as Error)?.message ?? e)
    await admin.from('mkt_content_queue')
      .update({ caption_status: 'failed', caption_error: `source upload: ${msg}`.slice(0, 500) })
      .eq('id', contentQueueId)
    return json({ ok: false, content_queue_id: contentQueueId, error: `source upload failed: ${msg}` }, 500)
  }

  try {
    const { videoUrl } = await captionQueuedReel(admin, client.slug, contentQueueId, sourceUrl, token)
    return json({
      ok: true,
      content_queue_id: contentQueueId,
      source_video_url: sourceUrl,
      video_url: videoUrl,
      status: 'draft',
      note: 'Queued as a draft Reel. It needs the same human approval as any other post before it will be scheduled.',
    })
  } catch (e) {
    // The row survives with the source clip and a real caption_error, so this
    // is retryable without a re-upload — and is visibly NOT ready to post.
    return json({
      ok: false,
      content_queue_id: contentQueueId,
      source_video_url: sourceUrl,
      error: `captioning failed: ${String((e as Error)?.message ?? e)}`,
      note: 'The source clip is stored and the queue row is marked caption_status=failed. Retry captioning without re-uploading.',
    }, 500)
  }
})
