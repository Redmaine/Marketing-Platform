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
import { checkCronAuth } from '../_shared/cronAuth.ts'
import { platformSchedule } from '../_shared/platformSchedule.ts'

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
const DOW = { Sunday: 0, Monday: 1, Tuesday: 2, Wednesday: 3, Thursday: 4, Friday: 5, Saturday: 6 }

// Case-insensitive view of DOW. mkt_clients.post_days is free text and brands
// genuinely differ: CRHQ stores lowercase ("monday"), everyone else stores
// capitalised ("Monday"). The original exact-match lookup silently dropped
// every lowercase day, leaving the day list empty — see nextSlot below.
const DOW_LOWER: Record<string, number> = Object.fromEntries(
  Object.entries(DOW).map(([name, n]) => [name.toLowerCase(), n]),
)

const METRICOOL_USER_ID = '4984082'

// The standing AI-image disclosure line appended to CRHQ posts that carry a
// generated image. Deliberately plain and factual: CRHQ is a defence and
// current-affairs commentary account, so the disclosure has to read as a
// straight statement of fact rather than a marketing flourish or an apology.
// "Illustration" rather than "Image" because that is what these actually are
// — they accompany the commentary, they are not documentary evidence of it,
// and on a defence account that distinction is worth drawing explicitly.
// Short enough (27 characters) not to meaningfully eat caption space on
// either network.
//
// Scope: CRHQ captions only, for now. The provenance metadata marker in
// _shared/image.ts is separate and applies portfolio-wide — every generated
// image carries it, whatever the brand. Whether the other brands should also
// carry a visible caption line is open, and deliberately left open.
const AI_IMAGE_DISCLOSURE = 'Illustration: AI-generated.'

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

// Picks the slot for a post whose own scheduled_for is missing or already in
// the past.
//
// Fix (18 Aug 2026) — this used to take only the client-wide
// mkt_clients.post_days / post_time and never saw `platform` at all, so every
// platform for a brand converged on one time. mkt_clients.post_time is a
// single brand-wide default and structurally cannot express a per-platform
// cadence; the real per-platform schedule lives in mkt_content_schedule.
//
// Confirmed instance: a CRHQ FACEBOOK post landed at 07:00. CRHQ's Facebook
// slot is Tue/Thu/Sat 18:00 and its Instagram slot is Mon/Tue/Thu/Fri 07:30 —
// 07:00 is neither. It is mkt_clients.post_time, CRHQ's brand-wide default,
// which is exactly what the old code reached for. (CRHQ's post_days are also
// stored lowercase and the DOW map is capitalised, so every day mapped to
// undefined, targets came out empty, and it fell straight to the
// "tomorrow at post_time" branch — 07:00 on whatever day came next.)
//
// Now consults the platform's own schedule first and only falls back to the
// client-wide default when a brand genuinely has no rows for that platform —
// which preserves the old behaviour exactly for those brands.
async function nextSlot(
  // Loosely typed to match platformSchedule's own Admin alias. Typing this as
  // ReturnType<typeof createClient> reproduces the supabase-js generic
  // mismatch this file already carries on every logEdgeError call, and there
  // is no reason to add a nineteenth instance of it.
  // deno-lint-ignore no-explicit-any
  admin: any,
  client: Record<string, any>,
  platform: string,
): Promise<Date> {
  const now = new Date()
  const schedule = await platformSchedule(admin, client, platform)

  if (schedule) {
    // Walk forward to the next day this PLATFORM actually posts on, and use
    // that day's own configured time.
    for (let i = 0; i < 14; i++) {
      const d = new Date(now)
      d.setDate(now.getDate() + i)
      if (!schedule.days.has(d.getDay())) continue
      const time = schedule.timeByDay.get(d.getDay()) || String(client.post_time ?? '09:00')
      const [hh, mm] = time.split(':').map(Number)
      d.setHours(hh || 0, mm || 0, 0, 0)
      if (d > now) return d
    }
    // Every configured day inside the next fortnight is already behind us
    // (only reachable if the schedule is very sparse). Fall through rather
    // than inventing a slot this platform never posts in.
  }

  // No per-platform schedule for this brand+platform — original behaviour.
  const [hh, mm] = (String(client.post_time ?? '') || '09:00').split(':').map(Number)
  const targets = ((client.post_days ?? []) as string[])
    // Case-insensitive: some brands store lowercase day names, and the old
    // exact-match lookup silently dropped every one of them.
    .map((d) => DOW_LOWER[String(d).trim().toLowerCase()])
    .filter((n) => n != null)

  if (targets.length === 0) {
    const d = new Date(now); d.setDate(d.getDate() + 1); d.setHours(hh || 0, mm || 0, 0, 0); return d
  }
  for (let i = 0; i < 14; i++) {
    const d = new Date(now); d.setDate(now.getDate() + i); d.setHours(hh || 0, mm || 0, 0, 0)
    if (targets.includes(d.getDay()) && d > now) return d
  }
  const d = new Date(now); d.setDate(d.getDate() + 1); d.setHours(hh || 0, mm || 0, 0, 0); return d
}

