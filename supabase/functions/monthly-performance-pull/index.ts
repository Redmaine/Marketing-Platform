// Supabase Edge Function: monthly-performance-pull  (Deno) — runs 1st of
// every month at 06:00 via pg_cron, for the PREVIOUS calendar month.
//
// The learning loop: pull what actually happened -> tell the client in plain
// English -> feed it back into what gets generated next month. Per active
// client:
//   1. Pull Metricool post analytics for last month -> mkt_post_performance
//      (see _shared/metricool-v2.ts — the real, empirically-verified
//      endpoints; this function previously called the old _shared/metricool.ts,
//      whose guessed paths 404 against the live API, which is why every
//      brand's pull silently failed and July's reports had to be done by
//      hand. Migrated 8 Aug 2026, same pattern as metricool-weekly-pull.
//      Instagram follower_change is always null — Metricool's v2 API has no
//      historical followers timeline for Instagram, only Facebook).
//   2. Generate a plain-English report via Claude -> mkt_monthly_reports.
//   3. Derive next month's content weighting -> mkt_client_optimisation,
//      read by fill.ts / crhq-nightly-content (_shared/optimisation.ts) and
//      folded into the system prompt.
// Then one combined email — every brand's report — to hello@yourcompanyai.co.uk.
//
// A client with zero posts pulled for the month still gets a minimal report
// (so a quiet brand doesn't just silently vanish from the email) but no
// optimisation row — there's no pillar/timing signal to derive from an empty
// month, so the previous month's notes simply carry forward untouched (see
// latestOptimisationNotes's "most recent row" lookup).
//
// Deploy:  supabase functions deploy monthly-performance-pull
// Schedule: see 57_monthly_performance_pipeline.sql.
// Secrets (Supabase vault): METRICOOL_API_KEY, ANTHROPIC_API_KEY, RESEND_API_KEY.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { callAnthropic } from '../_shared/generate.ts'
import { fetchPosts, fetchTimeline, MetricoolNoConnectionError } from '../_shared/metricool-v2.ts'

// deno-lint-ignore no-explicit-any
type Admin = any

const FROM = 'Your Company AI <hello@yourcompanyai.co.uk>'
const REPORT_RECIPIENT = 'hello@yourcompanyai.co.uk'
const ANALYTICS_PLATFORMS = ['facebook', 'instagram']

const REPORT_SYSTEM_PROMPT = `You are Quill's performance analyst. You write clear, direct monthly performance reports for social media clients. No fluff, no corporate language. Tell the client what happened, what worked, what did not, and what changes are being made. Maximum 400 words per brand.`

const esc = (s: unknown) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

interface PulledPost {
  metricool_post_id: string
  platform: string
  published_at: string | null
  pillar: string | null
  body: string | null
  reach: number | null
  impressions: number | null
  likes: number | null
  comments: number | null
  shares: number | null
  engagement_rate: number | null
  follower_change: number | null
}

function monthBoundsUTC(monthsAgo: number, from: Date): { start: Date; end: Date; monthYear: string; label: string } {
  const start = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() - monthsAgo, 1))
  const end = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() - monthsAgo + 1, 1))
  const monthYear = `${start.getUTCFullYear()}-${String(start.getUTCMonth() + 1).padStart(2, '0')}`
  const label = start.toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' })
  return { start, end, monthYear, label }
}

function engagementRate(likes: number | null, comments: number | null, shares: number | null, reach: number | null): number | null {
  if (!reach || reach <= 0) return null
  const total = (likes ?? 0) + (comments ?? 0) + (shares ?? 0)
  return (total / reach) * 100
}

function hourUK(iso: string): number | null {
  const d = new Date(iso)
  if (isNaN(d.getTime())) return null
  return Number(new Intl.DateTimeFormat('en-GB', { hour: 'numeric', hour12: false, timeZone: 'Europe/London' }).format(d))
}

function dayNameUK(iso: string): string | null {
  const d = new Date(iso)
  if (isNaN(d.getTime())) return null
  return new Intl.DateTimeFormat('en-GB', { weekday: 'long', timeZone: 'Europe/London' }).format(d)
}

