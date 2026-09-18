// Missed-slot mover — platform-wide, 18 Sep 2026.
//
// A post whose scheduled_for passes without actually going out used to sit
// dead until someone cleared it by hand: "past scheduled date — superseded,
// cleared during queue cleanup" was the top rejection reason across brands
// for weeks (17 rows on 10 Aug alone; "past date" five more times since).
// This moves such a post to the next open slot for its brand and platform
// instead, in its normal cadence, one post per open slot, oldest first.
//
// GROUND TRUTH FOR "NEVER WENT OUT" — established against the live data, not
// assumed:
//   - metricool_post_id null: never handed to Metricool → never published.
//     (14 rows from June/July with no id predate the Metricool integration
//     and ARE in published_posts — they went out via the old path. Anything
//     that old is outside MISSED_MAX_AGE_DAYS and is reported, not moved.)
//   - metricool_post_id set: status='scheduled' means handed to Metricool,
//     nothing more. Metricool's scheduler is asked (fetchSchedulerPost):
//     providers[].status PUBLISHED → it went out (380 of 383 past-slot rows
//     on 18 Sep); ERROR → it did not (2 CRHQ Instagram rows: "you need to
//     add a picture"); 404 → Metricool no longer has it → unknown, flagged.
//     A verified publish is stamped published_verified_at so it is asked
//     once, not every night. published_posts is NOT a signal — it is written
//     at scheduling time.
//
// Modelled on CRHQ's slot recycling (crhqRecycle.ts) — same shape (find,
// decide, dry run, close-or-move, never delete) — but this MOVES the row
// rather than regenerating it: for every brand except CRHQ the copy is
// evergreen pillar content and the review already passed. CRHQ is the
// exception, deliberately: its content is 48h-bound and its recycler owns
// it, so a CRHQ row is never moved here. A CRHQ row that Metricool errored
// on IS handed back to that recycler (metricool_post_id cleared, status
// draft, the Metricool error kept in error_message) since the recycler only
// looks at unsent rows.
//
// Rules, pinned in __tests__/missedSlots_test.ts:
//   - candidate: content_type post/reel, not manual, status
//     draft/pending/approved/scheduled, slot passed more than
//     MISSED_GRACE_HOURS ago (Metricool can publish minutes late) and no
//     more than MISSED_MAX_AGE_DAYS ago.
//   - spread: per brand+platform, oldest first, each to nextEmptySlot after
//     the previous one assigned — never two into one slot; the
//     one-auto-post-per-slot unique index is the backstop.
//   - a moved row keeps its status (a draft stays a draft awaiting approval;
//     an approved-but-unsent row stays approved and the stuck-post sweep
//     re-pushes it, now with a future date; a Metricool-ERROR row becomes
//     approved so the same sweep re-pushes it with PUT and its new date).
//     missed_moved_from records where it came from, missed_moved_at when.
//   - unknown (Metricool 404 / HTTP error): not moved; review_status
//     needs_attention with the reason, so a human decides.
import { nextEmptySlot } from './fill.ts'
import { fetchSchedulerPost } from './metricool-v2.ts'

// deno-lint-ignore no-explicit-any
type Admin = any

export const MISSED_MAX_AGE_DAYS = 14
export const MISSED_GRACE_HOURS = 2
export const MISSED_ELIGIBLE_STATUSES = ['draft', 'pending', 'approved', 'scheduled']
export const CRHQ_SLUG = 'crhq'

export type Verdict = 'unsent' | 'metricool_error' | 'published' | 'unknown'

export interface MissedRow {
  id: string
  client_id: string
  platform: string
  content_type: string
  status: string
  scheduled_for: string
  metricool_post_id: string | null
  is_manual: boolean | null
  published_verified_at: string | null
  missed_moved_from: string | null
  client: { name: string; slug: string; metricool_brand_id: string | null } & Record<string, any>
}

