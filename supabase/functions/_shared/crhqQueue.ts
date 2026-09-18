// CRHQ queue helpers — moved verbatim out of crhq-nightly-content/index.ts
// on 18 Sep 2026 so that slot recycling (_shared/crhqRecycle.ts) and the
// nightly run share ONE definition of "queued", "next available slot" and
// the Facebook image alternation, and so a verification harness can drive
// the shipped code rather than a copy of it. Nothing here changed in the
// move; every comment is the original author's.
import type { ScrapedVideo, ScrapedArticle } from './crhqScrape.ts'
import { platformSchedule, hasAutoPostOnDate } from './fill.ts'
import { dayOfWeekUK, addDays } from './generate.ts'
import { ukTimeSlotToUtc } from './ukTime.ts'

// deno-lint-ignore no-explicit-any
type Admin = any

export const PLATFORMS = ['facebook', 'instagram']

// Hard ceiling — CRHQ must never have more than this many posts sitting
// upcoming (not yet published or rejected) in the queue per platform. Content
// this time-sensitive goes stale within hours, so bulk-generating weeks ahead
// is exactly the failure mode this exists to prevent. Counted per platform,
// not combined, because facebook (3/week) and instagram (4/week) run
// different cadences — a shared counter would let one platform's backlog
// block the other's generation for no reason.
export const MAX_QUEUED_PER_PLATFORM = 3
export const QUEUED_STATUSES = ['draft', 'pending', 'approved', 'scheduled']

export const SAFETY_MAX_DAYS_WALKED = 21

// Incident fix — nextAvailableSlot's walk was bounded only by
// SAFETY_MAX_DAYS_WALKED (21 days) and MAX_QUEUED_PER_PLATFORM (3 posts).
// With CRHQ's real cadence (facebook Tue/Thu/Sat, instagram Mon/Tue/Thu/Fri
// — see 55_crhq_content_config.sql), "3 queued" can legitimately span most
// of a week, which is exactly how posts ended up scheduled for 6 and 8
// August 2026 while the run date was 1 August — CRHQ content is
// time-sensitive (geopolitics/defence) and must never be queued that far
// ahead. Bounding the actual returned slot (not just the day-walk) to this
// window is what fixes that at the source: if no free slot exists within
// the window, nextAvailableSlot now returns null and this platform is
// simply skipped for the night, rather than reaching further into the
// future.
//
// Reverted to 48h (2026-08-10) — CRHQ content must never be scheduled more
// than 48 hours out, full stop; it needs to stay tied to what Craig has
// actually posted on YouTube recently, and the 96h widening below let real
// posts get approved and scheduled up to 96.5 hours ahead.
//
// The 96h widening was a response to a real but differently-shaped problem:
// both platforms' schedules have a genuine 3-day gap between consecutive
// posting days (facebook Sat->Tue, instagram Fri->Mon) — confirmed live: on
// 5 August 22:00 (a Wednesday-night run), facebook's very next posting day
// (Thursday 6 August) was already filled by a real, already-scheduled post,
// so the walk correctly moved on to Saturday 8 August — a legitimate
// 3-day-out slot a 48h window can never reach, which then surfaced as an
// alarming "no available slot found" entry in the errors array on those
// nights. That's expected, correct behaviour for this cadence, not a fault
// — widening the window was the wrong fix, since it also let genuinely
// time-sensitive content drift up to 96.5h out. The actual fix is
// classifying that specific outcome correctly: nextAvailableSlot now
// reports WHY it returned no slot, and "the only slot is beyond the window"
// is logged as a note, not an error — see the call site below.
export const MAX_LOOKAHEAD_MS = 48 * 60 * 60 * 1000