// Highest-average-engagement bucket from a list of posts, grouped by
// `keyFn(post)`. Returns null when no post has both a valid key and a valid
// engagement_rate. Small sample sizes (a brand with few posts that month)
// make this noisy — no minimum-count threshold is applied, per spec; treat a
// single-post "best day" with appropriate scepticism.
function bestBucket(posts: PulledPost[], keyFn: (p: PulledPost) => string | null): string | null {
  const sums = new Map<string, { total: number; count: number }>()
  for (const p of posts) {
    const key = keyFn(p)
    if (key == null || p.engagement_rate == null) continue
    const entry = sums.get(key) ?? { total: 0, count: 0 }
    entry.total += p.engagement_rate
    entry.count += 1
    sums.set(key, entry)
  }
  let best: string | null = null
  let bestAvg = -Infinity
  for (const [key, { total, count }] of sums) {
    const avg = total / count
    if (avg > bestAvg) { bestAvg = avg; best = key }
  }
  return best
}

// Maps one raw Metricool v2 post to the fields this function needs — same
// field names/shapes as mapFacebookPost/mapInstagramPost in
// metricool-weekly-pull/index.ts (the empirically-verified mapping; kept in
// sync deliberately rather than importing across function boundaries).
function mapPlatformPost(
  network: string,
  p: Record<string, unknown>,
): { metricool_post_id: string; published_at: string | null; reach: number | null; impressions: number | null; likes: number | null; comments: number | null; shares: number | null } {
  if (network === 'facebook') {
    return {
      metricool_post_id: String(p.postId ?? ''),
      published_at: (p.created as { dateTime?: string } | undefined)?.dateTime ?? null,
      reach: Number(p.impressionsUnique ?? 0),
      impressions: Number(p.impressions ?? 0),
      likes: Number(p.like ?? 0),
      comments: Number(p.comments ?? 0),
      shares: Number(p.shares ?? 0),
    }
  }
  return {
    metricool_post_id: String(p.postId ?? ''),
    published_at: (p.publishedAt as { dateTime?: string } | undefined)?.dateTime ?? null,
    reach: Number(p.reach ?? 0),
    impressions: Number(p.impressionsTotal ?? p.impressions ?? 0),
    likes: Number(p.likes ?? 0),
    comments: Number(p.comments ?? 0),
    shares: Number(p.shares ?? 0),
  }
}

// Historical follower count change over the month. Only Facebook exposes a
// usable timeline metric (pageFollows, subject=account) via the v2 API —
// same documented gap as metricool-weekly-pull's follower_change_7d/30d:
// Instagram has no equivalent account-level followers timeline, so its
// change is left null (current count is still accurate elsewhere, just not
// a month-over-month delta).
async function fetchFollowerChange(network: string, blogId: string, start: Date, end: Date): Promise<number | null> {
  if (network !== 'facebook') return null
  const values = await fetchTimeline('facebook', 'pageFollows', 'account', blogId, start.toISOString().slice(0, 19), end.toISOString().slice(0, 19))
  if (values.length === 0) return null
  return values[values.length - 1].value - values[0].value
}

