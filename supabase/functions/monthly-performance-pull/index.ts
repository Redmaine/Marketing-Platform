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
import { checkCronAuth } from '../_shared/cronAuth.ts'

// deno-lint-ignore no-explicit-any
type Admin = any

// When the engagement-rate methodology was corrected (see mapPlatformPost's
// ROOT CAUSE note). Reports generated before this instant hold figures from
// the old local recompute and are NOT comparable with anything after it.
// 2026-09-01T06:45:00Z — immediately before the first corrected run.
const METRICS_METHOD_FIXED_AT = Date.parse('2026-09-01T06:45:00Z')

const FROM = 'Your Company AI <hello@yourcompanyai.co.uk>'
const REPORT_RECIPIENT = 'hello@yourcompanyai.co.uk'
const ANALYTICS_PLATFORMS = ['facebook', 'instagram']

// Tightened 1 Sep 2026. The previous version invited exactly the failure
// Adrian flagged in the August reports: every brand came back with the same
// invented scaffolding ("three likely culprits", "what worked / what didn't")
// and confident causal explanations the model had no evidence for — one
// report literally wrote "Without visibility into post content, I can't
// pinpoint why" and then supplied five numbered causes anyway. The data this
// model receives is thin (metrics, and post bodies only where a Metricool id
// matched a queue row), so anything resembling diagnosis was being invented
// to fill the shape of a report.
const REPORT_SYSTEM_PROMPT = `You are Quill's performance analyst. You write short, direct monthly performance reports for social media clients. No fluff, no corporate language. Maximum 400 words.

ABSOLUTE RULES — these override any instinct to produce a complete-looking report:
- Report ONLY figures given to you in the data below. Never invent, estimate, extrapolate or round a metric you were not given.
- If a metric is marked NOT AVAILABLE, say plainly that it could not be measured this month. Never substitute zero, never describe it as flat/none/declining, and never build an argument on it.
- Do NOT speculate about CAUSES unless the data given actually evidences them. You are not shown audience demographics, algorithm behaviour, creative quality, competitor activity or posting-time experiments — so never assert or list these as reasons. No "likely culprits" lists.
- If the data is too thin to explain what happened, say exactly that in one sentence. A short honest report is correct and expected; padding it with plausible-sounding analysis is a serious failure.
- Do not recommend specific changes that the data does not support. "Not enough signal to change strategy yet" is a valid and often correct conclusion.
- Vary structure to fit what the data actually shows. Do not impose a fixed template on every brand.`

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

// NOTE: a local engagementRate() helper — (likes+comments+shares)/reach —
// used to live here and was the source of the false figures in the 1 Sep 2026
// report. Deleted rather than left unused, so nothing can accidentally reach
// for it again; Metricool's own `engagement` percentage is the only rate this
// function now reports. See mapPlatformPost's ROOT CAUSE note.

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
interface MappedStat {
  metricool_post_id: string
  published_at: string | null
  reach: number | null
  impressions: number | null
  likes: number | null
  comments: number | null
  shares: number | null
  // Metricool's OWN engagement rate for this post, as a percentage. See the
  // ROOT CAUSE note below — this is the authoritative figure and the one the
  // client's Metricool PDF reports. null when the API omitted it.
  metricool_engagement_rate: number | null
}

