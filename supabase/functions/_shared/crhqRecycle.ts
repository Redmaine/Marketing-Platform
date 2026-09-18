// CRHQ slot recycling — 18 Sep 2026.
//
// A CRHQ post whose slot passes without publishing (its image exhausted, it
// stuck at approved with no Metricool id, or it was simply never approved in
// time) used to sit dead: the topic and any usable
// copy were gone for good, and — for the approved-but-unschedulable case —
// the 30-minute sweep kept re-attempting it forever (b09c3603, 14–18 Sep:
// 87 identical "needs a human" alerts). This module gives such a post ONE
// second life: its topic and source are regenerated into the next open slot
// on the same platform, through the same reviewed generation and the same
// image pipeline a fresh post gets, and the original is closed off.
//
// Scope: CRHQ only, by construction. It is called only from
// crhq-nightly-content (which loads the CRHQ client by slug), every query
// here is filtered by that client's id, and the three columns it writes
// (recycled_at, recycled_into, recycled_from — migration 100) are written
// nowhere else. No other brand's rows are read or touched.
//
// Rules, all deterministic and all pinned in __tests__/crhqRecycle_test.ts:
//   - eligible: content_type 'post', not manual, not a themed weekly post,
//     scheduled_for in the past, never sent to Metricool
//     (metricool_post_id null), status draft/pending/approved — never a
//     human-rejected post: a rejection is a deliberate decision and is not
//     retried without someone choosing to — slot passed no more than
//     RECYCLE_MAX_AGE_DAYS ago, not yet recycled.
//   - once only: an original is recycled at most once (recycled_at set); a
//     recycled post that itself dies is not recycled again (recycled_from
//     set) — a topic gets two chances, never a loop.
//   - not if already covered: skipped when another post on ANY platform,
//     going out from the moment the original was written (alive or
//     published), is about the same story — same source URL in the body, or topic-word overlap
//     ≥ TOPIC_OVERLAP_SKIP. Brand-wide, like the reviewer's own repeat rule.
//     The nightly scrape often regenerates the same story itself the next
//     night; recycling must not make it a third time.
//   - room first: only when the platform's queue is under
//     MAX_QUEUED_PER_PLATFORM and nextAvailableSlot finds a slot inside the
//     48h window — fresh scrape content has already had its turn by the
//     time this runs. At most RECYCLE_MAX_PER_PLATFORM_PER_RUN per platform
//     per night.
//   - what is regenerated: copy is ALWAYS regenerated (never the old body
//     re-queued verbatim — it was written for a slot that has passed). The
//     generator is steered with the original topic, the original body as
//     the story to retell, and the original source (video/article from that
//     night's scrape cache when it can be found).
//   - the original: status → 'recycled' (so the sweep and the queue stop
//     seeing it). Nothing is deleted.
import { generateReviewedPost } from './review.ts'
import { generatePostImage } from './image.ts'
import { stripMarkdown, recentPublishedSummaries } from './generate.ts'
import { recentBrandPosts, recentTopics as recentTopicLabels } from './recentSubjects.ts'
import { latestOptimisationNotes } from './optimisation.ts'
import { recentRejectionFeedback } from './rejectionFeedback.ts'
import {
  MAX_QUEUED_PER_PLATFORM, PLATFORMS, countQueued, facebookWantsImage, nextAvailableSlot,
  primarySourceForPlatform, type PrimarySource,
} from './crhqQueue.ts'

// deno-lint-ignore no-explicit-any
type Admin = any

export const RECYCLE_MAX_AGE_DAYS = 10
export const RECYCLE_MAX_PER_PLATFORM_PER_RUN = 1
export const TOPIC_OVERLAP_SKIP = 0.6
export const RECYCLED_STATUS = 'recycled'
// Deliberately NOT 'rejected' (Adrian, 18 Sep 2026): a rejection is a
// human's decision, and it is not quietly retried unless someone chooses
// to. Recycling is for slots the pipeline itself lost — image exhausted,
// stuck at approved, or never approved in time.
export const RECYCLE_ELIGIBLE_STATUSES = ['draft', 'pending', 'approved']
export const RECYCLED_CONTENT_SOURCE = 'recycled'