export function isCandidate(row: Pick<MissedRow, 'content_type' | 'is_manual' | 'status' | 'scheduled_for' | 'published_verified_at'>, now: Date): { ok: boolean; why?: string } {
  if (!['post', 'reel'].includes(row.content_type)) return { ok: false, why: `content_type ${row.content_type}` }
  if (row.is_manual) return { ok: false, why: 'manual post' }
  if (row.published_verified_at) return { ok: false, why: 'publish already verified' }
  if (!MISSED_ELIGIBLE_STATUSES.includes(row.status)) return { ok: false, why: `status ${row.status}` }
  const slot = new Date(row.scheduled_for).getTime()
  const age = now.getTime() - slot
  if (age < MISSED_GRACE_HOURS * 3_600_000) return { ok: false, why: 'inside the grace window' }
  if (age > MISSED_MAX_AGE_DAYS * 86_400_000) return { ok: false, why: `slot passed more than ${MISSED_MAX_AGE_DAYS} days ago` }
  return { ok: true }
}

// Pure: Metricool's answer → verdict.
export function verdictFor(row: Pick<MissedRow, 'metricool_post_id'>, mc: { http: number; providers: Array<{ status: string; detailedStatus: string | null }> } | null): { verdict: Verdict; detail: string } {
  if (!row.metricool_post_id) return { verdict: 'unsent', detail: 'never handed to Metricool' }
  if (!mc || mc.http !== 200) return { verdict: 'unknown', detail: `Metricool HTTP ${mc?.http ?? 'none'} for post ${row.metricool_post_id}` }
  if (!mc.providers.length) return { verdict: 'unknown', detail: `Metricool post ${row.metricool_post_id} has no providers` }
  if (mc.providers.every((p) => p.status === 'PUBLISHED')) return { verdict: 'published', detail: 'Metricool: PUBLISHED' }
  const bad = mc.providers.find((p) => p.status !== 'PUBLISHED')!
  if (['PENDING', 'PUBLISHING', 'SCHEDULED'].includes(bad.status)) return { verdict: 'unknown', detail: `Metricool: ${bad.status}` }
  return { verdict: 'metricool_error', detail: `Metricool: ${bad.status}${bad.detailedStatus ? ` — ${bad.detailedStatus}` : ''}` }
}

export interface MoveOutcome {
  moved: Array<{ id: string; brand: string; platform: string; from: string; to: string; verdict: Verdict; status: string }>
  verifiedPublished: number
  handedToCrhqRecycler: string[]
  flagged: Array<{ id: string; brand: string; platform: string; why: string }>
  notes: string[]
  errors: string[]
}

