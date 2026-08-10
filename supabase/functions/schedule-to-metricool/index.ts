// Supabase Edge Function: schedule-to-metricool  (Deno)
// Fired when a post is approved. Schedules it to Metricool at the client's next slot.
// Invoke: supabase.functions.invoke('schedule-to-metricool', { body: { content_queue_id } })
//
// CRHQ / multi-platform check: mkt_content_queue.platform is one value per
// row (schema: text, not an array), and this function correctly builds
// `providers` from that one row's platform. CRHQ was "only posting to
// Facebook" not because this call was wrong, but because fillClientGap
// (_shared/fill.ts) only ever generated a row for platforms[0] — Instagram
// never got a row to schedule in the first place. That's now fixed upstream
// in fill.ts, which loops every connected platform (facebook AND instagram
// for CRHQ), so both now flow through this same single-platform-per-call
// path unchanged — exactly how every other (currently single-platform)
// brand is already handled. No change needed here.
//
// Deploy:  supabase functions deploy schedule-to-metricool
// Secrets (Supabase vault): METRICOOL_API_KEY
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
const DOW = { Sunday: 0, Monday: 1, Tuesday: 2, Wednesday: 3, Thursday: 4, Friday: 5, Saturday: 6 }

const METRICOOL_USER_ID = '4984082'

const PLATFORM_MAP: Record<string, string> = {
  facebook:  'facebook',
  instagram: 'instagram',
  linkedin:  'linkedin',
  twitter:   'twitter',
}

// Best-effort — persists why a post failed so the dashboard's "Failed to
// schedule" view can show a reason. Never throws; a write failure here must
// not mask the original error being returned to the caller.
async function markFailed(admin: ReturnType<typeof createClient>, id: string, message: string) {
  const { error } = await admin.from('mkt_content_queue').update({ error_message: message }).eq('id', id)
  if (error) console.error('[schedule-to-metricool] Failed to persist error_message:', error.message)
}

// Cross-function error log (see generate-daily-status's
// edge_function_errors_last_24h) — called alongside every markFailed above,
// plus the top-level catch, so every failure branch of this function is
// visible there, not just the ones that also touch mkt_content_queue.
async function logEdgeError(admin: ReturnType<typeof createClient>, message: string) {
  const { error } = await admin.from('edge_function_errors').insert({ function_name: 'schedule-to-metricool', error_message: message })
  if (error) console.error('[schedule-to-metricool] Failed to write edge_function_errors:', error.message)
}

function nextSlot(postDays: string[], postTime: string | null): Date {
  const now = new Date()
  const [hh, mm] = (postTime || '09:00').split(':').map(Number)
  const targets = (postDays || []).map((d) => DOW[d as keyof typeof DOW]).filter((n) => n != null)
  if (targets.length === 0) {
    const d = new Date(now); d.setDate(d.getDate() + 1); d.setHours(hh, mm || 0, 0, 0); return d
  }
  for (let i = 0; i < 14; i++) {
    const d = new Date(now); d.setDate(now.getDate() + i); d.setHours(hh, mm || 0, 0, 0)
    if (targets.includes(d.getDay()) && d > now) return d
  }
  const d = new Date(now); d.setDate(d.getDate() + 1); d.setHours(hh, mm || 0, 0, 0); return d
}