export type RecycleReason = 'image_exhausted' | 'stuck_approved' | 'missed'

export interface RecycleCandidate {
  id: string
  platform: string
  status: string
  review_status: string | null
  scheduled_for: string
  created_at: string
  body: string | null
  topic: string | null
  content_source: string | null
  is_manual: boolean | null
  metricool_post_id: string | null
  image_url: string | null
  recycled_at: string | null
  recycled_from: string | null
}

// Why the slot passed unpublished — for the run log only, never control flow.
export function recycleReasonFor(row: Pick<RecycleCandidate, 'status' | 'review_status' | 'image_url'>): RecycleReason {
  if (row.status === 'approved') return 'stuck_approved'
  if (row.review_status === 'needs_attention' && !row.image_url) return 'image_exhausted'
  return 'missed'
}

const STOP_WORDS = new Set(['the', 'and', 'of', 'in', 'on', 'to', 'a', 'an', 'for', 'with', 'by', 'at', 'from', 'is', 'are', 'uk', 'its', 'as', 'or', 'that', 'this', 'into', 'versus', 'vs'])

export function topicWords(text: string | null | undefined): Set<string> {
  return new Set(
    String(text ?? '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/)
      .filter((w) => w.length > 2 && !STOP_WORDS.has(w))
      // Crude stem so "coordination"/"coordinated" and "operations"/"operation"
      // meet — the real 16 Sep pair differed only that way.
      .map((w) => w.replace(/ations?$/, 'at').replace(/(ions?|ing|ed|ies|es|s)$/, (m) => (m === 'ies' ? 'y' : ''))),
  )
}

// Fraction of the original topic's significant words that a later topic
// shares — 1.0 when the later post covers everything the original did.
export function topicOverlap(original: string | null | undefined, later: string | null | undefined): number {
  const a = topicWords(original)
  if (a.size === 0) return 0
  const b = topicWords(later)
  let shared = 0
  for (const w of a) if (b.has(w)) shared++
  return shared / a.size
}

const URL_RE = /https?:\/\/[^\s)]+|(?:youtube\.com|youtu\.be|combatreadyhq\.co\.uk)[^\s)]*/gi
// Normalised (no scheme, no www., no trailing punctuation) so the same link
// written two ways still matches.
export function sourceUrlsIn(body: string | null | undefined): string[] {
  return [...String(body ?? '').matchAll(URL_RE)].map((m) => m[0].replace(/[.,;:)]+$/, '').toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/$/, ''))
}

// A later post on the same platform already tells this story.
export function alreadyCovered(
  original: Pick<RecycleCandidate, 'topic' | 'body'>,
  later: Array<Pick<RecycleCandidate, 'topic' | 'body'>>,
): { covered: boolean; by?: string } {
  const urls = new Set(sourceUrlsIn(original.body).filter((u) => u !== 'combatreadyhq.co.uk'))
  for (const p of later) {
    for (const u of sourceUrlsIn(p.body)) if (urls.has(u)) return { covered: true, by: `same source ${u}` }
    const overlap = topicOverlap(original.topic, p.topic)
    if (overlap >= TOPIC_OVERLAP_SKIP) return { covered: true, by: `topic overlap ${overlap.toFixed(2)} with ${(p as { platform?: string }).platform ? `${(p as { platform?: string }).platform} ` : ''}"${String(p.topic ?? '').slice(0, 60)}"` }
  }
  return { covered: false }
}