// ── Per-client pull ──────────────────────────────────────────────────────
async function pullClientPosts(
  admin: Admin,
  client: Record<string, any>,
  start: Date,
  end: Date,
): Promise<{ posts: PulledPost[]; errors: string[] }> {
  const errors: string[] = []
  const brandId = client.metricool_brand_id
  if (!brandId) return { posts: [], errors: [`${client.name}: no metricool_brand_id set — cannot pull analytics`] }

  const connected: string[] = Array.isArray(client.connected_platforms) ? client.connected_platforms : []
  const platforms = ANALYTICS_PLATFORMS.filter((p) => connected.includes(p))
  if (platforms.length === 0) return { posts: [], errors: [] }

  const raw: Array<{ platform: string; stat: { metricool_post_id: string; published_at: string | null; reach: number | null; impressions: number | null; likes: number | null; comments: number | null; shares: number | null } }> = []
  const followerChangeByPlatform: Record<string, number | null> = {}

  for (const platform of platforms) {
    try {
      const rawPosts = await fetchPosts(platform, String(brandId), start.toISOString().slice(0, 19), end.toISOString().slice(0, 19))
      for (const p of rawPosts) {
        const stat = mapPlatformPost(platform, p)
        if (stat.metricool_post_id) raw.push({ platform, stat })
      }
    } catch (e) {
      if (e instanceof MetricoolNoConnectionError) {
        console.log(`[monthly-performance-pull] ${client.name}/${platform}: not connected, skipping`)
        continue
      }
      errors.push(`${client.name} (${platform}): ${String((e as Error)?.message ?? e)}`)
      continue
    }

    try {
      followerChangeByPlatform[platform] = await fetchFollowerChange(platform, String(brandId), start, end)
    } catch (e) {
      errors.push(`${client.name} (${platform} follower change): ${String((e as Error)?.message ?? e)}`)
      followerChangeByPlatform[platform] = null
    }
  }

  if (raw.length === 0) return { posts: [], errors }

  // Batch pillar/body lookup — one query per client, not one per post. Per
  // spec: "pillar (from mkt_content_queue if matched by metricool_post_id)".
  const ids = Array.from(new Set(raw.map((r) => r.stat.metricool_post_id).filter(Boolean)))
  const { data: matched } = await admin
    .from('mkt_content_queue')
    .select('metricool_post_id, pillar, body')
    .eq('client_id', client.id)
    .in('metricool_post_id', ids)
  const byId = new Map<string, { pillar: string | null; body: string | null }>(
    (matched ?? []).map((r: Record<string, any>) => [String(r.metricool_post_id), { pillar: r.pillar ?? null, body: r.body ?? null }])
  )

  const posts: PulledPost[] = raw.map(({ platform, stat }) => {
    const m = byId.get(stat.metricool_post_id)
    return {
      metricool_post_id: stat.metricool_post_id,
      platform,
      published_at: stat.published_at,
      pillar: m?.pillar ?? null,
      body: m?.body ?? null,
      reach: stat.reach,
      impressions: stat.impressions,
      likes: stat.likes,
      comments: stat.comments,
      shares: stat.shares,
      engagement_rate: engagementRate(stat.likes, stat.comments, stat.shares, stat.reach),
      follower_change: followerChangeByPlatform[platform] ?? null,
    }
  })

  return { posts, errors }
}

// ── Report + optimisation generation ────────────────────────────────────
function excerpt(body: string | null, n = 200): string {
  const s = String(body || '').replace(/\s+/g, ' ').trim()
  return s.length > n ? s.slice(0, n) + '…' : s
}

async function buildReport(
  client: Record<string, any>,
  posts: PulledPost[],
  monthLabel: string,
  prevAvgEngagement: number | null,
): Promise<{ reportText: string; top: PulledPost[]; bottom: PulledPost[]; avgEngagement: number; followerChangeTotal: number; platformBreakdown: Array<{ platform: string; posts: number; avg_engagement_rate: number | null }> }> {
  const rated = posts.filter((p) => p.engagement_rate != null)
  const sorted = [...rated].sort((a, b) => (b.engagement_rate ?? 0) - (a.engagement_rate ?? 0))
  const top = sorted.slice(0, 3)
  const bottom = sorted.slice(-3).reverse()
  const avgEngagement = rated.length ? rated.reduce((s, p) => s + (p.engagement_rate ?? 0), 0) / rated.length : 0

  // follower_change is stored per-platform on each post row (see the file
  // header); the report's single "follower change" figure is the sum across
  // this brand's platforms for the month.
  const platformSet = Array.from(new Set(posts.map((p) => p.platform)))
  const followerChangeTotal = platformSet.reduce((sum, plat) => {
    const v = posts.find((p) => p.platform === plat)?.follower_change
    return sum + (v ?? 0)
  }, 0)

  const platformBreakdown = platformSet.map((platform) => {
    const platPosts = posts.filter((p) => p.platform === platform)
    const platRated = platPosts.filter((p) => p.engagement_rate != null)
    return {
      platform,
      posts: platPosts.length,
      avg_engagement_rate: platRated.length ? platRated.reduce((s, p) => s + (p.engagement_rate ?? 0), 0) / platRated.length : null,
    }
  })

  const fmt = (p: PulledPost, i: number) =>
    `${i + 1}. [${p.pillar || 'n/a'}] (${p.platform}, ${p.engagement_rate!.toFixed(1)}% engagement): "${excerpt(p.body)}"`

  const userMessage = [
    `Brand: ${client.name}`,
    `Active platforms: ${platformSet.join(', ') || 'none'}`,
    `Total posts published in ${monthLabel}: ${posts.length}`,
    '',
    'Top 3 performing posts (by engagement rate):',
    top.length ? top.map(fmt).join('\n') : '(no rated posts)',
    '',
    'Bottom 3 performing posts (by engagement rate):',
    bottom.length ? bottom.map(fmt).join('\n') : '(no rated posts)',
    '',
    prevAvgEngagement != null
      ? `Average engagement rate: ${avgEngagement.toFixed(2)}% (previous month: ${prevAvgEngagement.toFixed(2)}%)`
      : `Average engagement rate: ${avgEngagement.toFixed(2)}% (no previous month to compare — this is the first month of data)`,
    `Follower change this month: ${followerChangeTotal >= 0 ? '+' : ''}${followerChangeTotal}`,
    '',
    'Platform breakdown:',
    platformBreakdown.map((b) => `- ${b.platform}: ${b.posts} posts, ${b.avg_engagement_rate != null ? b.avg_engagement_rate.toFixed(1) + '% avg engagement' : 'no rated posts'}`).join('\n'),
  ].join('\n')

  const reportText = posts.length
    ? await callAnthropic(REPORT_SYSTEM_PROMPT, userMessage, 900)
    : `No posts were published for ${client.name} in ${monthLabel}. Nothing to report against this month — check the content queue if this wasn't expected.`

  return { reportText, top, bottom, avgEngagement, followerChangeTotal, platformBreakdown }
}