// ROOT CAUSE of the false engagement figures in the 1 Sep 2026 report
// (fixed 1 Sep 2026). This mapping previously read only likes/comments/
// shares and the caller then RECOMPUTED a rate as
// (likes+comments+shares)/reach — silently discarding `p.engagement`, which
// Metricool returns as its own already-computed engagement PERCENTAGE and
// which is what the client's Metricool PDF actually shows.
//
// metricool-weekly-pull/index.ts already had this right and documented it
// ("Metricool's `engagement` field is a percentage (e.g. 22.22), not a raw
// interaction count — confirmed live"); this function simply never adopted
// it, so the two pipelines disagreed about the same posts.
//
// The recompute undercounts because Metricool's engagement includes
// interaction types that likes+comments+shares does not (clicks, saves,
// etc). Proven against real synced August data for Riverside: the 3 Aug post
// has 0 likes, 0 comments, 0 shares and reach 20 — the recompute calls that
// 0.00%, Metricool calls it 10%. Across August the two methods give
// Riverside 3.78% (what was emailed) vs ~11.1% (Metricool's own), and Quill
// 0.08% vs ~4.8%.
function mapPlatformPost(network: string, p: Record<string, unknown>): MappedStat {
  // Metricool omits `engagement` on some rows; null (not 0) so a missing
  // value is never averaged in as a real zero — see ratedPosts below.
  const rawEngagement = p.engagement
  const metricool_engagement_rate =
    rawEngagement == null || Number.isNaN(Number(rawEngagement)) ? null : Number(rawEngagement)

  if (network === 'facebook') {
    return {
      metricool_post_id: String(p.postId ?? ''),
      published_at: (p.created as { dateTime?: string } | undefined)?.dateTime ?? null,
      reach: Number(p.impressionsUnique ?? 0),
      impressions: Number(p.impressions ?? 0),
      likes: Number(p.like ?? 0),
      comments: Number(p.comments ?? 0),
      shares: Number(p.shares ?? 0),
      metricool_engagement_rate,
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
    metricool_engagement_rate,
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

  const raw: Array<{ platform: string; stat: MappedStat }> = []
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
      // Metricool's own figure, NOT a local recompute — see mapPlatformPost's
      // ROOT CAUSE note. Stays null when Metricool didn't supply one, so a
      // missing rate is excluded from the average rather than counted as 0%.
      engagement_rate: stat.metricool_engagement_rate,
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
  // Why there is no comparison, when there isn't one. 'none' = genuinely no
  // earlier report; 'incomparable' = one exists but predates the
  // engagement-rate fix. These must read differently: telling a brand with
  // months of history that August is "your first month of tracked data" is
  // itself a false statement, which is the exact class of bug being fixed.
  noPrevReason: 'none' | 'incomparable' = 'none',
): Promise<{ reportText: string; top: PulledPost[]; bottom: PulledPost[]; avgEngagement: number | null; followerChangeTotal: number | null; platformBreakdown: Array<{ platform: string; posts: number; avg_engagement_rate: number | null }> }> {
  const rated = posts.filter((p) => p.engagement_rate != null)
  const sorted = [...rated].sort((a, b) => (b.engagement_rate ?? 0) - (a.engagement_rate ?? 0))
  const top = sorted.slice(0, 3)
  const bottom = sorted.slice(-3).reverse()
  // null, not 0, when nothing was rateable — same reasoning as
  // followerChangeTotal below. "We have no engagement data" and "engagement
  // was zero" are different claims and must not render identically.
  const avgEngagement: number | null = rated.length
    ? rated.reduce((s, p) => s + (p.engagement_rate ?? 0), 0) / rated.length
    : null

  // follower_change is stored per-platform on each post row (see the file
  // header); the report's single "follower change" figure is the sum across
  // this brand's platforms for the month.
  //
  // Fixed 1 Sep 2026 — this previously did `sum + (v ?? 0)`, silently turning
  // "Metricool gave us no follower timeline for this platform" into a hard
  // 0. The LLM then stated that non-fact as one ("you gained zero followers"),
  // with nothing anywhere distinguishing it from a genuine, measured zero.
  // Instagram ALWAYS lands in that no-data branch (fetchFollowerChange returns
  // null for every non-facebook network), so any Instagram-only brand was
  // guaranteed a fabricated "zero followers" line every month.
  //
  // Now: null means "not measurable", a number means a real measured delta.
  // Only platforms that actually returned a value contribute to the sum.
  const platformSet = Array.from(new Set(posts.map((p) => p.platform)))
  const followerChangeValues = platformSet
    .map((plat) => posts.find((p) => p.platform === plat)?.follower_change)
    .filter((v): v is number => typeof v === 'number')
  const followerChangeTotal: number | null = followerChangeValues.length
    ? followerChangeValues.reduce((sum, v) => sum + v, 0)
    : null

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
    avgEngagement == null
      ? 'Average engagement rate: NOT AVAILABLE — Metricool returned no engagement rate for any post this month. Do not state or imply an engagement figure, and do not describe engagement as zero, low or declining.'
      : prevAvgEngagement != null
        ? `Average engagement rate: ${avgEngagement.toFixed(2)}% (previous month: ${prevAvgEngagement.toFixed(2)}%)`
        : noPrevReason === 'incomparable'
          ? `Average engagement rate: ${avgEngagement.toFixed(2)}%. NO MONTH-ON-MONTH COMPARISON IS AVAILABLE: earlier months were measured with a different, now-corrected method and are not comparable. Do NOT compare to any previous month, do NOT describe this as a rise or fall, and do NOT say this is the brand's first month of data — earlier months exist, they simply cannot be compared.`
          : `Average engagement rate: ${avgEngagement.toFixed(2)}% (no previous month exists to compare against — this is genuinely the brand's first month of tracked data)`,
    followerChangeTotal == null
      ? 'Follower change this month: NOT AVAILABLE — no follower timeline exists for this brand\'s platform(s) (Metricool exposes one for Facebook only). Do not state or imply a follower figure, and do not say followers were flat, static or that none were gained.'
      : `Follower change this month: ${followerChangeTotal >= 0 ? '+' : ''}${followerChangeTotal}`,
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
  avgEngagement: number | null
  followerChangeTotal: number | null
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
    // "not measured" is rendered as exactly that — never as 0.0% / +0, which
    // is what made the August email read as confident false data.
    const engLabel = s.avgEngagement == null ? 'engagement not measured' : `${s.avgEngagement.toFixed(1)}% avg engagement`
    const folLabel = s.followerChangeTotal == null
      ? 'follower change not measured'
      : `${s.followerChangeTotal >= 0 ? '+' : ''}${s.followerChangeTotal} followers`
    html += `<div style="color:#8FA3B1;font-size:13px;margin:6px 0 12px">${s.totalPosts} post${s.totalPosts === 1 ? '' : 's'} published · ${engLabel} · ${folLabel}</div>`
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
serve(async (req) => {
  const auth = await checkCronAuth(req, 'monthly-performance-pull')
  if (!auth.authorised) return auth.response!

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
          .select('avg_engagement_rate, generated_at')
          .eq('client_id', client.id)
          .eq('month_year', prevMonthYear)
          .maybeSingle()

        // Only compare against a previous month that was measured the SAME
        // way. Every report generated before METRICS_METHOD_FIXED_AT used the
        // old local recompute (see mapPlatformPost's ROOT CAUSE note), which
        // reads several times lower than Metricool's own rate — so a naive
        // month-on-month diff across that boundary invents a dramatic trend
        // that is purely an artefact of the fix. Real example caught during
        // verification: Riverside's first corrected report announced
        // "engagement doubled, 5.83% -> 11.87%" when 5.83% was simply July
        // measured the broken way. Suppressed rather than shown with a
        // caveat — a comparison this misleading is worse than none.
        const prevGeneratedAt = prevReport?.generated_at ? new Date(prevReport.generated_at).getTime() : null
        const prevIsComparable = prevGeneratedAt != null && prevGeneratedAt >= METRICS_METHOD_FIXED_AT
        const prevAvg = prevIsComparable ? (prevReport?.avg_engagement_rate ?? null) : null
        if (prevReport && !prevIsComparable) {
          notes.push(`${client.name}: previous month (${prevMonthYear}) predates the engagement-rate fix — month-on-month comparison suppressed rather than shown against an incompatible figure`)
        }

        const { reportText, top, bottom, avgEngagement, followerChangeTotal, platformBreakdown } =
          await buildReport(client, posts, monthLabel, prevAvg, prevReport && !prevIsComparable ? 'incomparable' : 'none')

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
        // avgEngagement != null as well as posts.length: buildOptimisation
        // compares each pillar's rate against the overall average to decide
        // top vs underperforming, which is meaningless with no average.
        if (posts.length && avgEngagement != null) {
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
        } else if (!posts.length) {
          notes.push(`${client.name}: no posts pulled for ${monthLabel} — optimisation notes unchanged`)
        } else {
          notes.push(`${client.name}: ${posts.length} post(s) pulled for ${monthLabel} but Metricool returned no engagement rate for any of them — optimisation notes unchanged`)
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

        console.log(`[monthly-performance-pull] ${client.name}: ${posts.length} post(s), ${avgEngagement == null ? 'engagement not measured' : `${avgEngagement.toFixed(1)}% avg engagement`}`)
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