export function isEligible(row: RecycleCandidate, now: Date): { ok: boolean; why?: string } {
  if (row.is_manual) return { ok: false, why: 'manual post' }
  if (row.content_source === 'themed_weekly') return { ok: false, why: 'themed weekly post — regenerated on its own cycle' }
  if (row.recycled_at) return { ok: false, why: 'already recycled' }
  if (row.recycled_from) return { ok: false, why: 'is itself a recycled post — one second life only' }
  if (row.metricool_post_id) return { ok: false, why: 'was sent to Metricool' }
  if (!RECYCLE_ELIGIBLE_STATUSES.includes(row.status)) return { ok: false, why: `status ${row.status}` }
  const slot = new Date(row.scheduled_for).getTime()
  if (!(slot < now.getTime())) return { ok: false, why: 'slot still in the future' }
  if (now.getTime() - slot > RECYCLE_MAX_AGE_DAYS * 86_400_000) return { ok: false, why: `slot passed more than ${RECYCLE_MAX_AGE_DAYS} days ago` }
  if (!String(row.topic ?? '').trim() && !String(row.body ?? '').trim()) return { ok: false, why: 'nothing to regenerate from' }
  return { ok: true }
}

// The scrape the original was written from — the cache row written by the
// same nightly run, immediately before the post — so the regeneration can
// cite the real video/article, not a guess. Null when nothing matches.
async function sourceForOriginal(admin: Admin, row: RecycleCandidate): Promise<{ videos: any[]; articles: any[]; primary: PrimarySource | null }> {
  const { data } = await admin
    .from('crhq_scrape_cache')
    .select('scraped_at, videos, articles')
    .lte('scraped_at', row.created_at)
    .order('scraped_at', { ascending: false })
    .limit(1)
  const cache = data?.[0]
  const videos = Array.isArray(cache?.videos) ? cache.videos : []
  const articles = Array.isArray(cache?.articles) ? cache.articles : []
  // Prefer the item the original body actually linked to.
  const urls = sourceUrlsIn(row.body)
  const linked = [...videos.map((v: any) => ({ type: 'video' as const, title: v.title, url: v.url })), ...articles.map((a: any) => ({ type: 'article' as const, title: a.title, url: a.url }))]
    .find((s) => { const su = sourceUrlsIn(String(s.url ?? ''))[0]; return !!su && urls.includes(su) })
  const primary = linked ?? primarySourceForPlatform(row.platform, videos, articles)
  return { videos, articles, primary }
}

export interface RecycleOutcome {
  recycled: Array<{ original: string; into: string; platform: string; reason: RecycleReason; slot: string }>
  notes: string[]
  errors: string[]
}