export async function moveMissedPosts(admin: Admin, opts: { dryRun?: boolean; now?: Date } = {}): Promise<MoveOutcome> {
  const dryRun = opts.dryRun === true
  const now = opts.now ?? new Date()
  const out: MoveOutcome = { moved: [], verifiedPublished: 0, handedToCrhqRecycler: [], flagged: [], notes: [], errors: [] }
  const since = new Date(now.getTime() - MISSED_MAX_AGE_DAYS * 86_400_000).toISOString()
  const until = new Date(now.getTime() - MISSED_GRACE_HOURS * 3_600_000).toISOString()

  const { data: rows, error } = await admin
    .from('mkt_content_queue')
    .select('id, client_id, platform, content_type, status, scheduled_for, metricool_post_id, is_manual, published_verified_at, missed_moved_from, client:mkt_clients(*)')
    .in('content_type', ['post', 'reel'])
    .in('status', MISSED_ELIGIBLE_STATUSES)
    .is('published_verified_at', null)
    .gte('scheduled_for', since)
    .lt('scheduled_for', until)
    .order('scheduled_for', { ascending: true })
  if (error) { out.errors.push(`missed: lookup failed — ${error.message}`); return out }

  // 1. Verdict per row.
  const toMove = new Map<string, Array<MissedRow & { verdict: Verdict; detail: string }>>() // key client_id|platform
  for (const row of (rows ?? []) as MissedRow[]) {
    const cand = isCandidate(row, now)
    if (!cand.ok) continue
    let mc = null
    if (row.metricool_post_id) {
      try { mc = await fetchSchedulerPost(row.metricool_post_id, String(row.client?.metricool_brand_id ?? '')) }
      catch (e) { mc = { http: 0, providers: [], publicationDate: null, raw: String((e as Error)?.message ?? e) } }
    }
    const { verdict, detail } = verdictFor(row, mc)
    const label = `${row.client?.name ?? row.client_id} ${row.platform} ${row.id}`
    if (verdict === 'published') {
      out.verifiedPublished++
      if (!dryRun) await admin.from('mkt_content_queue').update({ published_verified_at: now.toISOString() }).eq('id', row.id)
      continue
    }
    if (verdict === 'unknown') {
      out.flagged.push({ id: row.id, brand: row.client?.name, platform: row.platform, why: detail })
      if (!dryRun) await admin.from('mkt_content_queue').update({ review_status: 'needs_attention', review_reason: `Slot passed and whether it published cannot be confirmed — ${detail}. Decide by hand.` }).eq('id', row.id)
      continue
    }
    // published_posts is written when a post is HANDED to Metricool, so a
    // Metricool-ERROR row has a published_posts entry that is simply false —
    // and it feeds the reviewer's repeat-topic list as "[published]" (the
    // first live recycle of c273549c was flagged as a repeat of itself that
    // way). Remove it; delete-post does the same for a deleted post.
    if (verdict === 'metricool_error' && !dryRun) {
      const { error: ppErr } = await admin.from('published_posts').delete().eq('content_queue_id', row.id)
      if (ppErr) out.errors.push(`missed: ${label} — could not remove the false published_posts row: ${ppErr.message}`)
    }
    if (row.client?.slug === CRHQ_SLUG) {
      if (verdict === 'metricool_error') {
        out.handedToCrhqRecycler.push(row.id)
        out.notes.push(`missed: ${label} — ${detail}; ${dryRun ? 'would be handed' : 'handed'} to CRHQ recycling (metricool_post_id ${row.metricool_post_id} cleared)`)
        if (!dryRun) await admin.from('mkt_content_queue').update({ metricool_post_id: null, status: 'draft', error_message: `Metricool post ${row.metricool_post_id} failed: ${detail}` }).eq('id', row.id)
      } else {
        out.notes.push(`missed: ${label} — ${detail}; CRHQ rows are recycled by crhq-nightly-content, not moved`)
      }
      continue
    }
    const key = `${row.client_id}|${row.platform}`
    if (!toMove.has(key)) toMove.set(key, [])
    toMove.get(key)!.push({ ...row, verdict, detail })
  }

  // 2. Spread each brand+platform's missed posts across its next open slots.
  for (const [, list] of toMove) {
    let after: Date | undefined
    for (const row of list) {
      const label = `${row.client?.name} ${row.platform} ${row.id}`
      const slot = await nextEmptySlot(admin, row.client, row.platform, after)
      if (!slot) { out.errors.push(`missed: ${label} — no open slot found (check mkt_content_schedule / post_days)`); continue }
      after = slot
      const newStatus = row.verdict === 'metricool_error' ? 'approved' : row.status
      out.moved.push({ id: row.id, brand: row.client?.name, platform: row.platform, from: row.scheduled_for, to: slot.toISOString(), verdict: row.verdict, status: newStatus })
      if (dryRun) continue
      const patch: Record<string, unknown> = { scheduled_for: slot.toISOString(), missed_moved_from: row.scheduled_for, missed_moved_at: now.toISOString(), status: newStatus }
      if (row.verdict === 'metricool_error') patch.error_message = `Moved after Metricool failed to publish: ${row.detail}`
      const { error: upErr } = await admin.from('mkt_content_queue').update(patch).eq('id', row.id)
      if (upErr) {
        out.errors.push(`missed: ${label} — move failed: ${upErr.message}`)
        out.moved.pop()
        // The slot stays claimed in `after` so the next post is not offered it.
      }
    }
  }
  return out
}
