// Per-platform posting schedule, read from mkt_content_schedule.
//
// Extracted from _shared/fill.ts (18 Aug 2026) so the dispatch path can use it
// too. schedule-to-metricool needs exactly this and nothing else; importing
// fill.ts to get it would pull in generate.ts -> review.ts -> image.ts and the
// vendored imagescript bundle, none of which a dispatch function should carry.
// fill.ts re-exports from here, so its existing consumers are unchanged and
// there is still one definition rather than two that can drift apart.
//
// A brand's cadence is genuinely per-platform: CRHQ posts to Facebook on
// Tue/Thu/Sat at 18:00 and to Instagram on Mon/Tue/Thu/Fri at 07:30. Anything
// choosing a slot has to consult THIS, keyed by platform — not
// mkt_clients.post_time, which is a single brand-wide default and cannot
// express a per-platform time. Reaching for that default is what put a CRHQ
// Facebook post at 07:00 (CRHQ's post_time) instead of its real 18:00 slot.

// deno-lint-ignore no-explicit-any
type Admin = any

export interface PlatformSchedule {
  days: Set<number>              // 0 = Sunday .. 6 = Saturday
  timeByDay: Map<number, string> // day -> "HH:MM"
}

// Returns null when this client+platform has no active schedule rows, which
// callers treat as "fall back to the client-wide post_days/post_time" — the
// pre-existing behaviour for brands that were never given per-platform rows.
//
// timeByDay is keyed per day because the schema allows a different time_uk per
// row, so a platform can legitimately post at different times on different
// days.
export async function platformSchedule(
  admin: Admin,
  client: Record<string, any>,
  platform: string,
): Promise<PlatformSchedule | null> {
  const { data } = await admin
    .from('mkt_content_schedule')
    .select('day_of_week, time_uk')
    .eq('client_id', client.id)
    .eq('platform', platform)
    .eq('active', true)

  const rows = data ?? []
  if (!rows.length) return null

  const days = new Set<number>()
  const timeByDay = new Map<number, string>()
  for (const r of rows) {
    const d = Number(r.day_of_week)
    if (!Number.isInteger(d) || d < 0 || d > 6) continue
    days.add(d)
    const t = String(r.time_uk || '').trim()
    // First usable time wins for a day that somehow has more than one row.
    if (t && !timeByDay.has(d)) timeByDay.set(d, t)
  }

  // Rows existed but none carried a valid day — treat as "no schedule" rather
  // than generating nothing at all for this platform.
  if (!days.size) return null
  return { days, timeByDay }
}