// dryRun: decide and report everything, write nothing — for verification.
export async function recycleMissedSlots(admin: Admin, client: Record<string, any>, now: Date = new Date(), opts: { dryRun?: boolean } = {}): Promise<RecycleOutcome> {
  const dryRun = opts.dryRun === true
  const out: RecycleOutcome = { recycled: [], notes: [], errors: [] }
  const since = new Date(now.getTime() - RECYCLE_MAX_AGE_DAYS * 86_400_000).toISOString()

  const { data: rows, error } = await admin
    .from('mkt_content_queue')
    .select('id, platform, status, review_status, scheduled_for, created_at, body, topic, content_source, is_manual, metricool_post_id, image_url, recycled_at, recycled_from')
    .eq('client_id', client.id)
    .eq('content_type', 'post')
    .in('platform', PLATFORMS)
    .in('status', RECYCLE_ELIGIBLE_STATUSES)
    .is('metricool_post_id', null)
    .is('recycled_at', null)
    .gte('scheduled_for', since)
    .lt('scheduled_for', now.toISOString())
    .order('scheduled_for', { ascending: false })
  if (error) {
    out.errors.push(`recycle: lookup failed — ${error.message}`)
    return out
  }
  const candidates = (rows ?? []) as RecycleCandidate[]
  if (!candidates.length) return out

  const perPlatform = new Map<string, number>()
  for (const row of candidates) {
    const platform = row.platform
    if ((perPlatform.get(platform) ?? 0) >= RECYCLE_MAX_PER_PLATFORM_PER_RUN) continue

    const elig = isEligible(row, now)
    if (!elig.ok) { out.notes.push(`recycle: ${platform} ${row.id} skipped — ${elig.why}`); continue }

    // Already told since, on ANY platform? Brand-wide, deliberately: the
    // reviewer's own repeat-topic rule is brand-wide ("a queued post counts:
    // it is going to the same audience"), and the first live run proved
    // that a per-platform check just produces a retelling the reviewer then
    // flags as a repeat of the Facebook post about the same story.
    const { data: laterRows } = await admin
      .from('mkt_content_queue')
      .select('id, topic, body, status, platform')
      .eq('client_id', client.id).eq('content_type', 'post')
      .neq('id', row.id)
      // Anything that goes (or went) out from the moment the original was
      // written — not "created after": the Facebook post about the same
      // story from the SAME nightly run is created seconds earlier and
      // would otherwise be missed (12a9a1b4 vs ac3b822f, 16 Sep, 18s apart).
      .gte('scheduled_for', row.created_at)
      .neq('status', 'rejected')
      .neq('status', RECYCLED_STATUS)
      // …and only posts that are alive: sent to Metricool, or still ahead of
      // their slot. A dead draft (slot passed, never sent) covers nothing —
      // it is itself a candidate here, not evidence the story was told.
      .or(`metricool_post_id.not.is.null,scheduled_for.gte.${now.toISOString()}`)
    const covered = alreadyCovered(row, (laterRows ?? []) as RecycleCandidate[])
    if (covered.covered) {
      // Closed off, not left to be re-examined every night.
      if (!dryRun) {
        const { error: closeErr } = await admin.from('mkt_content_queue').update({ recycled_at: now.toISOString(), status: RECYCLED_STATUS }).eq('id', row.id)
        if (closeErr) { out.errors.push(`recycle: could not close ${row.id} (${covered.by}) — ${closeErr.message}`); continue }
      }
      out.notes.push(`recycle: ${platform} ${row.id} not needed — ${covered.by}; ${dryRun ? 'would be closed' : 'closed'}`)
      continue
    }

    const queued = await countQueued(admin, client.id, platform)
    if (queued >= MAX_QUEUED_PER_PLATFORM) { out.notes.push(`recycle: ${platform} queue full (${queued}) — ${row.id} waits`); continue }
    const slotResult = await nextAvailableSlot(admin, client, platform)
    if (!slotResult.slot) { out.notes.push(`recycle: ${platform} no slot in window (${slotResult.reason}) — ${row.id} waits`); continue }
    const slot = slotResult.slot

    const reason = recycleReasonFor(row)
    const source = await sourceForOriginal(admin, row)
    if (dryRun) {
      perPlatform.set(platform, (perPlatform.get(platform) ?? 0) + 1)
      out.recycled.push({ original: row.id, into: '(dry run)', platform, reason, slot: slot.toISOString() })
      out.notes.push(`recycle (dry run): ${platform} ${row.id} (${reason}, topic "${String(row.topic ?? '').slice(0, 60)}") would be regenerated into ${slot.toISOString()} from ${source.primary ? `${source.primary.type} "${source.primary.title.slice(0, 60)}"` : 'no recoverable source (topic + body only)'}`)
      continue
    }
    const [recentTopics, crhqRecentPosts, avoidTopics, optimisationNotes, rejectionFeedback] = await Promise.all([
      recentPublishedSummaries(admin, client.id, 30),
      recentBrandPosts(admin, client.id, { days: 60, limit: 30 }),
      recentTopicLabels(admin, client.id, { days: 30, limit: 12 }),
      latestOptimisationNotes(admin, client.id),
      recentRejectionFeedback(admin, client.id),
    ])
    // The original's own topic must not be in the avoid list, or the model
    // is told to avoid the very story it is being asked to retell.
    const avoid = avoidTopics.filter((t: string) => topicOverlap(row.topic, t) < TOPIC_OVERLAP_SKIP)

    const clientForGeneration = {
      ...client,
      _recent_topics: recentTopics,
      _repeat_prevention_posts: crhqRecentPosts.map((r: { body: string }) => r.body).filter((b: string) => b !== row.body),
      _topics_to_avoid: avoid,
      _crhq_scrape: { videos: source.videos, articles: source.articles },
      _crhq_primary_source: source.primary ?? undefined,
      _crhq_recycle_of: { topic: row.topic, body: row.body, reason },
      _optimisation_notes: optimisationNotes,
      _rejection_feedback: rejectionFeedback,
    }

    const decision = platform === 'facebook' ? await facebookWantsImage(admin, client.id, slot) : { wantsImage: true, because: 'instagram — every post gets an image' }
    const pillar = 'CRHQ latest content'
    // Close the original BEFORE regenerating, so the reviewer's repeat-topic
    // list (recentBrandPosts, which excludes 'recycled') no longer contains
    // the very post being retold. Reverted below if nothing gets inserted.
    const closePatch = { recycled_at: now.toISOString(), status: RECYCLED_STATUS }
    const revertPatch = { recycled_at: null, status: row.status }
    const { error: preCloseErr } = await admin.from('mkt_content_queue').update(closePatch).eq('id', row.id)
    if (preCloseErr) { out.errors.push(`recycle: could not close ${row.id} before regenerating — ${preCloseErr.message}`); continue }
    try {
      const review = await generateReviewedPost(admin, clientForGeneration, platform, pillar)
      if (review.body) review.body = stripMarkdown(review.body)
      const autoApprove = review.ok && client.auto_approve === true
      const base = {
        client_id: client.id, platform, content_type: 'post', pillar, body: review.body || '',
        generated_by: 'cron', scheduled_for: slot.toISOString(), content_source: RECYCLED_CONTENT_SOURCE,
        rejection_feedback_used: rejectionFeedback, topic: review.topic ?? row.topic, recycled_from: row.id,
        generation_attempts: review.attempts, reviewed_at: review.reviewedAt,
      }
      const newRow = review.ok
        ? { ...base, status: autoApprove ? 'approved' : 'draft', review_status: 'passed', ...(autoApprove ? { approved_at: now.toISOString(), approved_by: 'auto' } : {}) }
        : { ...base, status: 'draft', review_status: 'needs_attention', review_reason: review.reason }
      const { data: inserted, error: insertError } = await admin.from('mkt_content_queue').insert(newRow).select('id').single()
      if (insertError) {
        await admin.from('mkt_content_queue').update(revertPatch).eq('id', row.id)
        if ((insertError as { code?: string }).code === '23505') { out.notes.push(`recycle: ${platform} slot ${slot.toISOString()} already taken — ${row.id} waits`); continue }
        out.errors.push(`recycle: ${platform} insert failed for ${row.id} — ${insertError.message}`)
        // A non-slot insert failure is the same for every candidate on this
        // platform tonight (a constraint, a column) — do not spend another
        // generation finding that out. Proven the hard way on 18 Sep: five
        // regenerations, five identical check-constraint failures, no rows.
        perPlatform.set(platform, RECYCLE_MAX_PER_PLATFORM_PER_RUN)
        continue
      }
      const { error: closeError } = await admin.from('mkt_content_queue').update({ recycled_into: inserted.id }).eq('id', row.id)
      if (closeError) out.errors.push(`recycle: could not record recycled_into on ${row.id} — ${closeError.message}`)

      perPlatform.set(platform, (perPlatform.get(platform) ?? 0) + 1)
      out.recycled.push({ original: row.id, into: inserted.id, platform, reason, slot: slot.toISOString() })
      out.notes.push(`recycle: ${platform} ${row.id} (${reason}) → ${inserted.id} for ${slot.toISOString()}${review.ok ? '' : ` — needs attention: ${review.reason}`}`)

      const imagesDisabled = (Array.isArray(client.image_gen_disabled_platforms) ? client.image_gen_disabled_platforms : []).includes(platform)
      if (!imagesDisabled && review.body && decision.wantsImage) {
        await generatePostImage(admin, client, inserted.id, review.body, platform, source.primary?.title ?? row.topic ?? undefined)
        const { data: after } = await admin.from('mkt_content_queue').select('image_url').eq('id', inserted.id).maybeSingle()
        if (!after?.image_url) out.errors.push(`recycle: ${platform} image requested for ${inserted.id} but none was produced (see image_review_events)`)
      }
    } catch (e) {
      await admin.from('mkt_content_queue').update(revertPatch).eq('id', row.id)
      out.errors.push(`recycle: ${platform} ${row.id} — ${String((e as Error)?.message ?? e)}`)
    }
  }
  return out
}
