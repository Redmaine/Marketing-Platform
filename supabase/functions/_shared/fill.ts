// Shared "fill this client's content calendar" logic — used by both
// midnight-cron (daily top-up, each client given its own budget) and
// backfill-content (one-off manual fill of the full 4-week window).
import { pickDiversePillar, recentPublishedSummaries, dayOfWeekUK, addDays, isPlatformConnected, stripMarkdown } from './generate.ts'
import { generateReviewedPost } from './review.ts'
import { generatePostImage } from './image.ts'

// deno-lint-ignore no-explicit-any
type Admin = any

const TARGET_WINDOW_DAYS = 28
const SAFETY_MAX_DAYS_WALKED = 45

const DAY_NAME_TO_NUM: Record<string, number> = {
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6,
}

// The set of UK weekdays (0=Sun..6=Sat) this client actually posts on, per
// their own posting_frequency setting (client.post_days, e.g.
// ['Monday','Wednesday','Friday']). Falls back to Mon-Fri for clients that
// predate this field so existing behaviour is unchanged for them.
function clientPostingDays(client: Record<string, any>): Set<number> {
  const names: string[] = Array.isArray(client.post_days) ? client.post_days : []
  const nums = names
    .map((n) => DAY_NAME_TO_NUM[String(n).trim().toLowerCase()])
    .filter((n): n is number => n !== undefined)
  return nums.length ? new Set(nums) : new Set([1, 2, 3, 4, 5])
}

// How many posts this client should have queued across the window, based on
// their own posting days — not a flat count assumed for everyone.
function targetPostsForClient(client: Record<string, any>, windowDays: number): number {
  return clientPostingDays(client).size * (windowDays / 7)
}

// The platform(s) this client is scheduled to post on, filtered to only those
// they've actually connected. Falls back to connected_platforms[0] (or
// 'facebook') if the client has no active schedule rows.
export async function clientPlatforms(admin: Admin, client: Record<string, any>): Promise<string[]> {
  const { data: schedules } = await admin
    .from('mkt_content_schedule')
    .select('platform')
    .eq('client_id', client.id)
    .eq('active', true)
  const scheduled = Array.from(new Set((schedules ?? []).map((s: Record<string, any>) => s.platform)))
  const candidates = scheduled.length ? scheduled : (client.connected_platforms || ['facebook'])
  return candidates.filter((p: string) => isPlatformConnected(client, p))
}

// Whether an AUTO-generated post already exists for this brand on this day.
// Fix 2 / Fix 4: the cron generates a maximum of one post per brand per day
// and must skip a brand for a day that already has an auto-generated post.
// Manual posts (generated_by = 'human') are deliberately NOT counted here:
// Adrian can add manual posts freely on any day for any brand, and they must
// neither block the cron nor be blocked by it. Only 'ai' and 'cron' posts,
// in a live (non-rejected) status, count as an existing auto post.
export async function hasAutoPostOnDate(admin: Admin, clientId: string, platform: string, day: Date): Promise<boolean> {
  const dayStart = new Date(day); dayStart.setHours(0, 0, 0, 0)
  const dayEnd = new Date(day); dayEnd.setHours(23, 59, 59, 999)
  const { count } = await admin
    .from('mkt_content_queue')
    .select('id', { count: 'exact', head: true })
    .eq('client_id', clientId).eq('platform', platform).eq('content_type', 'post')
    .in('generated_by', ['ai', 'cron'])
    .neq('status', 'rejected')
    .gte('scheduled_for', dayStart.toISOString()).lte('scheduled_for', dayEnd.toISOString())
  return (count ?? 0) > 0
}

export interface FillResult {
  generated: number
  errors: string[]
}

