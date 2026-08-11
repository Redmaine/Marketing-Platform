// Real weekly activity for Adrian Fielding — LinkedIn generation.
//
// Root fix behind unverified_personal_narrative (review.ts) — that check
// catches an invented "something happened this week" claim after the fact;
// this is what stops the model needing to invent one at all, by giving it
// real material to write from.
//
// Schema notes, confirmed against the live project before writing this
// (not assumed from the brief):
//   - No table literally named `blog_posts` exists in this project — the
//     real table is `mkt_blog_posts` (client_id -> mkt_clients), same one
//     recentPublishedBlog (fill.ts) already reads.
//   - `platform_health_log` does not exist either — skipped, and the
//     summary says so explicitly rather than silently omitting the section.
//   - mkt_content_queue's status CHECK constraint has no 'sent' value — its
//     real terminal/live states are 'scheduled' (approved and pushed to
//     Metricool) and 'published'. Both are treated as "went out" here.
//   - "Engagement data" lives in metricool_post_performance, keyed by
//     `brand` (text, matches mkt_clients.name) and `post_id` (text, matches
//     mkt_content_queue.metricool_post_id).
//
// deno-lint-ignore no-explicit-any
type Admin = any

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000

export async function buildRealEventsContext(admin: Admin): Promise<string> {
  const since = new Date(Date.now() - SEVEN_DAYS_MS).toISOString()
  const now = new Date().toISOString()

  const lines: string[] = [
    'REAL EVENTS THIS WEEK — use only these facts as the basis for this post. Do not invent anything not listed here.',
  ]

  // ── Posts published this week, per brand ──────────────────────────────────
  const { data: queueRows } = await admin
    .from('mkt_content_queue')
    .select('metricool_post_id, client:mkt_clients(name)')
    .in('status', ['scheduled', 'published'])
    .gte('scheduled_for', since)
    .lte('scheduled_for', now)

  const countsByBrand = new Map<string, number>()
  const postIdsByBrand = new Map<string, string[]>()
  for (const row of (queueRows ?? []) as Record<string, any>[]) {
    const brandName = row.client?.name ?? 'Unknown'
    countsByBrand.set(brandName, (countsByBrand.get(brandName) ?? 0) + 1)
    if (row.metricool_post_id) {
      const arr = postIdsByBrand.get(brandName) ?? []
      arr.push(String(row.metricool_post_id))
      postIdsByBrand.set(brandName, arr)
    }
  }

  lines.push('')
  if (countsByBrand.size) {
    lines.push('Posts published this week:')
    for (const [brand, count] of countsByBrand) lines.push(`- ${brand} — ${count}`)
  } else {
    lines.push('Posts published this week: none.')
  }

  // Top performing post per brand this week, only if engagement data exists
  // for any of the posts found above — never invented, never a placeholder.
  const allPostIds = [...postIdsByBrand.values()].flat()
  if (allPostIds.length) {
    const { data: perfRows } = await admin
      .from('metricool_post_performance')
      .select('brand, engagement_rate')
      .in('post_id', allPostIds)
      .order('engagement_rate', { ascending: false })
    const topByBrand = new Map<string, number>()
    for (const p of (perfRows ?? []) as Record<string, any>[]) {
      if (!topByBrand.has(p.brand)) topByBrand.set(p.brand, Number(p.engagement_rate))
    }
    if (topByBrand.size) {
      lines.push('Top performing post this week (by engagement rate):')
      for (const [brand, rate] of topByBrand) lines.push(`- ${brand} — ${rate}% engagement rate`)
    }
  }

  // ── Blogs published this week ───────────────────────────────────────────
  const { data: blogRows } = await admin
    .from('mkt_blog_posts')
    .select('title, published_at, client:mkt_clients(name)')
    .eq('status', 'published')
    .not('published_at', 'is', null)
    .gte('published_at', since)
    .lte('published_at', now)

  lines.push('')
  if (blogRows?.length) {
    lines.push('Blogs published this week:')
    for (const b of blogRows as Record<string, any>[]) {
      const brandName = b.client?.name ?? 'Unknown'
      lines.push(`- "${b.title}" — ${brandName} — ${String(b.published_at).slice(0, 10)}`)
    }
  } else {
    lines.push('Blogs published this week: none.')
  }

  // ── Platform health / function failures ────────────────────────────────
  lines.push('')
  lines.push('Platform issues resolved or flagged: platform_health_log does not exist in this project — skipped.')

  // ── Content rejected this week, grouped by brand + reason ─────────────────
  const { data: rejectedRows } = await admin
    .from('mkt_content_queue')
    .select('rejection_reason, client:mkt_clients(name)')
    .eq('status', 'rejected')
    .not('rejection_reason', 'is', null)
    .gte('rejected_at', since)
    .lte('rejected_at', now)

  const rejectionCounts = new Map<string, number>()
  for (const r of (rejectedRows ?? []) as Record<string, any>[]) {
    const brandName = r.client?.name ?? 'Unknown'
    const reason = String(r.rejection_reason || '').trim()
    if (!reason) continue
    const key = `${brandName}|||${reason}`
    rejectionCounts.set(key, (rejectionCounts.get(key) ?? 0) + 1)
  }

  lines.push('')
  if (rejectionCounts.size) {
    lines.push('Content rejected this week:')
    for (const [key, count] of rejectionCounts) {
      const [brandName, reason] = key.split('|||')
      lines.push(`- ${brandName} — ${reason} — ${count}`)
    }
  } else {
    lines.push('Content rejected this week: none.')
  }

  lines.push('')
  lines.push(`Note: Redmaine is a solo operation run by Adrian Fielding. There are no employees, no team members, no customers yet beyond Riverside Sheet Metal and Combat Ready HQ as freebie clients. Any post must be grounded in the facts above or in the honest reality of building a solo AI operation from scratch.`)

  const context = lines.join('\n')

  // Diagnostic (2026-08-10) — the review check on Adrian Fielding LinkedIn
  // posts has passed 9/9 invented-event posts, and this function is the
  // intended fix (give generation real material so it never needs to
  // invent). Raw character count alone can't distinguish "thin, mostly
  // 'none' placeholders" from "genuinely rich" — a context full of "Posts
  // published this week: none." / "Blogs published this week: none." lines
  // is long enough in characters to look substantial while giving the model
  // almost nothing to actually write from. Logging the real signal: how many
  // of the four dynamic sections found actual data versus fell back to a
  // "none" placeholder, so a run can be checked against this instead of
  // guessing between "thin context" and "model ignoring rich context".
  const sectionsWithData = [
    countsByBrand.size > 0,
    allPostIds.length > 0 && context.includes('Top performing post this week'),
    (blogRows?.length ?? 0) > 0,
    rejectionCounts.size > 0,
  ].filter(Boolean).length
  console.log(`[realEvents] buildRealEventsContext: ${context.length} chars, ${sectionsWithData}/4 dynamic sections had real data (posts=${countsByBrand.size > 0}, top_performer=${allPostIds.length > 0 && context.includes('Top performing post this week')}, blogs=${(blogRows?.length ?? 0) > 0}, rejections=${rejectionCounts.size > 0})`)

  return context
}
