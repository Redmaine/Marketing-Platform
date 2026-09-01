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
import { isAlternatingImageStream } from '../_shared/image.ts'
import { dayOfWeekUK, ukTimeSlotToUtc, ukWallClockIso } from '../_shared/ukTime.ts'

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
    //
    // dayOfWeekUK(d), not d.getDay() — this runtime's local timezone is UTC
    // (confirmed directly against a deployed function), not Europe/London, so
    // the native getDay() can disagree with the UK calendar day for up to an
    // hour around UK midnight during BST. schedule.days is keyed by UK
    // weekday (platformSchedule.ts), so the lookup key has to match.
    for (let i = 0; i < 14; i++) {
      const d = new Date(now)
      d.setDate(now.getDate() + i)
      const ukDay = dayOfWeekUK(d)
      if (!schedule.days.has(ukDay)) continue
      const time = schedule.timeByDay.get(ukDay) || String(client.post_time ?? '09:00')
      // ukTimeSlotToUtc, not setHours — see ukTime.ts's header (18 Aug 2026
      // fix). This is the exact class of bug that put a CRHQ post at 07:00
      // instead of its real 18:00 Facebook slot, one layer deeper: even
      // after picking the right slot, writing it with setHours() would still
      // land an hour off during BST.
      const slot = ukTimeSlotToUtc(d, time)
      if (slot > now) return slot
    }
    // Every configured day inside the next fortnight is already behind us
    // (only reachable if the schedule is very sparse). Fall through rather
    // than inventing a slot this platform never posts in.
  }

  // No per-platform schedule for this brand+platform — original behaviour.
  const fallbackTime = String(client.post_time ?? '') || '09:00'
  const targets = ((client.post_days ?? []) as string[])
    // Case-insensitive: some brands store lowercase day names, and the old
    // exact-match lookup silently dropped every one of them.
    .map((d) => DOW_LOWER[String(d).trim().toLowerCase()])
    .filter((n) => n != null)

  if (targets.length === 0) {
    const d = new Date(now); d.setDate(d.getDate() + 1); return ukTimeSlotToUtc(d, fallbackTime)
  }
  for (let i = 0; i < 14; i++) {
    const d = new Date(now); d.setDate(now.getDate() + i)
    if (!targets.includes(dayOfWeekUK(d))) continue
    const slot = ukTimeSlotToUtc(d, fallbackTime)
    if (slot > now) return slot
  }
  const d = new Date(now); d.setDate(d.getDate() + 1); return ukTimeSlotToUtc(d, fallbackTime)
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

    // Inactive-client guard (added 18 Aug 2026). "Quill Gmail E2E Test 0810"
    // — a client set active=false a week earlier — kept reaching Metricool
    // brand-ID/slot-collision logic and writing real rows to
    // edge_function_errors purely because something still queued content
    // against it (a leftover manual/E2E invocation, not the nightly sweep).
    // Checked here, before any Metricool/brand-ID/slot work, so an inactive
    // client can never trigger a live action again regardless of what
    // enqueues against it. Deliberately does NOT call logEdgeError: a client
    // being off is an expected, unremarkable state, not an operational
    // failure worth alerting on — markFailed still records why on the queue
    // row itself, for anyone looking at that specific item.
    if (client?.active !== true) {
      const msg = `Client "${client?.name ?? item.client_id}" is not active — refusing to schedule.`
      await markFailed(admin, item.id, msg)
      return json({ error: msg }, 422)
    }

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

    // Exhausted-image guard (added 22 Aug 2026). Real incident: two CRHQ
    // posts (701fd49c, eee743fc) exhausted all 3 image-generation attempts,
    // were still manually approved, and reached Metricool with no image —
    // ContentQueue.jsx's "Image missing — add manually" warning is visual
    // only, nothing there or here stopped the approve click. Both were
    // caught and cancelled by hand; this closes the actual gap so it can't
    // happen silently again.
    //
    // Deliberately scoped to a REAL exhausted verdict, not "image_url is
    // null" alone — a null image_url is also the normal, correct shape for
    // a platform that never wanted one this cycle (a client with images
    // disabled, a content_type this doesn't apply to) or, for Facebook
    // specifically, a deliberate alternation "text-only" choice (see
    // crhq-nightly-content/index.ts's facebookWantsImage — that path never
    // attempts generation at all, so it leaves zero image_review_events
    // rows behind). Only a genuine 3/3 exhaustion — an image that was
    // wanted and definitively failed — should block. Fails open (does not
    // block) if this lookup itself errors, so a lookup failure degrades to
    // today's behaviour rather than blocking every approval.
    if (!item.image_url) {
      const { data: exhausted, error: exErr } = await admin
        .from('image_review_events')
        .select('id')
        .eq('content_queue_id', item.id)
        .eq('verdict', 'exhausted')
        .limit(1)
      if (exErr) {
        console.error(`[schedule-to-metricool] exhausted-image guard lookup failed for ${item.id}: ${exErr.message} — not blocking`)
      } else if (exhausted && exhausted.length > 0) {
        const msg = 'Image generation exhausted all 3 attempts and no image was attached — this post cannot be scheduled without a real image or an explicit manual override.'
        await markFailed(admin, item.id, msg)
        return json({ error: msg }, 422)
      }
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

    // UK wall-clock, NOT UTC — the payload below pairs this with an explicit
    // timezone: 'Europe/London', so it must be the London reading of `slot`.
    // This was slot.toISOString().slice(0, 19) (the UTC reading) until
    // 21 Aug 2026; see ukWallClockIso's comment for why that was wrong and
    // why it stayed hidden for so long.
    const dateTimeStr = ukWallClockIso(slot)

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
    // Two exceptions. CRHQ carries an image on every Facebook post (handled
    // entirely inside crhq-nightly-content, a separate mechanism from the
    // alternation below) — kept as its own explicit slug check, same pattern
    // as _shared/image.ts's own wantsHeadlineOverlay. Quill and Hormonely
    // (2026-08-10 / 22 Aug, Facebook/LinkedIn 50/50 image pilots — with vs
    // without AI artwork) carry one on every OTHER post via
    // _shared/image.ts's generalised alternation.
    //
    // Root-cause fix (30 Aug 2026): the alternation half used to be its own
    // hardcoded `client?.slug !== 'quill' && client?.slug !== 'hormonely'`
    // list here — a second, separately-maintained copy of exactly what
    // isAlternatingImageStream + mkt_clients.facebook_image_alternation_enabled
    // already answer generically. Currently in sync (verified live — no
    // client has that column set without also being on this list), but nothing
    // enforced that: a THIRD brand opted into the alternation purely via that
    // DB column, with no matching code change here, would have had its real
    // AI images generated, stored and paid for, then silently stripped before
    // ever reaching Facebook — never surfaced anywhere, since attachingImage
    // being false here isn't an error, just a quiet no-op. Calling the same
    // exported function fill.ts/_shared/image.ts already use for this exact
    // question closes that gap at the source instead of relying on this list
    // being remembered next time.
    const facebookTextOnly = item.platform === 'facebook' && client?.slug !== 'crhq' && !isAlternatingImageStream(client, 'facebook')
    const attachingImage = !!item.image_url && !facebookTextOnly && item.content_type !== 'reel'
    if (attachingImage) requestBody.media = [item.image_url]

    // ── Reels (1 Sep 2026) ───────────────────────────────────────────────────
    // Same endpoint, same ScheduledPost shape, same `media` field as an image —
    // confirmed against Metricool's real OpenAPI spec, so this needed no new
    // integration, only this branch.
    //
    // instagramData.type = 'REEL' is VERIFIED, not assumed. The spec types it
    // as a bare `string` with no enum, and every existing CRHQ Instagram post
    // leaves it unset, so neither told us the accepted value. Confirmed by
    // sending a deliberately invalid value to the live API, whose validator
    // answered: "Valid types are: 'POST, REEL, TRIAL_REEL, STORY'". That probe
    // was rejected 400 and created nothing.
    //
    // Fails CLOSED: a reel row with no video_url is refused rather than
    // scheduled as a text-only post. A Reel without its video is not a
    // degraded post, it is a broken one, and silently publishing the copy
    // alone would be worse than not publishing.
    const isReel = item.content_type === 'reel'
    if (isReel) {
      if (item.platform !== 'instagram') {
        const msg = `Reel ${item.id} is on platform "${item.platform}" — Reels are Instagram-only.`
        await markFailed(admin, item.id, msg)
        return json({ error: msg }, 422)
      }
      if (!item.video_url) {
        const msg = item.caption_status === 'failed'
          ? `Reel ${item.id} has no captioned video — captioning failed: ${item.caption_error ?? 'no reason recorded'}. Re-run captioning before scheduling.`
          : `Reel ${item.id} has no captioned video yet (caption_status: ${item.caption_status ?? 'unset'}). Not scheduling a Reel without its video.`
        await markFailed(admin, item.id, msg)
        return json({ error: msg }, 422)
      }
      requestBody.media = [item.video_url]
      // Ask Metricool to pull and keep its own copy. Our Storage URL is
      // durable, but this removes any dependence on it staying reachable
      // between scheduling and publication.
      requestBody.saveExternalMediaFiles = true
      requestBody.instagramData = {
        ...(requestBody.instagramData as Record<string, unknown> | undefined),
        type: 'REEL',
        // Also surface it on the main feed rather than the Reels tab alone —
        // for a brand this size, reach matters more than feed tidiness.
        showReelOnFeed: true,
      }
    }

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
    // Idempotent: the update re-sends the whole body for an existing post, so
    // without the includes() guard a rescheduled post would accumulate the
    // line twice.
    // REELS AND THIS DISCLOSURE — OPEN DECISION, NOT SETTLED (1 Sep 2026).
    // Reels do NOT currently carry it. That is deliberate and load-bearing,
    // not a side effect of `attachingImage` being false for them: a Reel here
    // is Craig's own real footage with captions burned in, so there is no
    // AI-generated imagery to disclose, and Meta's requirement is specifically
    // about photorealistic AI-generated media. Asserting "Illustration:
    // AI-generated" over real footage would itself be a false statement.
    //
    // What is genuinely unsettled is the transcription: the captions are
    // AI-produced text over real video. That is not what this line was written
    // for and not, on the current reading, what Meta's rule targets — but it
    // is Adrian's call, not one to make silently in either direction. If the
    // answer is that Reels should carry a disclosure, it should almost
    // certainly be its own wording about captions, not this image line.
    // Flagged for a decision; deliberately left OFF until there is one.
    if (attachingImage && client?.slug === 'crhq' && !String(item.body ?? '').includes(AI_IMAGE_DISCLOSURE)) {
      requestBody.text = `${item.body}\n\n${AI_IMAGE_DISCLOSURE}`
    }

    // Issue 8: if metricool_post_id already exists, update the existing post
    // rather than creating a duplicate.
    //
    // PUT, not PATCH (fixed 21 Aug 2026). This branch had never once run
    // against a real existing post — every successful call this function has
    // ever made was a POST for a new one — so nobody had discovered that
    // Metricool's v2 scheduler does not accept PATCH on this route. It
    // answers PATCH with a Spring-level 500, "Required request parameter
    // 'fields' for method parameter type List is not present": the verb
    // falls through to a different partial-update handler expecting a
    // ?fields= list we neither send nor want. Confirmed live against the
    // real API while re-pushing the BST-corrected times — 3/3 attempts 500'd
    // and Metricool left the post untouched.
    //
    // PUT with the full body is the documented update shape, and the body
    // assembled above already IS the full body, so this is purely a verb
    // fix — the "re-sends the whole body" idempotency note above still holds.
    const existingPostId = item.metricool_post_id
    const method = existingPostId ? 'PUT' : 'POST'
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