// Walks forward day-by-day from tomorrow, filling the gap between this
// client's current approved/scheduled post count (in the next 28 days) and
// their own posting-frequency target (targetPostsForClient — derived from
// client.post_days, not a flat count assumed for every client), never
// generating more than `budget` posts. Only generates on the days of the
// week this client actually posts on (clientPostingDays). Rotates pillars
// via last_pillar_used; hard-blocks disconnected platforms (clientPlatforms
// already filters to connected only).
export async function fillClientGap(admin: Admin, client: Record<string, any>, budget: number, windowDays: number = TARGET_WINDOW_DAYS): Promise<FillResult> {
  const errors: string[] = []
  if (budget <= 0) return { generated: 0, errors }

  const platforms = await clientPlatforms(admin, client)
  if (platforms.length === 0) {
    return { generated: 0, errors: [`${client.name}: no connected platform to post to`] }
  }
  const postingDays = clientPostingDays(client)

  const now = new Date()
  const windowEnd = addDays(now, windowDays)

  let generated = 0

  // Fix — a client with more than one connected platform (e.g. Combat Ready
  // HQ: facebook + instagram) previously only ever got platforms[0] filled;
  // instagram never received any auto-generated content at all. Every
  // connected platform now gets its own independent gap-fill pass — its own
  // target/gap, its own day-walk, its own hasAutoPostOnDate guard — sharing
  // the client's overall per-run budget across all of them. For every
  // existing single-platform client this loop runs exactly once, identically
  // to before.
  for (let platformIdx = 0; platformIdx < platforms.length; platformIdx++) {
    const platform = platforms[platformIdx]
    if (generated >= budget) break
    const remainingBudget = budget - generated
    // Fair-share split, not first-come-first-served: divide whatever budget
    // is left evenly across the platforms left (including this one), so an
    // earlier platform with a large gap (e.g. facebook, catching up from
    // nothing) can't consume the entire shared budget and leave later
    // platforms (e.g. instagram) with zero on THIS run — they now get their
    // fair share on the same run a gap exists, not just "eventually" once
    // the earlier platform's gap happens to shrink. A platform whose own gap
    // is smaller than its share still only uses what it needs — the
    // unspent remainder naturally rolls forward via `remainingBudget` on the
    // next iteration, divided across however many platforms are left.
    const platformsLeft = platforms.length - platformIdx
    const platformBudget = Math.min(remainingBudget, Math.ceil(remainingBudget / platformsLeft))

    // Root-cause fix: this used to only count status in ('approved',
    // 'scheduled'), so a post this same function already generated as
    // 'draft' (every fresh insert below starts as 'draft' — see row.status)
    // was invisible to the gap calculation. Any client with an approval
    // backlog therefore looked like it had a permanent, near-full gap every
    // single night — the cron re-attempted close to a full budget's worth
    // of generation for that client indefinitely. Two consequences, both
    // confirmed live: (1) for a client with 2+ connected platforms sharing
    // one `budget` across this whole loop (e.g. Combat Ready HQ — facebook
    // + instagram), the first platform processed could permanently consume
    // the entire shared budget, leaving nothing for the rest — instagram
    // never got a single post; (2) the nightly run took far longer than it
    // needed to across every client, which lines up with midnight-cron's own
    // run log (mkt_cron_log) going silent for days at a time despite content
    // clearly still being generated — consistent with runs overrunning
    // before reaching their own final log write, and a real duplicate was
    // found (two posts, same client/platform/day, inserted 5 seconds apart
    // in one run). Counting anything not-rejected here — matching
    // hasAutoPostOnDate's own definition of "already filled" just below —
    // fixes the gap at the source instead of adding another guard on top.
    const { count: existingCount } = await admin
      .from('mkt_content_queue')
      .select('id', { count: 'exact', head: true })
      .eq('client_id', client.id).eq('platform', platform).eq('content_type', 'post')
      .neq('status', 'rejected')
      .gte('scheduled_for', now.toISOString()).lte('scheduled_for', windowEnd.toISOString())

    const gap = Math.max(0, targetPostsForClient(client, windowDays) - (existingCount ?? 0))
    if (gap === 0) continue

    // Fix 4 — pillars used earlier in this same fill run, so consecutive posts
    // don't repeat a pillar even before any of them are published. recentTopics
    // seeds the generator with what to avoid (published history + posts produced
    // earlier in this run).
    const usedThisRun: string[] = []
    const recentTopics: string[] = await recentPublishedSummaries(admin, client.id, 6)
    let generatedForPlatform = 0
    let day = addDays(now, 1)
    let daysWalked = 0

    while (generatedForPlatform < gap && generatedForPlatform < platformBudget && daysWalked < SAFETY_MAX_DAYS_WALKED) {
      daysWalked++
      if (day > windowEnd) break
      if (!postingDays.has(dayOfWeekUK(day))) { day = addDays(day, 1); continue }

      // Skip this brand+platform for this day if an auto-generated post
      // already exists — one auto post per brand per platform per day.
      // Manual posts do not count (see above).
      if (await hasAutoPostOnDate(admin, client.id, platform, day)) { day = addDays(day, 1); continue }

      // A pillar that differs from the brand's last three published posts and
      // from anything already generated in this run.
      const pillar = await pickDiversePillar(admin, client, usedThisRun)

      try {
        // Item 3: every post is reviewed before it reaches the queue. A pass is
        // queued with a "passed" badge; two failures queue a "needs_attention"
        // placeholder (still fills the slot so we don't loop it) with the reason
        // shown to Adrian. The generator is shown recent topics (Fix 4) via the
        // client object so it steers away from them — no review-step change.
        const review = await generateReviewedPost(admin, { ...client, _recent_topics: recentTopics }, platform, pillar)
        // Hard backstop — strip any markdown the model still produced despite
        // FORMAT_RULES and the review step's retry, so it never reaches a
        // live post (see stripMarkdown in generate.ts).
        if (review.body) review.body = stripMarkdown(review.body)

        const [hh, mm] = String(client.post_time ?? '09:00').split(':')
        const slot = new Date(day); slot.setHours(Number(hh) || 9, Number(mm) || 0, 0, 0)

        const row = review.ok
          ? {
              client_id: client.id, platform, content_type: 'post', pillar, body: review.body,
              status: 'draft', generated_by: 'cron', scheduled_for: slot.toISOString(),
              review_status: 'passed', reviewed_at: review.reviewedAt, generation_attempts: review.attempts,
            }
          : {
              client_id: client.id, platform, content_type: 'post', pillar, body: review.body || '',
              status: 'draft', generated_by: 'cron', scheduled_for: slot.toISOString(),
              review_status: 'needs_attention', reviewed_at: review.reviewedAt,
              review_reason: review.reason, generation_attempts: review.attempts,
            }

        const { data: inserted, error } = await admin.from('mkt_content_queue').insert(row).select('id').single()
        if (error) { errors.push(`${client.name}: insert failed — ${error.message}`); day = addDays(day, 1); continue }
        if (!review.ok) errors.push(`${client.name}: needs attention — ${review.reason}`)

        // Image generation is best-effort and never blocks or fails the post —
        // generatePostImage swallows its own errors and leaves image_url null
        // (the column's default) on any failure. See _shared/image.ts.
        if (review.body) await generatePostImage(admin, client, inserted.id, review.body, platform)

        usedThisRun.push(pillar)
        // Keep the just-generated post in view so the next post in this run
        // avoids repeating it too (it isn't in published_posts yet).
        if (review.body) recentTopics.unshift(`[${pillar}] ${review.body.replace(/\s+/g, ' ').trim().slice(0, 140)}`)
        await admin.from('mkt_clients').update({ last_pillar_used: pillar }).eq('id', client.id)
        generatedForPlatform++
        generated++
      } catch (e) {
        errors.push(`${client.name}: ${String((e as Error)?.message ?? e)}`)
      }
      day = addDays(day, 1)
    }
  }

  return { generated, errors }
}