const OPTIMISATION_SYSTEM_PROMPT = `You are Quill's content strategist. Based on one brand's performance data for the last month, write ONE short, direct paragraph (2-4 sentences) instructing how content generation should change next month. Where the data supports it, state a specific comparison (e.g. "X posts outperform Y posts 3:1") and a specific instruction. No fluff, no hedging, no corporate language.`

async function buildOptimisation(
  client: Record<string, any>,
  posts: PulledPost[],
  avgEngagement: number,
): Promise<{ topPillars: string[]; underPillars: string[]; bestTime: string | null; bestDay: string | null; contentNotes: string }> {
  const pillarStats = new Map<string, { total: number; count: number }>()
  for (const p of posts) {
    if (!p.pillar || p.engagement_rate == null) continue
    const entry = pillarStats.get(p.pillar) ?? { total: 0, count: 0 }
    entry.total += p.engagement_rate
    entry.count += 1
    pillarStats.set(p.pillar, entry)
  }

  const topPillars: string[] = []
  const underPillars: string[] = []
  for (const [pillar, { total, count }] of pillarStats) {
    const avg = total / count
    if (avg > avgEngagement) topPillars.push(pillar)
    else if (avg < avgEngagement) underPillars.push(pillar)
  }

  const bestTimeHour = bestBucket(posts, (p) => (p.published_at ? String(hourUK(p.published_at) ?? '') : null))
  const bestTime = bestTimeHour ? `${bestTimeHour.padStart(2, '0')}:00` : null
  const bestDay = bestBucket(posts, (p) => (p.published_at ? dayNameUK(p.published_at) : null))

  if (!pillarStats.size) {
    return { topPillars, underPillars, bestTime, bestDay, contentNotes: '' }
  }

  const pillarStatsText = Array.from(pillarStats.entries())
    .map(([pillar, { total, count }]) => `- ${pillar}: ${(total / count).toFixed(1)}% avg engagement across ${count} post(s)`)
    .join('\n')

  const notesUser = [
    `Brand: ${client.name}`,
    'Pillar performance this month (avg engagement rate):',
    pillarStatsText,
    `Overall average: ${avgEngagement.toFixed(2)}%`,
    bestTime ? `Best time to post: ${bestTime}` : '',
    bestDay ? `Best day to post: ${bestDay}` : '',
  ].filter(Boolean).join('\n')

  const contentNotes = await callAnthropic(OPTIMISATION_SYSTEM_PROMPT, notesUser, 300)
  return { topPillars, underPillars, bestTime, bestDay, contentNotes }
}

// ── Email ────────────────────────────────────────────────────────────────
interface BrandEmailSection {
  name: string
  tier: string | null
  totalPosts: number
  avgEngagement: number
  followerChangeTotal: number
  reportText: string
  topExcerpt: string | null
}

