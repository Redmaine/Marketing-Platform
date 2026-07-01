// Shared "fill this client's content calendar" logic — used by both
// midnight-cron (daily top-up, capped at MAX_POSTS_PER_RUN globally) and
// backfill-content (one-off manual fill of the full 4-week window).
import { generatePost, nextPillar, isWeekday, addDays, isPlatformConnected } from './generate.ts'

// deno-lint-ignore no-explicit-any
type Admin = any

const TARGET_WINDOW_DAYS = 28
const TARGET_POSTS_PER_CLIENT = 20 // ~5/week x 4 weeks
const SAFETY_MAX_DAYS_WALKED = 45

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

// Walks forward weekday-by-weekday from tomorrow, filling the gap between
// this client's current approved/scheduled post count (in the next 28 days)
// and TARGET_POSTS_PER_CLIENT, never generating more than `budget` posts.
// Rotates pillars via last_pillar_used; hard-blocks disconnected platforms
// (clientPlatforms already filters to connected only).
export async function fillClientGap(admin: Admin, client: Record<string, any>, budget: number): Promise<FillResult> {
  const errors: string[] = []
  if (budget <= 0) return { generated: 0, errors }

  const platforms = await clientPlatforms(admin, client)
  if (platforms.length === 0) {
    return { generated: 0, errors: [`${client.name}: no connected platform to post to`] }
  }
  const platform = platforms[0]

  const now = new Date()
  const windowEnd = addDays(now, TARGET_WINDOW_DAYS)

  const { count: existingCount } = await admin
    .from('mkt_content_queue')
    .select('id', { count: 'exact', head: true })
    .eq('client_id', client.id).eq('content_type', 'post')
    .in('status', ['approved', 'scheduled'])
    .gte('scheduled_for', now.toISOString()).lte('scheduled_for', windowEnd.toISOString())

  const gap = Math.max(0, TARGET_POSTS_PER_CLIENT - (existingCount ?? 0))
  if (gap === 0) return { generated: 0, errors }

  let localLastPillar: string | null = client.last_pillar_used ?? null
  let generated = 0
  let day = addDays(now, 1)
  let daysWalked = 0

  while (generated < gap && generated < budget && daysWalked < SAFETY_MAX_DAYS_WALKED) {
    daysWalked++
    if (day > windowEnd) break
    if (!isWeekday(day)) { day = addDays(day, 1); continue }

    if (await hasQueueRowOnDate(admin, client.id, platform, day)) { day = addDays(day, 1); continue }

    const pillar = nextPillar({ ...client, last_pillar_used: localLastPillar })

    try {
      const body = await generatePost(client, platform, pillar)
      if (!body) { errors.push(`${client.name}: empty AI response`); day = addDays(day, 1); continue }

      const [hh, mm] = String(client.post_time ?? '09:00').split(':')
      const slot = new Date(day); slot.setHours(Number(hh) || 9, Number(mm) || 0, 0, 0)

      const { error } = await admin.from('mkt_content_queue').insert({
        client_id: client.id, platform, content_type: 'post', pillar, body,
        status: 'draft', generated_by: 'cron', scheduled_for: slot.toISOString(),
      })
      if (error) { errors.push(`${client.name}: insert failed — ${error.message}`); day = addDays(day, 1); continue }

      localLastPillar = pillar
      await admin.from('mkt_clients').update({ last_pillar_used: pillar }).eq('id', client.id)
      generated++
    } catch (e) {
      errors.push(`${client.name}: ${String((e as Error)?.message ?? e)}`)
    }
    day = addDays(day, 1)
  }

  return { generated, errors }
}