// Facebook images alternate: one post with an image, the next without, and so
// on. Instagram is unaffected — every Instagram post still gets one.
//
// This run generates at most ONE Facebook post, so the alternation state can't
// live in memory — it has to be derived from what's already queued. Rather
// than counting posts (parity breaks the moment one is rejected or deleted),
// this looks at the most recently scheduled Facebook post and does the
// opposite of it, which self-corrects after any gap.
//
// MUST be called before the new row is inserted. The new post is scheduled
// further into the future than every existing one, so after insertion it would
// be its own "most recent" row — with a null image_url — and the answer would
// be true every single time.
//
// Rejected posts are excluded because they never reach Facebook, so they
// cannot be half of an alternation of what people actually saw. Counting one
// inverts the toggle for the next real post.
//
// Scoped to posts scheduled STRICTLY BEFORE the slot this run is filling
// (2026-08-22 fix). It previously took the global maximum scheduled_for for
// this client/platform and relied on the commented assumption that "the new
// post is scheduled further into the future than every existing one". Nothing
// enforces that: nextAvailableSlot only skips whole DAYS that already hold a
// post, and a rejected post stops reserving its day the moment it is
// rejected — which is exactly how CRHQ ended up with two Facebook posts on
// 2026-08-18 (07:00 from the 14 Aug run, 18:00 from the 16 Aug run). The
// question this function has to answer is "did the post immediately BEFORE
// mine carry an image", so ask that directly rather than inferring it from an
// ordering invariant the scheduler does not guarantee.
//
// Deliberately NOT changed: the state is still read from image_url, i.e. from
// the OUTCOME, not from what a previous run decided. When generation is asked
// for and fails, the row stores no image and the next run asks again. That is
// the right behaviour — the alternative (remembering the intent) would answer
// "no image" for a post that never got one, and drive the real ratio further
// below 50/50 rather than toward it. It does mean this function cannot, on
// its own, distinguish "deliberately text-only" from "tried and failed" —
// which is what the outcome check at the call site is for.
export interface AlternationDecision {
  wantsImage: boolean
  // Human-readable, for the run log — the whole reason this bug took a week
  // and two wrong fixes to pin down was that nothing anywhere recorded WHY a
  // given post did or did not ask for an image.
  because: string
}

export async function facebookWantsImage(admin: Admin, clientId: string, beforeSlot: Date): Promise<AlternationDecision> {
  const { data, error } = await admin
    .from('mkt_content_queue')
    .select('id, scheduled_for, image_url')
    .eq('client_id', clientId).eq('platform', 'facebook').eq('content_type', 'post')
    .neq('status', 'rejected')
    .lt('scheduled_for', beforeSlot.toISOString())
    .order('scheduled_for', { ascending: false })
    .limit(1)
  if (error) {
    // Fail closed — a lookup failure must not turn into an image on every
    // Facebook post. Text-only is the safe side of this decision.
    console.error(`[crhq-nightly-content] facebook image alternation lookup failed (${error.message}) — defaulting to no image`)
    return { wantsImage: false, because: `alternation lookup failed (${error.message}) — defaulted to no image` }
  }
  const previous = data?.[0]
  // no Facebook history before this slot — start the cycle with an image
  if (!previous) return { wantsImage: true, because: 'no prior non-rejected Facebook post before this slot — starting the cycle with an image' }
  const hadImage = !!previous.image_url
  return {
    wantsImage: !hadImage,
    because: `previous non-rejected Facebook post (${previous.scheduled_for}) ${hadImage ? 'had' : 'had no'} image — this one ${hadImage ? 'goes text-only' : 'gets one'}`,
  }
}

// Incident fix — last night's run found 2 videos and 0 articles but
// generated 0 posts. The top-level gate a few lines below this function
// (`foundContent = videos.length > 0 || articles.length > 0`) was already
// an OR, not an AND, so "videos alone" already passed it; the actual
// symptom traced to the per-platform slot/queue gates instead (a near-full
// queue leaving no free slot inside the 48h window — see MAX_LOOKAHEAD_MS
// above). Auditing that gate found a real, separate gap the brief also
// asks to close: neither platform had an EXPLICIT primary source to build
// from — both got the full videos+articles list undifferentiated (see
// prompts.ts's scrape block), leaving it to the model to pick, which is
// exactly how two posts on the same night can end up built around the
// same single item, or Instagram ending up built around an article with
// nothing visual to actually reference.
//
// Picks the most recent item by published_at — scrape ordering isn't
// documented/guaranteed as most-recent-first by either source (YouTube's
// uploads playlist and the news-page regex parser), so this sorts
// explicitly rather than assuming index 0 already is.
export function mostRecent<T extends { published_at: string | null }>(items: T[]): T | undefined {
  return [...items].sort((a, b) => new Date(b.published_at ?? 0).getTime() - new Date(a.published_at ?? 0).getTime())[0]
}

