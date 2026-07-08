// Shared "fill this client's content calendar" logic — used by both
// midnight-cron (daily top-up, each client given its own budget) and
// backfill-content (one-off manual fill of the full 4-week window).
import { pickDiversePillar, recentPublishedSummaries, dayOfWeekUK, addDays, isPlatformConnected } from './generate.ts'
import { generateReviewedPost } from './review.ts'

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

async function hasQueueRowOnDate(admin: Admin, clientId: string, platform: string, day: Date): Promise<boolean> {
  const dayStart = new Date(day); dayStart.setHours(0, 0, 0, 0)
  const dayEnd = new Date(day); dayEnd.setHours(23, 59, 59, 999)
  const { count } = await admin
    .from('mkt_content_queue')
    .select('id', { count: 'exact', head: true })
    .eq('client_id', clientId).eq('platform', platform).eq('content_type', 'post')
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
  const platform = platforms[0]
  const postingDays = clientPostingDays(client)

  const now = new Date()
  const windowEnd = addDays(now, windowDays)

  const { count: existingCount } = await admin
    .from('mkt_content_queue')
    .select('id', { count: 'exact', head: true })
    .eq('client_id', client.id).eq('content_type', 'post')
    .in('status', ['approved', 'scheduled'])
    .gte('scheduled_for', now.toISOString()).lte('scheduled_for', windowEnd.toISOString())

  const gap = Math.max(0, targetPostsForClient(client, windowDays) - (existingCount ?? 0))
  if (gap === 0) return { generated: 0, errors }

  // Fix 4 — pillars used earlier in this same fill run, so consecutive posts
  // don't repeat a pillar even before any of them are published. recentTopics
  // seeds the generator with what to avoid (published history + posts produced
  // earlier in this run).
  const usedThisRun: string[] = []
  const recentTopics: string[] = await recentPublishedSummaries(admin, client.id, 6)
  let generated = 0
  let day = addDays(now, 1)
  let daysWalked = 0

  while (generated < gap && generated < budget && daysWalked < SAFETY_MAX_DAYS_WALKED) {
    daysWalked++
    if (day > windowEnd) break
    if (!postingDays.has(dayOfWeekUK(day))) { day = addDays(day, 1); continue }

    if (await hasQueueRowOnDate(admin, client.id, platform, day)) { day = addDays(day, 1); continue }

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

      const { error } = await admin.from('mkt_content_queue').insert(row)
      if (error) { errors.push(`${client.name}: insert failed — ${error.message}`); day = addDays(day, 1); continue }
      if (!review.ok) errors.push(`${client.name}: needs attention — ${review.reason}`)

      usedThisRun.push(pillar)
      // Keep the just-generated post in view so the next post in this run
      // avoids repeating it too (it isn't in published_posts yet).
      if (review.body) recentTopics.unshift(`[${pillar}] ${review.body.replace(/\s+/g, ' ').trim().slice(0, 140)}`)
      await admin.from('mkt_clients').update({ last_pillar_used: pillar }).eq('id', client.id)
      generated++
    } catch (e) {
      errors.push(`${client.name}: ${String((e as Error)?.message ?? e)}`)
    }
    day = addDays(day, 1)
  }

  return { generated, errors }
}
