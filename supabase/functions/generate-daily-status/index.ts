// Supabase Edge Function: generate-daily-status  (Deno)
// Builds a snapshot of the content queue (what's scheduled today, what's
// awaiting approval, what got rejected in the last 24h, recent edge function
// errors, per-brand counts, blog pipeline state, content-quality stats, and
// the CRHQ scrape outcome) and overwrites daily-status.json in the public
// ops-exports storage bucket. Contains no personal data — safe to serve
// unauthenticated (see ops/api/daily-status proxy in netlify.toml).
//
// Called from three places: the 07:30 morning-digest cron (see
// 48_daily_status_cron.sql), and directly from the frontend after a post is
// approved or rejected (src/pages/ContentQueue.jsx) — always best-effort,
// never blocking the approve/reject action itself.
//
// `summary` is written fresh on every run (see generateSummary below) by
// calling claude-haiku-4-5 with a compact snapshot of the same data — the
// served file is a static storage object, not a per-request endpoint, so
// "generated fresh on each request" means each regeneration of this file,
// which is what every actual read of /api/daily-status sees. Best-effort:
// a summary failure never blocks the rest of the status from being written.
//
// Invoke (cron or authenticated, no body required).
// Deploy:  supabase functions deploy generate-daily-status --no-verify-jwt
// (Deployed with JWT verification off so the cron schedule can call it
// directly — protected instead by a check below that accepts EITHER the
// service-role bearer [cron, see 48_daily_status_cron.sql] OR a real
// authenticated admin session [the frontend calls this live from
// ContentQueue.jsx after every approve/reject — a service-role-only gate
// like backfill-content's would break that path, since the browser never
// holds the service-role key]. Same mkt_is_admin() check send-report and
// 11 other functions in this repo already use for the frontend case.)
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { callAnthropic } from '../_shared/generate.ts'
import { checkCronAuth } from '../_shared/cronAuth.ts'
import { findRecurringRejectionPatterns, PATTERN_LOOKBACK_DAYS } from '../_shared/recurringRejectionPatterns.ts'
// Display-only UK-local formatting (see _shared/ukTime.ts). Every timestamp
// in this file's output is read by a human or relayed to Quill in prose, so
// every one of them is formatted UK-local with an explicit BST/GMT label.
// The QUERY boundaries above stay UTC — see the note on utcStamp below.
import { formatUkDateTime } from '../_shared/ukTime.ts'

const BUCKET = 'ops-exports'
const FILE = 'daily-status.json'

// content_type is null on legacy rows — the frontend (ContentQueue.jsx
// PostImage) treats a missing content_type the same as 'post', so this
// mirrors that: only social/blog posts, never review_response/ad rows.
const POST_TYPE_FILTER = 'content_type.eq.post,content_type.is.null'

// Mirrors _shared/generate.ts's dayOfWeekUK trick locally rather than
// importing it for this — this function now imports _shared/generate.ts
// anyway (for callAnthropic, below), but the local copy is left as-is since
// there's no benefit to swapping a working call for an identical one.
// 0 = Sunday .. 6 = Saturday, UK-local.
function dayOfWeekUK(d: Date): number {
  return Number(
    new Intl.DateTimeFormat('en-GB', { weekday: 'short', timeZone: 'Europe/London' })
      .format(d)
      .replace(/Sun/, '0').replace(/Mon/, '1').replace(/Tue/, '2').replace(/Wed/, '3')
      .replace(/Thu/, '4').replace(/Fri/, '5').replace(/Sat/, '6')
  )
}

function ukDateStr(d: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(d) // "2026-07-14"
}