// ── Metricool call with retry ────────────────────────────────────────────────
// Built after a real incident (17 Aug 2026): a single failed Metricool call
// left a post at status='approved'/metricool_post_id=null with ZERO trace
// anywhere — edge_function_errors had no row for this function at all, despite
// the code already calling logEdgeError on every OTHER failure branch in this
// file (missing brand id, unsupported platform, past slot, missing API key).
// The one call that was never retried or reliably logged was the actual
// network call to Metricool — a fetch with no timeout of its own, relying
// entirely on Supabase's platform-level function budget to eventually kill it.
// If Metricool hangs rather than erroring cleanly, that outer kill terminates
// the whole process BEFORE the existing try/catch below it ever runs — no
// catch block fires, nothing gets logged, the row is left exactly as it
// started. That silent-hang shape is what this replaces.
//
// MAX_ATTEMPTS/ATTEMPT_TIMEOUT_MS/BACKOFF_MS chosen so the worst case
// (3 full timeouts + both backoffs) is ~82s — comfortably inside Supabase's
// edge function budget, so this function's OWN try/catch/logging always gets
// to run instead of being preempted by the platform the way the original bug
// was.
const MAX_ATTEMPTS = 3
const ATTEMPT_TIMEOUT_MS = 20_000
const BACKOFF_MS = [2_000, 5_000] // between attempt 1→2 and 2→3

export type MetricoolCallResult =
  | { ok: true; data: unknown; raw: string; attempts: number }
  | { ok: false; lastError: string; attempts: number }

// Exported so the retry/backoff/per-attempt-logging behaviour is directly
// unit-testable against a mocked fetch, rather than only provable by risking
// a real call to Adrian's live Metricool account.
export async function callMetricoolWithRetry(
  admin: ReturnType<typeof createClient>,
  url: string,
  method: string,
  apiKey: string,
  requestBody: Record<string, unknown>,
  ctx: { postId: string; clientName: string; platform: string },
): Promise<MetricoolCallResult> {
  let lastError = 'unknown error'
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), ATTEMPT_TIMEOUT_MS)
    try {
      const mRes = await fetch(url, {
        method,
        headers: { 'X-Mc-Auth': apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
        signal: controller.signal,
      })
      const mRaw = await mRes.text()
      let mData: unknown
      try { mData = JSON.parse(mRaw) } catch { mData = mRaw }
      console.log(`[schedule-to-metricool] attempt ${attempt}/${MAX_ATTEMPTS} — Metricool response ${mRes.status}:`, JSON.stringify(mData))
      if (mRes.ok) return { ok: true, data: mData, raw: mRaw, attempts: attempt }
      const detailStr = typeof mData === 'string' ? mData : JSON.stringify(mData)
      lastError = `Metricool rejected the post (${mRes.status}): ${detailStr}`.slice(0, 500)
    } catch (e) {
      const isTimeout = (e as Error)?.name === 'AbortError'
      lastError = isTimeout
        ? `Metricool call timed out after ${ATTEMPT_TIMEOUT_MS / 1000}s (attempt aborted client-side, not a Metricool response)`
        : `Network error calling Metricool: ${String((e as Error)?.message ?? e)}`
    } finally {
      clearTimeout(timeoutId)
    }

    // Logged for EVERY failed attempt, whether or not a later attempt goes on
    // to succeed — a post that failed twice and recovered on attempt 3 is
    // exactly the early warning of Metricool flakiness that should be visible
    // before it becomes a full outage, not just when it finally exhausts
    // every attempt.
    await logEdgeError(
      admin,
      `Post ${ctx.postId} ("${ctx.clientName}", ${ctx.platform}) — attempt ${attempt}/${MAX_ATTEMPTS} failed: ${lastError}`,
    )
    if (attempt < MAX_ATTEMPTS) await new Promise((r) => setTimeout(r, BACKOFF_MS[attempt - 1]))
  }
  return { ok: false, lastError, attempts: MAX_ATTEMPTS }
}