function buildEmailHtml(sections: BrandEmailSection[], monthLabel: string): string {
  let html = `<div style="font-family:Arial,sans-serif;color:#1C2B3A;max-width:640px">`
  html += `<h2 style="color:#1C2B3A;margin:0 0 4px">Quill Monthly Report</h2>`
  html += `<p style="color:#8FA3B1;margin:0 0 20px">${esc(monthLabel)} · ${sections.length} brand${sections.length === 1 ? '' : 's'}</p>`

  for (const s of sections) {
    html += `<div style="border:1px solid #E5E9EC;border-radius:10px;padding:16px 18px;margin-bottom:16px">`
    html += `<div style="font-size:16px;font-weight:700">${esc(s.name)}${s.tier ? ` <span style="color:#8FA3B1;font-weight:400;font-size:13px">· ${esc(s.tier)}</span>` : ''}</div>`
    html += `<div style="color:#8FA3B1;font-size:13px;margin:6px 0 12px">${s.totalPosts} post${s.totalPosts === 1 ? '' : 's'} published · ${s.avgEngagement.toFixed(1)}% avg engagement · ${s.followerChangeTotal >= 0 ? '+' : ''}${s.followerChangeTotal} followers</div>`
    html += `<div style="font-size:14px;color:#2E4057;white-space:pre-wrap;line-height:1.5">${esc(s.reportText)}</div>`
    if (s.topExcerpt) {
      html += `<div style="margin-top:12px;padding:10px 12px;background:#F7F9FA;border-left:4px solid #E8410A;border-radius:6px;font-size:13px;color:#2E4057">`
      html += `<strong>Top performing post:</strong> ${esc(s.topExcerpt)}`
      html += `</div>`
    }
    html += `</div>`
  }

  html += `</div>`
  return html
}

async function sendReportEmail(sections: BrandEmailSection[], monthLabel: string): Promise<string | null> {
  const resendKey = Deno.env.get('RESEND_API_KEY')
  if (!resendKey) return 'RESEND_API_KEY not configured — report email not sent'
  const html = buildEmailHtml(sections, monthLabel)
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: FROM, to: REPORT_RECIPIENT, subject: `Quill Monthly Report — ${monthLabel}`, html }),
  })
  if (!r.ok) {
    const detail = await r.text()
    return `Resend rejected the monthly report email: ${detail.slice(0, 300)}`
  }
  return null
}