function addDaysStr(dateStr: string, n: number): string {
  const d = new Date(`${dateStr}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

const nameOf = (c: { short_name?: string; name?: string } | null | undefined) => c?.short_name || c?.name || 'Unassigned'
const preview = (body: string | null | undefined) => String(body || '').slice(0, 100)

// Most frequent non-empty string in a list — used for content_quality's
// most_common_rejection_reason_last_30d. Ties resolve to whichever reason was
// encountered first; good enough for a summary stat, not worth a stable sort.
function mostCommon(values: (string | null | undefined)[]): string | null {
  const counts = new Map<string, number>()
  for (const v of values) {
    const s = (v || '').trim()
    if (!s) continue
    counts.set(s, (counts.get(s) ?? 0) + 1)
  }
  let best: string | null = null
  let bestCount = 0
  for (const [reason, count] of counts) {
    if (count > bestCount) { best = reason; bestCount = count }
  }
  return best
}

// Fresh, factual one-paragraph status summary for Quill, written by
// claude-haiku-4-5 from a compact snapshot of the pipeline (counts and
// per-brand stats, never full post copy). Best-effort — callers must catch
// and continue on failure, since this must never block the rest of the
// status file from being written.
async function generateSummary(context: Record<string, unknown>): Promise<string> {
  const system = [
    'You write a short internal status update for Quill, an ops assistant at a UK social-media/content agency.',
    'You are given a JSON snapshot of the agency\'s automated content pipeline: scheduled posts, approvals, rejections, blog posts, blog-dependent social posts, content-quality stats, and CRHQ scrape results.',
    'Write exactly one paragraph, 3 to 5 sentences, in plain factual English. No greeting, no sign-off, no bullet points, no markdown, no headings.',
    'Call out anything that needs attention: rejected or blocked posts, edge function errors, brands with zero content scheduled this week, blog-dependent posts still waiting on their blog, or a brand with a notably low approval rate or a recurring rejection reason.',
    'If nothing needs attention, say so plainly in one sentence rather than inventing a problem.',
    'Only use numbers and facts present in the JSON you are given — never estimate or invent one.',
  ].join(' ')
  const userMessage = `Pipeline snapshot:\n${JSON.stringify(context)}`
  const text = await callAnthropic(system, userMessage, 350)
  return text.trim()
}

serve(async (req) => {
  const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json' } })

  const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
  const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

  // Two legitimate callers: cron/service (checkCronAuth — x-cron-secret or
  // the real service-role bearer), or a logged-in admin from the frontend
  // (ContentQueue.jsx, after every approve/reject) — a service-role-only
  // gate would break that path, since the browser never holds the
  // service-role key.
  const cronAuth = await checkCronAuth(req, 'generate-daily-status')
  if (!cronAuth.authorised) {
    const userClient = createClient(SUPABASE_URL, Deno.env.get('SUPABASE_ANON_KEY')!, {
      global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } },
    })
    const { data: isAdmin } = await userClient.rpc('mkt_is_admin')
    if (isAdmin !== true) return json({ error: 'Not authorised' }, 401)
  }

  try {
    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)
    const now = new Date()

    // Day/week boundaries, UK-local (good enough for a daily status export —
    // may be off by up to an hour around the twice-yearly BST transition).
    const todayStr = ukDateStr(now)
    const dow = dayOfWeekUK(now) // 0=Sun..6=Sat
    const mondayOffset = dow === 0 ? -6 : 1 - dow
    const mondayStr = addDaysStr(todayStr, mondayOffset)
    const nextMondayStr = addDaysStr(mondayStr, 7)
    const todayStart = new Date(`${todayStr}T00:00:00Z`)
    const todayEnd = new Date(`${addDaysStr(todayStr, 1)}T00:00:00Z`)
    const weekStart = new Date(`${mondayStr}T00:00:00Z`)
    const weekEnd = new Date(`${nextMondayStr}T00:00:00Z`)
    const last24hStart = new Date(now.getTime() - 24 * 3600_000)
    const last7dStart = new Date(now.getTime() - 7 * 24 * 3600_000)
    const last30dStart = new Date(now.getTime() - 30 * 24 * 3600_000)
    // Tied to the shared module's own constant (currently also 30 days, same
    // as last30dStart above) rather than assumed equal to it — so this stays
    // correct even if PATTERN_LOOKBACK_DAYS ever changes independently.
    const patternSince = new Date(now.getTime() - PATTERN_LOOKBACK_DAYS * 24 * 3600_000)

    // "Last month" relative to now, in the same YYYY-MM form
    // monthly-performance-pull writes month_year in.
    const lastMonthDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1))
    const lastMonthYear = `${lastMonthDate.getUTCFullYear()}-${String(lastMonthDate.getUTCMonth() + 1).padStart(2, '0')}`

    const [
      clientsRes, scheduledWeekRes, pendingRes, rejectedWeekRes, errorsRes, crhqScrapeRes, monthlyReportsRes,
      blogsPendingRes, blogsPublishedRes, blogBlockedRes, approvedLast30dRes, rejectedLast30dRes, crhqCronLogRes,
      recurringPatternRes,
    ] = await Promise.all([
      admin.from('mkt_clients').select('id, name, short_name').eq('active', true),
      // "Genuinely on the calendar" (approved/scheduled/published) within
      // this week — filtered to today in-memory for scheduled_today, and
      // used whole for brand_counts.scheduled_this_week.
      admin.from('mkt_content_queue')
        .select('platform, body, status, scheduled_for, client:mkt_clients(short_name,name)')
        .or(POST_TYPE_FILTER)
        .in('status', ['approved', 'scheduled', 'published'])
        .gte('scheduled_for', weekStart.toISOString())
        .lt('scheduled_for', weekEnd.toISOString()),
      // Awaiting review — not date-bound, mirrors send-digest's own filter.
      admin.from('mkt_content_queue')
        .select('platform, body, scheduled_for, review_status, client:mkt_clients(short_name,name)')
        .or(POST_TYPE_FILTER)
        .in('status', ['draft', 'pending']),
      // Rejected this week — filtered to last 24h in-memory for
      // rejected_last_24h, used whole for brand_counts.rejected_this_week.
      admin.from('mkt_content_queue')
        .select('rejection_reason, scheduled_for, rejected_at, client:mkt_clients(short_name,name)')
        .or(POST_TYPE_FILTER)
        .eq('status', 'rejected')
        .gte('rejected_at', weekStart.toISOString())
        .lt('rejected_at', weekEnd.toISOString()),
      admin.from('edge_function_errors')
        .select('function_name, error_message, created_at')
        .gte('created_at', last24hStart.toISOString())
        .order('created_at', { ascending: false }),
      // Most recent CRHQ scrape — written by crhq-nightly-content's 22:00 run
      // (see _shared/crhqScrape.ts) — read here to tell Quill whether last
      // night found real YouTube/news content or fell back to the pillar
      // rotation, without needing its own separate endpoint.
      admin.from('crhq_scrape_cache')
        .select('scraped_at, videos, articles')
        .order('scraped_at', { ascending: false })
        .limit(1)
        .maybeSingle(),
      // Last month's per-brand average engagement — written by
      // monthly-performance-pull on the 1st of this month, for Quill to see
      // alongside the rest of the daily snapshot.
      admin.from('mkt_monthly_reports')
        .select('client_id, avg_engagement_rate, follower_change')
        .eq('month_year', lastMonthYear),
      // Blog queue — drafts awaiting approval, per brand.
      admin.from('mkt_blog_posts')
        .select('title, publish_date, client:mkt_clients(short_name,name)')
        .eq('status', 'draft')
        .order('publish_date', { ascending: true }),
      // Blogs published in the last 7 days — live_url is only populated for
      // brands publish-approved-blog can actually push to (see migration 60);
      // NULL for manual-HTML brands and for anything published before that
      // column existed.
      admin.from('mkt_blog_posts')
        .select('title, published_at, live_url, client:mkt_clients(short_name,name)')
        .eq('status', 'published')
        .gte('published_at', last7dStart.toISOString())
        .order('published_at', { ascending: false }),
      // Social posts still gated behind an unpublished blog (see approve-blog,
      // which sets review_status='blog_dependent' + blog_id on every post it
      // repurposes from a blog). blog:mkt_blog_posts(status) is embedded via
      // the blog_id FK (migration 59) so we can tell which are still actually
      // blocked vs. now unblocked because their blog went live since.
      admin.from('mkt_content_queue')
        .select('client:mkt_clients(short_name,name), blog:mkt_blog_posts(status)')
        .or(POST_TYPE_FILTER)
        .eq('review_status', 'blog_dependent')
        .in('status', ['draft', 'pending']),
      // Content-quality — approvals in the last 30 days. approved_at is
      // stamped once at approval time and never cleared by later status
      // transitions (approved -> scheduled/published), so this captures every
      // post actioned in the window regardless of its current status.
      admin.from('mkt_content_queue')
        .select('client:mkt_clients(short_name,name), approved_at')
        .or(POST_TYPE_FILTER)
        .not('approved_at', 'is', null)
        .gte('approved_at', last30dStart.toISOString()),
      // Content-quality — rejections in the last 30 days.
      admin.from('mkt_content_queue')
        .select('client:mkt_clients(short_name,name), rejection_reason, rejected_at')
        .or(POST_TYPE_FILTER)
        .eq('status', 'rejected')
        .gte('rejected_at', last30dStart.toISOString()),
      // Most recent CRHQ nightly-pipeline run — posts_generated here is always
      // scrape-driven (crhq-nightly-content has no pillar-fallback path; it
      // skips generation entirely when the scrape finds nothing), so this is
      // exactly posts_generated_from_scrape for the run crhqScrapeRes reports.
      admin.from('mkt_cron_log')
        .select('posts_generated, created_at')
        .eq('job_name', 'crhq-nightly-content')
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle(),
      // Recurring-pattern scan — same query send-rejected-digest runs (see
      // _shared/recurringRejectionPatterns.ts), reused directly rather than
      // rewritten. Deliberately NOT filtered by POST_TYPE_FILTER, matching
      // the original: a recurring rejection reason on an ad or review-response
      // is just as real a pattern as one on a post, and narrowing this query
      // would make it disagree with what the standalone email reports for the
      // same window.
      admin.from('mkt_content_queue')
        .select('rejection_reason, rejection_feedback_used, client:mkt_clients(name, short_name)')
        .eq('status', 'rejected')
        .gte('rejected_at', patternSince.toISOString())
        .not('rejection_reason', 'is', null),
    ])

    const clients = clientsRes.data || []
    const scheduledWeek = scheduledWeekRes.data || []
    const pending = pendingRes.data || []
    const rejectedWeek = rejectedWeekRes.data || []
    const errors = errorsRes.data || []

    const crhqScrape = crhqScrapeRes.data
    const crhqScrapeVideos = Array.isArray(crhqScrape?.videos) ? crhqScrape.videos : []
    const crhqScrapeArticles = Array.isArray(crhqScrape?.articles) ? crhqScrape.articles : []
    const crhq_last_scrape = crhqScrape
      ? {
          scraped_at: formatUkDateTime(crhqScrape.scraped_at),
          source: (crhqScrapeVideos.length || crhqScrapeArticles.length) ? 'youtube_scrape' : 'pillar_fallback',
          videos_found: crhqScrapeVideos.length,
          articles_found: crhqScrapeArticles.length,
        }
      : null

    const scheduledToday = scheduledWeek.filter((r) => {
      if (!r.scheduled_for) return false
      const d = new Date(r.scheduled_for)
      return d >= todayStart && d < todayEnd
    })
    const rejectedLast24h = rejectedWeek.filter((r) => r.rejected_at && new Date(r.rejected_at) >= last24hStart)

    const monthlyReportByClientId = new Map<string, { avg_engagement_rate: number | null; follower_change: number | null }>(
      (monthlyReportsRes.data || []).map((r: Record<string, any>) => [r.client_id, { avg_engagement_rate: r.avg_engagement_rate ?? null, follower_change: r.follower_change ?? null }])
    )

    const brand_counts = clients.map((c) => ({
      brand: nameOf(c),
      scheduled_this_week: scheduledWeek.filter((r) => (r as { client?: { short_name?: string; name?: string } }).client && nameOf((r as { client?: { short_name?: string; name?: string } }).client) === nameOf(c)).length,
      pending_approval: pending.filter((r) => (r as { client?: { short_name?: string; name?: string } }).client && nameOf((r as { client?: { short_name?: string; name?: string } }).client) === nameOf(c)).length,
      rejected_this_week: rejectedWeek.filter((r) => (r as { client?: { short_name?: string; name?: string } }).client && nameOf((r as { client?: { short_name?: string; name?: string } }).client) === nameOf(c)).length,
      avg_engagement_rate_last_month: monthlyReportByClientId.get(c.id)?.avg_engagement_rate ?? null,
      follower_change_last_month: monthlyReportByClientId.get(c.id)?.follower_change ?? null,
    }))

    const blogs_pending_approval = (blogsPendingRes.data || []).map((r: Record<string, any>) => ({
      brand: nameOf(r.client),
      title: r.title,
      scheduled_publish_date: r.publish_date ?? null,
    }))

    const blogs_published_last_7d = (blogsPublishedRes.data || []).map((r: Record<string, any>) => ({
      brand: nameOf(r.client),
      title: r.title,
      published_at: formatUkDateTime(r.published_at),
      url: r.live_url ?? null,
    }))

    // A row only counts as still blocked if its blog hasn't published since —
    // review_status='blog_dependent' is a durable stamp set once at creation
    // and never cleared, so the blog's live status (embedded via blog_id,
    // migration 59) is the real signal, not the stamp alone.
    const blogBlockedRows = (blogBlockedRes.data || []).filter(
      (r: Record<string, any>) => !r.blog || r.blog.status !== 'published',
    )
    const blog_dependent_posts_blocked = clients.map((c) => ({
      brand: nameOf(c),
      blocked_count: blogBlockedRows.filter((r: Record<string, any>) => r.client && nameOf(r.client) === nameOf(c)).length,
    }))

    const approvedLast30d = approvedLast30dRes.data || []
    const rejectedLast30d = rejectedLast30dRes.data || []
    const content_quality = clients.map((c) => {
      const approvedCount = approvedLast30d.filter((r: Record<string, any>) => r.client && nameOf(r.client) === nameOf(c)).length
      const rejectedRows = rejectedLast30d.filter((r: Record<string, any>) => r.client && nameOf(r.client) === nameOf(c))
      const actioned = approvedCount + rejectedRows.length
      return {
        brand: nameOf(c),
        approval_rate_30d: actioned > 0 ? Math.round((approvedCount / actioned) * 1000) / 1000 : null,
        most_common_rejection_reason_last_30d: mostCommon(rejectedRows.map((r: Record<string, any>) => r.rejection_reason)),
        total_rejections_last_30d: rejectedRows.length,
      }
    })

    const recurring_rejection_patterns = findRecurringRejectionPatterns(recurringPatternRes.data ?? [])

    // posts_generated on the most recent crhq-nightly-content cron_log row is
    // always scrape-driven — that function has no pillar-fallback path, it
    // skips generation entirely when the scrape finds nothing fresh — so it's
    // exactly posts_generated_from_scrape for the run crhq_last_scrape reports
    // (both are written by the same run, so "most recent" of each lines up).
    const crhq_scrape_status = crhqScrape
      ? {
          last_scrape_at: formatUkDateTime(crhqScrape.scraped_at),
          videos_found: crhqScrapeVideos.length,
          articles_found: crhqScrapeArticles.length,
          posts_generated_from_scrape: crhqCronLogRes.data?.posts_generated ?? 0,
        }
      : null

    const brands_with_no_content_this_week = brand_counts.filter((b) => b.scheduled_this_week === 0).map((b) => b.brand)

    // EVERY timestamp below is a display value — this file is read by a human
    // (or read aloud by Quill), never parsed back into a Date by anything.
    // The only consumer that touches a field here programmatically is
    // netlify/functions/refresh-status.js, which echoes generated_at straight
    // back to its caller as text. So the human-readable UK string takes the
    // plain name, and the machine-readable UTC instant is kept alongside it
    // under an explicit *_utc key rather than dropped — timestamps this file
    // reports are still, underneath, UTC in the database.
    const status: Record<string, any> = {
      generated_at: formatUkDateTime(now),
      generated_at_utc: now.toISOString(),
      scheduled_today: scheduledToday.map((r) => ({
        brand: nameOf(r.client),
        platform: r.platform,
        scheduled_time: formatUkDateTime(r.scheduled_for, 'no date set'),
        copy_preview: preview(r.body),
        status: r.status,
      })),
      pending_approval: pending.map((r) => ({
        brand: nameOf(r.client),
        platform: r.platform,
        scheduled_date: formatUkDateTime(r.scheduled_for, 'no date set'),
        copy_preview: preview(r.body),
        review_status: r.review_status ?? null,
      })),
      rejected_last_24h: rejectedLast24h.map((r) => ({
        brand: nameOf(r.client),
        rejection_reason: r.rejection_reason ?? null,
        scheduled_date: formatUkDateTime(r.scheduled_for, 'no date set'),
      })),
      edge_function_errors_last_24h: errors.map((e) => ({
        function_name: e.function_name,
        error_message: e.error_message,
        timestamp: formatUkDateTime(e.created_at),
      })),
      brand_counts,
      crhq_last_scrape,
      // Additive fields — Quill pipeline visibility.
      blogs_pending_approval,
      blogs_published_last_7d,
      blog_dependent_posts_blocked,
      content_quality,
      // Same analysis send-rejected-digest's email prepends as a "RECURRING
      // PATTERN" section — see _shared/recurringRejectionPatterns.ts. Present
      // here too so it's visible from the dashboard JSON without needing the
      // standalone email as well.
      recurring_rejection_patterns,
      crhq_scrape_status,
      brands_with_no_content_this_week,
      summary: null as string | null,
      // UK date (YYYY-MM-DD) the current `summary` text was actually
      // generated on — see the throttle below.
      summary_date: null as string | null,
    }

    // Throttle (26 Aug 2026 incident) — this function is called every 30
    // minutes (cron job 39, "generate-daily-status", *_/30 * * * *_ —
    // separate from and in addition to the once-daily 07:30 morning-digest
    // call in 48_daily_status_cron.sql) but a fresh AI paragraph is only
    // ever useful once a day: the underlying numbers it summarises don't
    // meaningfully change run-to-run within the same day, yet every run
    // was calling claude-haiku-4-5 again regardless. On 25 Aug the account's
    // Anthropic usage cap was hit — one real, single cause — and because
    // this function alone runs 48x/day, that ONE cap produced 33
    // "summary generation failed" rows in edge_function_errors in a single
    // day (vs. crhq-nightly-content's 1, which only runs once nightly),
    // reading as a 33-error spike when it was one root cause amplified
    // 33-48x by call frequency. Deliberately NOT touching the every-30-min
    // schedule itself here — the rest of this function's output (scheduled
    // posts, pending approvals, errors, etc.) is genuinely cheap and may be
    // relied on for intraday freshness; only the expensive, rarely-changing
    // AI paragraph is throttled.
    //
    // Reads the file this same run is about to overwrite, so "already
    // generated today" survives across runs without a new table. Best-effort
    // and fails open to "regenerate" — a read error must never turn into a
    // silently stale summary that can never refresh again.
    let previousSummary: string | null = null
    let previousSummaryDate: string | null = null
    try {
      const { data: existing } = await admin.storage.from(BUCKET).download(FILE)
      if (existing) {
        const prev = JSON.parse(await existing.text())
        previousSummary = typeof prev.summary === 'string' ? prev.summary : null
        previousSummaryDate = typeof prev.summary_date === 'string' ? prev.summary_date : null
      }
    } catch (e) {
      console.error(`[generate-daily-status] could not read previous ${FILE} for summary throttle: ${String((e as Error)?.message ?? e)}`)
    }

    if (previousSummary && previousSummaryDate === todayStr) {
      // Already generated once today — carry it forward verbatim rather
      // than spending another Anthropic call (and, during an outage like
      // this one, another failed one) for text that would barely differ.
      status.summary = previousSummary
      status.summary_date = previousSummaryDate
      console.log(`[generate-daily-status] summary reused from earlier today (${previousSummaryDate}) — not regenerated`)
    } else {
      // Fresh, factual pipeline summary for Quill (claude-haiku-4-5) — built
      // from a compact snapshot (counts and per-brand stats only, never full
      // post copy). Best-effort: a failure here must never block the rest of
      // the status file from being written.
      try {
        status.summary = await generateSummary({
          scheduled_today_count: status.scheduled_today.length,
          pending_approval_count: status.pending_approval.length,
          rejected_last_24h_count: status.rejected_last_24h.length,
          edge_function_errors_last_24h: status.edge_function_errors_last_24h.map((e: Record<string, any>) => ({ function_name: e.function_name, message: String(e.error_message || '').slice(0, 150) })),
          brand_counts: status.brand_counts,
          blogs_pending_approval_count: status.blogs_pending_approval.length,
          blogs_published_last_7d_count: status.blogs_published_last_7d.length,
          blog_dependent_posts_blocked: status.blog_dependent_posts_blocked,
          content_quality: status.content_quality,
          crhq_scrape_status: status.crhq_scrape_status,
          brands_with_no_content_this_week: status.brands_with_no_content_this_week,
        }) || null
        status.summary_date = status.summary ? todayStr : null
      } catch (e) {
        const msg = String((e as Error)?.message ?? e)
        console.error(`[generate-daily-status] summary generation failed: ${msg}`)
        try {
          await admin.from('edge_function_errors').insert({ function_name: 'generate-daily-status', error_message: `summary generation failed: ${msg}` })
        } catch (logErr) {
          console.error(`[generate-daily-status] failed to write edge_function_errors: ${String((logErr as Error)?.message ?? logErr)}`)
        }
        // Show yesterday's real summary rather than nothing — still clearly
        // stale via summary_date, which the frontend/digest can compare
        // against todayStr, but a stale factual paragraph beats a blank one.
        if (previousSummary) {
          status.summary = previousSummary
          status.summary_date = previousSummaryDate
        }
      }
    }

    const { error: uploadErr } = await admin.storage.from(BUCKET).upload(FILE, new Blob([JSON.stringify(status)], { type: 'application/json' }), {
      contentType: 'application/json',
      upsert: true,
    })
    if (uploadErr) {
      console.error(`[generate-daily-status] storage upload failed: ${uploadErr.message}`)
      return json({ error: uploadErr.message }, 500)
    }

    console.log(`[generate-daily-status] wrote ${FILE} — ${status.scheduled_today.length} today, ${status.pending_approval.length} pending, ${status.rejected_last_24h.length} rejected(24h), ${status.recurring_rejection_patterns.length} recurring pattern(s), ${status.edge_function_errors_last_24h.length} error(s), ${status.blogs_pending_approval.length} blog draft(s), summary ${status.summary ? 'ok' : 'failed'}`)
    // generated_at here is the UK-local display string, matching exactly what
    // landed in the file (refresh-status.js relays this straight to whoever
    // asked, so it must read the same as the file it just regenerated).
    return json({ ok: true, generated_at: status.generated_at, generated_at_utc: status.generated_at_utc })
  } catch (e) {
    console.error(`[generate-daily-status] fatal: ${String((e as Error)?.message ?? e)}`)
    return json({ error: String((e as Error)?.message ?? e) }, 500)
  }
})