serve(async (req) => {
  const json = (b: unknown, s = 200) =>
    new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } })
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })

  try {
    const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
    // Auth: either a signed-in admin (the normal dashboard "Approve" click),
    // OR cron/service auth (the sweep-stuck-metricool-posts job re-invoking
    // this exact endpoint for a post whose inline retries all failed). Cron
    // auth is only consulted when the JWT path doesn't already clear it, so
    // the common human path costs nothing extra.
    const userClient = createClient(SUPABASE_URL, Deno.env.get('SUPABASE_ANON_KEY')!, {
      global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } },
    })
    const { data: isAdmin } = await userClient.rpc('mkt_is_admin')
    if (isAdmin !== true) {
      const cronAuth = await checkCronAuth(req, 'schedule-to-metricool')
      if (!cronAuth.authorised) return json({ error: 'Not authorised' }, 403)
    }

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
      // Platform-aware: this post's own platform decides the slot, not the
      // brand-wide default. See nextSlot's header for the CRHQ 07:00 case.
      : await nextSlot(admin, client, item.platform)

    // Issue 6: reject if the resolved slot is in the past.
    if (slot <= new Date()) {
      const msg = 'Scheduled time has passed — please reschedule before retrying.'
      await markFailed(admin, item.id, msg)
      await logEdgeError(admin, msg)
      return json({ error: msg }, 422)
    }

    // Slot-collision guard (added 17 Aug 2026, same incident as the retry
    // hardening above). mkt_content_queue has a partial unique index —
    // mkt_content_queue_one_auto_post_per_slot, on (client_id, platform,
    // scheduled_for) for content_type='post', status<>'rejected',
    // generated_by in ('ai','cron') — meant to guarantee one post per slot.
    // It only protects OUR OWN bookkeeping though: nothing previously
    // checked it before calling Metricool, only after, when writing the
    // result back. Proven live: a stuck row whose computed nextSlot()
    // collided with an already-scheduled post called Metricool successfully
    // (creating a second, real, live duplicate post) and only THEN hit the
    // index violation on the write-back — silently, via a bare
    // console.error, never surfaced anywhere, leaving the row looking
    // exactly as stuck as before while a duplicate sat live on Metricool.
    // Checking here, before ever calling Metricool, turns that into a clean
    // refusal instead of a duplicate.
    const { data: collision } = await admin
      .from('mkt_content_queue')
      .select('id')
      .eq('client_id', item.client_id)
      .eq('platform', item.platform)
      .eq('scheduled_for', slot.toISOString())
      .eq('content_type', 'post')
      .neq('status', 'rejected')
      .in('generated_by', ['ai', 'cron'])
      .neq('id', item.id)
      .maybeSingle()
    if (collision) {
      const msg = `Slot already occupied by another post (${collision.id}) for this client/platform/time — refusing rather than creating a duplicate on Metricool. Reschedule this post to a different slot.`
      await markFailed(admin, item.id, msg)
      await logEdgeError(admin, msg)
      return json({ error: msg }, 409)
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
    const attachingImage = !!item.image_url && !facebookTextOnly
    if (attachingImage) requestBody.media = [item.image_url]

    // ── AI disclosure ────────────────────────────────────────────────────────
    // Meta requires organic posts carrying photorealistic AI-generated imagery
    // to disclose it. Metricool's own AI toggle cannot do this for us here:
    // it is a composer-UI feature, it is unavailable for Facebook entirely,
    // and its scheduler API exposes no disclosure parameter. Self-disclosure
    // in the caption is the only route that works on both networks with no
    // manual step, which is what this is.
    //
    // Appended HERE, at post time, rather than baked into the body at
    // generation time. Three reasons: it applies to posts already sitting in
    // the queue without regenerating them; the stored content stays clean, so
    // the copy the reviewer approved is the copy they wrote; and the wording
    // can be changed or withdrawn in one place without touching history.
    //
    // Gated on an image ACTUALLY being attached — a CRHQ Facebook post on the
    // no-image half of its alternation would otherwise announce an AI image
    // that isn't there, which is its own kind of inaccuracy.
    //
    // Idempotent: PATCH re-sends the whole body for an existing post, so
    // without the includes() guard a rescheduled post would accumulate the
    // line twice.
    if (attachingImage && client?.slug === 'crhq' && !String(item.body ?? '').includes(AI_IMAGE_DISCLOSURE)) {
      requestBody.text = `${item.body}\n\n${AI_IMAGE_DISCLOSURE}`
    }

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

    // Issue 2 (retry-hardened, 17 Aug 2026): up to MAX_ATTEMPTS calls to
    // Metricool, each with its own timeout, backing off between attempts, and
    // logging every failed attempt as it happens — see callMetricoolWithRetry
    // above for why the original single, un-timed-out fetch could fail
    // completely silently.
    const result = await callMetricoolWithRetry(admin, url, method, apiKey, requestBody, {
      postId: item.id, clientName: client?.name ?? 'Unknown', platform: item.platform,
    })

    if (!result.ok) {
      console.error(`[schedule-to-metricool] gave up after ${result.attempts} attempt(s) for "${client?.name}" (${item.platform}): ${result.lastError}`)
      const msg = `Metricool scheduling failed after ${result.attempts} attempt(s): ${result.lastError}`
      // Per-attempt failures are already logged inside callMetricoolWithRetry —
      // this is the distinct "gave up entirely" signal, easy to grep for
      // separately from a transient blip that a later attempt recovered from.
      // Status/metricool_post_id are deliberately left untouched here: the row
      // stays exactly as it was (status='approved' with metricool_post_id
      // still null for a first attempt, or unchanged for a reschedule PATCH),
      // which is what the dashboard's "Failed to schedule" count and manual
      // retry button already key off — see ContentQueue.jsx's retry().
      await markFailed(admin, item.id, msg)
      await logEdgeError(admin, `GIVING UP — ${msg}`)
      return json({ error: msg }, 502)
    }

    const { data: mData, raw: mRaw } = result
    console.log(`[schedule-to-metricool] succeeded on attempt ${result.attempts}/${MAX_ATTEMPTS}`)

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

    // Issue 1 (hardened 17 Aug 2026): a failure here is now logged to
    // edge_function_errors, not just console.error. This is the exact gap
    // that let a real, successful Metricool post (id captured below) go
    // completely untracked — Metricool had genuinely scheduled it, but our
    // own row was left looking exactly as stuck as before, invisible
    // anywhere except a console line nobody was watching. The slot-collision
    // guard above should make this rare now, but a write failure AFTER a
    // real Metricool call has already happened is the single most important
    // case in this whole file to never lose silently — the alternative is
    // reconciling by hand against Metricool's dashboard.
    const { error: updateErr } = await admin.from('mkt_content_queue')
      .update({ status: 'scheduled', scheduled_for: slot.toISOString(), metricool_post_id: metricoolPostId, error_message: null })
      .eq('id', item.id)
    if (updateErr) {
      const msg = `Metricool post ${metricoolPostId} was created successfully, but recording it against ${item.id} failed: ${updateErr.message} — this post now exists on Metricool with NOTHING in our own records pointing at it.`
      console.error(`[schedule-to-metricool] ${msg}`)
      await logEdgeError(admin, msg)
    }

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
    if (pubErr) {
      // Was previously silently swallowed by a schema mismatch — see the
      // 20260817_published_posts_plain_unique_content_queue_id migration —
      // where this upsert failed on EVERY call, always via a bare
      // console.error, for as long as this table has existed with that
      // partial index. Logged properly now that the underlying bug is fixed,
      // so a genuinely new failure here doesn't fall back into the same hole.
      const msg = `Failed to upsert published_posts for ${item.id} (Metricool post ${metricoolPostId}): ${pubErr.message}`
      console.error(`[schedule-to-metricool] ${msg}`)
      await logEdgeError(admin, msg)
    }

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
