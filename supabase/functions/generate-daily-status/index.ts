// Supabase Edge Function: generate-daily-status  (Deno)
// Builds a snapshot of the content queue (what's scheduled today, what's
// awaiting approval, what got rejected in the last 24h, recent edge function
// errors, and per-brand counts) and overwrites daily-status.json in the
// public ops-exports storage bucket. Contains no personal data — safe to
// serve unauthenticated (see ops/api/daily-status proxy in netlify.toml).
//
// Called from three places: the 07:30 morning-digest cron (see
// 48_daily_status_cron.sql), and directly from the frontend after a post is
// approved or rejected (src/pages/ContentQueue.jsx) — always best-effort,
// never blocking the approve/reject action itself.
//
// Invoke (cron or authenticated, no body required).
// Deploy:  supabase functions deploy generate-daily-status --no-verify-jwt
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const BUCKET = 'ops-exports'
const FILE = 'daily-status.json'

// content_type is null on legacy rows — the frontend (ContentQueue.jsx
// PostImage) treats a missing content_type the same as 'post', so this
// mirrors that: only social/blog posts, never review_response/ad rows.
const POST_TYPE_FILTER = 'content_type.eq.post,content_type.is.null'

// Mirrors _shared/generate.ts's dayOfWeekUK trick locally rather than
// importing that module (which also pulls in Anthropic-calling code this
// function has no use for). 0 = Sunday .. 6 = Saturday, UK-local.
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

serve(async () => {
  const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json' } })

  try {
    const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
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

    // "Last month" relative to now, in the same YYYY-MM form
    // monthly-performance-pull writes month_year in.
    const lastMonthDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1))
    const lastMonthYear = `${lastMonthDate.getUTCFullYear()}-${String(lastMonthDate.getUTCMonth() + 1).padStart(2, '0')}`

    const [clientsRes, scheduledWeekRes, pendingRes, rejectedWeekRes, errorsRes, crhqScrapeRes, monthlyReportsRes] = await Promise.all([
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
          scraped_at: crhqScrape.scraped_at,
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

    const status = {
      generated_at: now.toISOString(),
      scheduled_today: scheduledToday.map((r) => ({
        brand: nameOf(r.client),
        platform: r.platform,
        scheduled_time: r.scheduled_for,
        copy_preview: preview(r.body),
        status: r.status,
      })),
      pending_approval: pending.map((r) => ({
        brand: nameOf(r.client),
        platform: r.platform,
        scheduled_date: r.scheduled_for,
        copy_preview: preview(r.body),
        review_status: r.review_status ?? null,
      })),
      rejected_last_24h: rejectedLast24h.map((r) => ({
        brand: nameOf(r.client),
        rejection_reason: r.rejection_reason ?? null,
        scheduled_date: r.scheduled_for,
      })),
      edge_function_errors_last_24h: errors.map((e) => ({
        function_name: e.function_name,
        error_message: e.error_message,
        timestamp: e.created_at,
      })),
      brand_counts,
      crhq_last_scrape,
    }

    const { error: uploadErr } = await admin.storage.from(BUCKET).upload(FILE, new Blob([JSON.stringify(status)], { type: 'application/json' }), {
      contentType: 'application/json',
      upsert: true,
    })
    if (uploadErr) {
      console.error(`[generate-daily-status] storage upload failed: ${uploadErr.message}`)
      return json({ error: uploadErr.message }, 500)
    }

    console.log(`[generate-daily-status] wrote ${FILE} — ${status.scheduled_today.length} today, ${status.pending_approval.length} pending, ${status.rejected_last_24h.length} rejected(24h), ${status.edge_function_errors_last_24h.length} error(s)`)
    return json({ ok: true, generated_at: status.generated_at })
  } catch (e) {
    console.error(`[generate-daily-status] fatal: ${String((e as Error)?.message ?? e)}`)
    return json({ error: String((e as Error)?.message ?? e) }, 500)
  }
})