serve(async (req) => {
  const json = (b: unknown, s = 200) =>
    new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } })
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })

  try {
    const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
    const userClient = createClient(SUPABASE_URL, Deno.env.get('SUPABASE_ANON_KEY')!, {
      global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } },
    })
    const { data: isAdmin } = await userClient.rpc('mkt_is_admin')
    if (isAdmin !== true) return json({ error: 'Not authorised' }, 403)

    const { content_queue_id, scheduled_for } = await req.json()
    if (!content_queue_id) return json({ error: 'content_queue_id required' }, 400)

    const admin = createClient(SUPABASE_URL, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
    const { data: item, error: iErr } = await admin
      .from('mkt_content_queue').select('*, client:mkt_clients(*)').eq('id', content_queue_id).single()
    if (iErr || !item) return json({ error: 'Content item not found' }, 404)

    const client = item.client

    // LinkedIn personal-profile-vs-company-page routing: Metricool's
    // /v2/scheduler/posts request body has no field for this — the
    // "providers: [{ network: 'linkedin' }]" shape below is identical for
    // both. The distinction is made entirely by which single LinkedIn
    // account (personal or company page) is connected to the target
    // blogId in the Metricool dashboard — Metricool allows only ONE
    // LinkedIn connection per brand, of either type, not both. So the only
    // way to route Adrian's personal posts and Quill's company-page posts
    // correctly is via metricool_brand_id: two different mkt_clients rows,
    // each pointing at a Metricool brand whose LinkedIn connection matches
    // that row's intent. Verified live (7 Aug 2026): Adrian Fielding —
    // LinkedIn uses blogId 6648946 (personal profile, its own brand) and
    // Quill — LinkedIn uses blogId 6469945 (Quill's main brand, same blogId
    // as Quill's Facebook page — fine, since one brand can hold one
    // connection per DIFFERENT network type — its LinkedIn connection was
    // activated as the company page in migration 86). If a future LinkedIn
    // client is ever added sharing a blogId with an existing LinkedIn
    // client here, that's the bug to look for — not this API call.
    const brandId = client?.metricool_brand_id
    if (!brandId) {
      const msg = `No Metricool brand ID set for client "${client?.name}".`
      await markFailed(admin, item.id, msg)
      await logEdgeError(admin, msg)
      return json({ error: msg }, 422)
    }

    const networkKey = PLATFORM_MAP[item.platform]
    if (!networkKey) {
      const msg = `Unsupported platform "${item.platform}" — expected: ${Object.keys(PLATFORM_MAP).join(', ')}`
      await markFailed(admin, item.id, msg)
      await logEdgeError(admin, msg)
      return json({ error: msg }, 422)
    }

    const chosen = scheduled_for || item.scheduled_for
    const chosenDate = chosen ? new Date(chosen) : null
    const slot = (chosenDate && !isNaN(chosenDate.getTime()) && chosenDate > new Date())
      ? chosenDate
      : nextSlot(client.post_days, client.post_time)

    // Issue 6: reject if the resolved slot is in the past.
    if (slot <= new Date()) {
      const msg = 'Scheduled time has passed — please reschedule before retrying.'
      await markFailed(admin, item.id, msg)
      await logEdgeError(admin, msg)
      return json({ error: msg }, 422)
    }

    const apiKey = Deno.env.get('METRICOOL_API_KEY')
    if (!apiKey) {
      const msg = 'METRICOOL_API_KEY not configured in Supabase vault'
      await markFailed(admin, item.id, msg)
      await logEdgeError(admin, msg)
      return json({ error: msg }, 500)
    }

    const dateTimeStr = slot.toISOString().slice(0, 19)

    // AI-generated cover image (fill.ts / _shared/image.ts) — attached when
    // present. NOTE: Metricool's public v2 scheduler docs weren't reachable
    // from this environment to confirm the exact media field name/shape, and
    // nothing in this codebase previously attached media to a Metricool post
    // to copy from — `media` as an array of URL strings is Metricool's
    // documented field for this as of last verification. If posts stop
    // getting their image, check this first against the current API docs.
    const requestBody: Record<string, unknown> = {
      text: item.body,
      publicationDate: { dateTime: dateTimeStr, timezone: 'Europe/London' },
      providers: [{ network: networkKey }],
      autoPublish: true,
    }
    // Facebook posts go out as text only until further notice — images are
    // still generated for every platform (fill.ts / _shared/image.ts), just
    // never attached to the Metricool call when the target is Facebook.
    // Instagram (and any other connected platform) is unaffected.
    //
    // Two exceptions: CRHQ, and now Quill (2026-08-10, Facebook/LinkedIn
    // 50/50 image test — with vs without AI artwork). Both brands' Facebook
    // streams now carry an image on every other post (CRHQ in
    // crhq-nightly-content; Quill via _shared/image.ts's generalised
    // alternation, see isQuillAlternatingStream), and this function builds
    // the only Metricool payload in the repo — so without this carve-out
    // those images would be generated, stored and paid for but never
    // actually reach Facebook. Scoped by slug so the text-only rule still
    // stands for every other brand.
    const facebookTextOnly = item.platform === 'facebook' && client?.slug !== 'crhq' && client?.slug !== 'quill'
    if (item.image_url && !facebookTextOnly) requestBody.media = [item.image_url]

    // Issue 8: if metricool_post_id already exists, PATCH the existing post
    // rather than creating a duplicate.
    const existingPostId = item.metricool_post_id
    const method = existingPostId ? 'PATCH' : 'POST'
    const url = existingPostId
      ? `https://app.metricool.com/api/v2/scheduler/posts/${existingPostId}?userId=${METRICOOL_USER_ID}&blogId=${brandId}`
      : `https://app.metricool.com/api/v2/scheduler/posts?userId=${METRICOOL_USER_ID}&blogId=${brandId}`

    console.log('[schedule-to-metricool] PRE-REQUEST DIAGNOSTIC:')
    console.log('  method:', method, existingPostId ? `(updating post ${existingPostId})` : '(creating new)')
    console.log('  API key prefix (first 8 chars):', apiKey.slice(0, 8))
    console.log('  URL:', url)
    console.log('  Headers: { X-Mc-Auth: <masked>, Content-Type: application/json }')
    console.log('  Body:', JSON.stringify(requestBody))

    // Issue 2: wrap the fetch in its own try/catch so the response is always
    // logged before the function exits, even on network-level failures.
    let mRes: Response
    let mRaw: string
    let mData: unknown
    try {
      mRes = await fetch(url, {
        method,
        headers: { 'X-Mc-Auth': apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
      })
      mRaw = await mRes.text()
      try { mData = JSON.parse(mRaw) } catch { mData = mRaw }
      console.log(`[schedule-to-metricool] Metricool response ${mRes.status}:`, JSON.stringify(mData))
    } catch (fetchErr) {
      const msg = String((fetchErr as Error)?.message ?? fetchErr)
      console.error('[schedule-to-metricool] Network error calling Metricool:', msg)
      await markFailed(admin, item.id, 'Network error calling Metricool: ' + msg)
      await logEdgeError(admin, 'Network error calling Metricool: ' + msg)
      return json({ error: 'Network error calling Metricool: ' + msg }, 502)
    }

    if (!mRes.ok) {
      console.error(`[schedule-to-metricool] Metricool ${mRes.status} rejected post for "${client?.name}" (${item.platform})`)
      const detailStr = typeof mData === 'string' ? mData : JSON.stringify(mData)
      const msg = `Metricool rejected the post (${mRes.status}): ${detailStr}`.slice(0, 500)
      await markFailed(admin, item.id, msg)
      await logEdgeError(admin, msg)
      return json({ error: 'Metricool rejected the post.', status: mRes.status, detail: mData }, 502)
    }

    // Issue 9: the previous top-level-only `.id ?? .postId` lookup was always
    // coming up empty (every one of the 27 historically "scheduled" rows has
    // metricool_post_id = NULL despite mRes.ok being true) — Metricool's
    // actual success body isn't shaped the way that assumed. Widened to also
    // check a nested `.data` object and the first element if the body is an
    // array, and logs the raw keys seen on success so a future shape change
    // is diagnosable from the logs instead of silently swallowed again.
    const bodyObj = (mData && typeof mData === 'object') ? (mData as Record<string, unknown>) : null
    const nested = (bodyObj?.data && typeof bodyObj.data === 'object') ? (bodyObj.data as Record<string, unknown>) : null
    const firstOfArray = Array.isArray(mData) && mData.length > 0 && typeof mData[0] === 'object' ? (mData[0] as Record<string, unknown>) : null
    const metricoolPostId = (bodyObj?.id ?? bodyObj?.postId ?? nested?.id ?? nested?.postId ?? firstOfArray?.id ?? firstOfArray?.postId ?? existingPostId ?? null) as string | number | null
    if (metricoolPostId == null) {
      console.error('[schedule-to-metricool] Metricool returned 2xx but no post id could be extracted. Response keys:', bodyObj ? Object.keys(bodyObj) : typeof mData, 'Full body:', mRaw.slice(0, 1000))
    }

    // Issue 1: log any DB update failures rather than silently ignoring them.
    const { error: updateErr } = await admin.from('mkt_content_queue')
      .update({ status: 'scheduled', scheduled_for: slot.toISOString(), metricool_post_id: metricoolPostId, error_message: null })
      .eq('id', item.id)
    if (updateErr) console.error('[schedule-to-metricool] Failed to update mkt_content_queue:', updateErr.message)

    // Upsert to mkt_scheduled_posts to avoid duplicate-key errors on retry.
    const { error: upsertErr } = await admin.from('mkt_scheduled_posts').upsert({
      client_id: item.client_id, content_queue_id: item.id, platform: item.platform,
      body: item.body, scheduled_for: slot.toISOString(), metricool_post_id: metricoolPostId, status: 'scheduled',
    }, { onConflict: 'content_queue_id' })
    if (upsertErr) console.error('[schedule-to-metricool] Failed to upsert mkt_scheduled_posts:', upsertErr.message)

    // Item 4 — published posts log. Metricool has accepted the post (real post
    // id above) with autoPublish on, which is the strongest "it will be sent"
    // confirmation this integration gets (Metricool has no delivery webhook
    // back to us). Log it with date_sent = the scheduled send time; the
    // Published tab only surfaces rows whose date_sent has passed, and the
    // review step's repeat-topic check reads this log. Upsert on
    // content_queue_id so a reschedule/retry updates rather than duplicates.
    const { error: pubErr } = await admin.from('published_posts').upsert({
      client_id: item.client_id, brand: client?.name ?? 'Unknown',
      date_sent: slot.toISOString(), platform: item.platform,
      content_pillar: item.pillar ?? null, post_copy: item.body,
      metricool_post_id: metricoolPostId, content_queue_id: item.id,
    }, { onConflict: 'content_queue_id' })
    if (pubErr) console.error('[schedule-to-metricool] Failed to upsert published_posts:', pubErr.message)

    return json({ scheduled_for: slot.toISOString(), metricool_post_id: metricoolPostId })
  } catch (e) {
    const message = String((e as Error)?.message ?? e)
    console.error('[schedule-to-metricool] Unhandled error:', message)
    try {
      const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
      await logEdgeError(admin, message)
    } catch (logErr) {
      console.error('[schedule-to-metricool] Failed to write edge_function_errors:', String((logErr as Error)?.message ?? logErr))
    }
    return json({ error: message }, 500)
  }
})