export interface PrimarySource {
  type: 'video' | 'article'
  title: string
  url: string
}

// Facebook: most recent article if one exists, else most recent video.
// Instagram: most recent video, always — an article has nothing visual to
// build an Instagram post around, so no video found means no eligible
// source for Instagram this run (returns null; the caller skips with a
// note, same pattern as the queue-cap/no-slot skips below).
export function primarySourceForPlatform(platform: string, videos: ScrapedVideo[], articles: ScrapedArticle[]): PrimarySource | null {
  if (platform === 'instagram') {
    const v = mostRecent(videos)
    return v ? { type: 'video', title: v.title, url: v.url } : null
  }
  const a = mostRecent(articles)
  if (a) return { type: 'article', title: a.title, url: a.url }
  const v = mostRecent(videos)
  return v ? { type: 'video', title: v.title, url: v.url } : null
}

export async function countQueued(admin: Admin, clientId: string, platform: string): Promise<number> {
  const { count } = await admin
    .from('mkt_content_queue')
    .select('id', { count: 'exact', head: true })
    .eq('client_id', clientId).eq('platform', platform).eq('content_type', 'post')
    .in('status', QUEUED_STATUSES)
    .gte('scheduled_for', new Date().toISOString())
  return count ?? 0
}

// Why nextAvailableSlot found no usable slot — the caller treats these very
// differently. 'beyond_window' is CRHQ's normal cadence doing exactly what
// it should (see MAX_LOOKAHEAD_MS) and must never read as an error; the
// other two are genuine problems (a missing schedule config, or 21 days
// with no free day at all) and should still surface as one.
export type NoSlotReason = 'no_schedule' | 'beyond_window' | 'no_slot_in_walk'
export type SlotResult = { slot: Date; reason?: undefined } | { slot: null; reason: NoSlotReason }

// Walks forward from tomorrow to the first day matching this platform's
// posting schedule that doesn't already have a post queued for it — one post
// per platform per day, the same rule fillClientGap enforces elsewhere.
// slot=null if CRHQ has no active schedule rows for this platform (a
// misconfiguration — see 55_crhq_content_config.sql), none free within the
// safety bound, or the only free day falls beyond the 48h window — reason
// distinguishes which, for the caller's errors-vs-notes classification.
export async function nextAvailableSlot(admin: Admin, client: Record<string, any>, platform: string): Promise<SlotResult> {
  const schedule = await platformSchedule(admin, client, platform)
  if (!schedule) return { slot: null, reason: 'no_schedule' }

  const cutoff = Date.now() + MAX_LOOKAHEAD_MS
  let day = addDays(new Date(), 1)
  for (let walked = 0; walked < SAFETY_MAX_DAYS_WALKED; walked++) {
    if (schedule.days.has(dayOfWeekUK(day)) && !(await hasAutoPostOnDate(admin, client.id, platform, day))) {
      const time = schedule.timeByDay.get(dayOfWeekUK(day)) ?? String(client.post_time ?? '09:00')
      // ukTimeSlotToUtc, not setHours — this is the exact code path behind
      // the confirmed live bug: CRHQ's Instagram slot is configured 07:30 UK
      // and was firing 08:30 UK during BST. See ukTime.ts's header (18 Aug
      // 2026 fix) — setHours() sets the hour in the RUNTIME's local zone,
      // which is UTC here, not Europe/London.
      const slot = ukTimeSlotToUtc(day, time)
      // The walk moves strictly forward in time, so the moment a candidate
      // slot exceeds the 48h window every later candidate would too — no
      // slot available within the window this run, rather than reaching
      // for a date further out (see MAX_LOOKAHEAD_MS above). Expected,
      // recurring behaviour given CRHQ's own posting cadence — not an error.
      if (slot.getTime() > cutoff) return { slot: null, reason: 'beyond_window' }
      return { slot }
    }
    day = addDays(day, 1)
  }
  return { slot: null, reason: 'no_slot_in_walk' }
}