// ── Handler ──────────────────────────────────────────────────────────────
serve(async () => {
  const started = Date.now()
  const errors: string[] = []
  const notes: string[] = []
  let clientsProcessed = 0
  const emailSections: BrandEmailSection[] = []

  const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
  const apiKey = Deno.env.get('METRICOOL_API_KEY')

  const { start, end, monthYear, label: monthLabel } = monthBoundsUTC(1, new Date())
  const { monthYear: prevMonthYear } = monthBoundsUTC(2, new Date())

  try {
    if (!apiKey) throw new Error('METRICOOL_API_KEY not configured in Supabase vault')

    const { data: clients, error: clientsError } = await admin
      .from('mkt_clients')
      .select('id, name, tier, connected_platforms, metricool_brand_id, active')
      .eq('active', true)
      .order('name')
    if (clientsError) throw new Error(`could not load active clients: ${clientsError.message}`)
    console.log(`[monthly-performance-pull] starting run for ${monthLabel} — ${clients?.length ?? 0} active client(s)`)

    for (const client of clients ?? []) {
      clientsProcessed++
      try {
        const { posts, errors: pullErrors } = await pullClientPosts(admin, client, start, end)
        if (pullErrors.length) { errors.push(...pullErrors); for (const e of pullErrors) console.error(`[monthly-performance-pull] ${e}`) }

        if (posts.length) {
          // The onConflict target below matches mkt_post_performance_uniq, a
          // PARTIAL unique index (WHERE metricool_post_id IS NOT NULL — see
          // the migration). That's only a valid upsert arbiter for rows that
          // satisfy the predicate. Safe here because pullClientPosts already
          // drops any post with no id (the `if (stat.metricool_post_id)`
          // check above) before it reaches `posts` — every row below always
          // has one. Don't remove that upstream filter without also handling
          // null metricool_post_id here.
          const rows = posts.map((p) => ({
            client_id: client.id,
            metricool_post_id: p.metricool_post_id || null,
            platform: p.platform,
            published_at: p.published_at,
            content_type: p.platform, // per spec — same value as `platform`, see table comment
            pillar: p.pillar,
            reach: p.reach,
            impressions: p.impressions,
            likes: p.likes,
            comments: p.comments,
            shares: p.shares,
            engagement_rate: p.engagement_rate,
            follower_change: p.follower_change,
            month_year: monthYear,
          }))
          const { error: perfError } = await admin
            .from('mkt_post_performance')
            .upsert(rows, { onConflict: 'client_id,metricool_post_id,month_year', ignoreDuplicates: false })
          if (perfError) errors.push(`${client.name}: mkt_post_performance upsert failed — ${perfError.message}`)
        }

        const { data: prevReport } = await admin
          .from('mkt_monthly_reports')
          .select('avg_engagement_rate')
          .eq('client_id', client.id)
          .eq('month_year', prevMonthYear)
          .maybeSingle()

        const { reportText, top, bottom, avgEngagement, followerChangeTotal, platformBreakdown } =
          await buildReport(client, posts, monthLabel, prevReport?.avg_engagement_rate ?? null)

        const { error: reportError } = await admin.from('mkt_monthly_reports').upsert({
          client_id: client.id,
          month_year: monthYear,
          report_text: reportText,
          top_performers: top,
          bottom_performers: bottom,
          avg_engagement_rate: avgEngagement,
          follower_change: followerChangeTotal,
          generated_at: new Date().toISOString(),
        }, { onConflict: 'client_id,month_year' })
        if (reportError) errors.push(`${client.name}: mkt_monthly_reports upsert failed — ${reportError.message}`)

        // No posts this month — no signal to derive pillar/timing weighting
        // from. Skip the optimisation write so latestOptimisationNotes keeps
        // returning last month's (still-relevant) notes rather than this
        // being overwritten with nothing.
        if (posts.length) {
          const { topPillars, underPillars, bestTime, bestDay, contentNotes } = await buildOptimisation(client, posts, avgEngagement)
          const { error: optError } = await admin.from('mkt_client_optimisation').upsert({
            client_id: client.id,
            month_year: monthYear,
            top_performing_pillars: topPillars,
            underperforming_pillars: underPillars,
            best_post_time: bestTime,
            best_post_day: bestDay,
            content_notes: contentNotes || null,
          }, { onConflict: 'client_id,month_year' })
          if (optError) errors.push(`${client.name}: mkt_client_optimisation upsert failed — ${optError.message}`)
        } else {
          notes.push(`${client.name}: no posts pulled for ${monthLabel} — optimisation notes unchanged`)
        }

        emailSections.push({
          name: client.name,
          tier: client.tier ?? null,
          totalPosts: posts.length,
          avgEngagement,
          followerChangeTotal,
          reportText,
          topExcerpt: top[0] ? excerpt(top[0].body) : null,
        })

        console.log(`[monthly-performance-pull] ${client.name}: ${posts.length} post(s), ${avgEngagement.toFixed(1)}% avg engagement`)
        void platformBreakdown // computed for the report prompt; not persisted separately
      } catch (e) {
        const msg = `${client.name}: ${String((e as Error)?.message ?? e)}`
        errors.push(msg)
        console.error(`[monthly-performance-pull] ${msg}`)
      }
    }

    if (emailSections.length) {
      const emailError = await sendReportEmail(emailSections, monthLabel)
      if (emailError) errors.push(emailError)
    } else {
      notes.push('No brand data to report — report email not sent')
    }
  } catch (e) {
    const msg = `fatal: ${String((e as Error)?.message ?? e)}`
    errors.push(msg)
    console.error(`[monthly-performance-pull] ${msg}`)
  }

  const { error: logError } = await admin.from('mkt_cron_log').insert({
    job_name: 'monthly-performance-pull',
    clients_processed: clientsProcessed,
    posts_generated: 0,
    errors: errors.length ? errors : null,
    notes: notes.length ? notes : null,
    duration_ms: Date.now() - started,
  })
  if (logError) console.error(`[monthly-performance-pull] failed to write mkt_cron_log: ${logError.message}`)

  if (errors.length) {
    const { error: efeError } = await admin.from('edge_function_errors').insert({
      function_name: 'monthly-performance-pull',
      error_message: errors.join(' | ').slice(0, 4000),
    })
    if (efeError) console.error(`[monthly-performance-pull] failed to write edge_function_errors: ${efeError.message}`)
  }

  console.log(`[monthly-performance-pull] run complete — ${clientsProcessed} client(s), ${notes.length} note(s), ${errors.length} error(s)`)

  return new Response(JSON.stringify({ ok: true, clientsProcessed, monthYear, notes, errors }), {
    headers: { 'Content-Type': 'application/json' },
  })
})
