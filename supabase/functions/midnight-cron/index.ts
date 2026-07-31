// Supabase Edge Function: midnight-cron  (Deno) — runs 00:00 daily via pg_cron
// Keeps every active client topped up with ~4 weeks of approved/scheduled
// content, on each client's own posting days (client.post_days — see
// _shared/fill.ts), rotates through their content pillars, and generates
// one blog post per client per week (scheduled for Sunday).
//
// Why it doesn't call generate-content: that function is admin-gated (mkt_is_admin
// on the caller's JWT). Cron runs with the service role (no user email), so it
// would be rejected. We write directly using the shared generation helpers so
// both paths use the same system/user prompt and factual-accuracy constraint.
//
// CRHQ (slug 'crhq') is loaded but deliberately skipped for CONTENT generation
// here (the skip is logged, not silent — see the loop). Its content goes stale
// within hours (geopolitics, defence), so a weeks-ahead bulk fill is exactly
// wrong for it; it gets its own 22:00 dedicated run instead, which scrapes
// fresh, generates one post per platform, and enforces its own tight queue cap
// — see crhq-nightly-content/index.ts and 56_crhq_nightly_pipeline.sql. Its
// nightly approval_rate_30d IS still refreshed here, alongside every other
// brand.
//
// This function also owns two content-quality-tracking jobs that run for every
// active brand each night: (1) refresh mkt_clients.approval_rate_30d, and
// (2) feed the last 30 days of rejection reasons back into generation (via
// _shared/rejectionFeedback.ts → prompts.ts) so the model stops repeating
// whatever kept getting a brand's posts rejected. See 58_content_quality_tracking.sql.
//
// Deploy:  supabase functions deploy midnight-cron
// Schedule: see 11_cron_jobs.sql.  Secrets (vault): ANTHROPIC_API_KEY.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { sundayOfWeek } from '../_shared/generate.ts'
import { ensureWeeklyBlog } from '../_shared/blog.ts'
import { fillClientGap } from '../_shared/fill.ts'

// deno-lint-ignore no-explicit-any
type Admin = any

const APPROVAL_LOOKBACK_DAYS = 30

// Each active brand's 30-day approval rate, stored on mkt_clients.approval_rate_30d
// nightly. Defined as: of the posts a human gave a terminal decision on in the
// window (approved vs rejected), the fraction approved. Reads the approved_at /
// rejected_at timestamps, NOT current status — an approved post's status later
// mutates to 'scheduled'/'published', so counting by status would undercount
// approvals. Returns null when there were no decisions in the window, so a brand
// with a quiet month shows no rate rather than a misleading 0.
async function computeApprovalRate30d(admin: Admin, clientId: string): Promise<number | null> {
  const since = new Date(Date.now() - APPROVAL_LOOKBACK_DAYS * 24 * 60 * 60 * 1000).toISOString()
  const [{ count: approved }, { count: rejected }] = await Promise.all([
    admin.from('mkt_content_queue').select('id', { count: 'exact', head: true })
      .eq('client_id', clientId).gte('approved_at', since),
    admin.from('mkt_content_queue').select('id', { count: 'exact', head: true })
      .eq('client_id', clientId).gte('rejected_at', since),
  ])
  const a = approved ?? 0
  const r = rejected ?? 0
  const denom = a + r
  if (denom === 0) return null
  return Math.round((a / denom) * 10000) / 10000
}

// Per-client safety ceiling passed to fillClientGap as its `budget` param.
// This is NOT a shared pool split across clients — every active client gets
// this full budget independently, so client 1 needing a big catch-up fill
// can never starve client 2..N of that night's content generation. It only
// exists as a sane upper bound; fillClientGap already stops itself once a
// client's own posting-frequency target is met.
const PER_CLIENT_POST_BUDGET = 20

// ── Seasonal posting windows (Once Upon A You) ──────────────────────────────
// OUAY is a gift product, so its three selling seasons are worth more than the
// rest of the year combined. Inside a window the brand posts DAILY; outside it
// keeps its normal cadence.
//
// The brand is resolved from the mkt_clients row this run already loaded
// (slug), not from a name hardcoded in a constant — same approach as the
// existing CRHQ skip a few lines below. If OUAY's slug ever changes, this
// stops applying rather than silently applying to the wrong brand.
//
// Dates are computed for the year in question rather than hardcoded, because
// two of the three move every year.
const SEASONAL_SLUG = 'ouay'
const ALL_DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

// UK Mother's Day is the fourth Sunday of Lent, which the brief defines
// operationally as "the last Sunday before 31 March". Implemented exactly as
// briefed rather than by computing Lent.
function lastSundayBefore(year: number, month: number, day: number): Date {
  const d = new Date(Date.UTC(year, month, day))
  // Step back to the most recent Sunday strictly before the given date.
  do { d.setUTCDate(d.getUTCDate() - 1) } while (d.getUTCDay() !== 0)
  return d
}

// UK Father's Day — third Sunday of June.
function thirdSundayOfJune(year: number): Date {
  const d = new Date(Date.UTC(year, 5, 1))
  const firstSunday = 1 + ((7 - d.getUTCDay()) % 7)
  return new Date(Date.UTC(year, 5, firstSunday + 14))
}

function daysBefore(d: Date, n: number): Date {
  const x = new Date(d)
  x.setUTCDate(x.getUTCDate() - n)
  return x
}

// thirdSundayOfJune / lastSundayBefore both return midnight AT THE START of
// the day. Comparing `now <= thatDate` would therefore end the window at
// 00:00 on the occasion itself — excluding the whole of the biggest selling
// day of the three. Pushing the bound to the end of that day is what makes
// "two weeks before Father's Day" actually include Father's Day.
function endOfDay(d: Date): Date {
  const x = new Date(d)
  x.setUTCHours(23, 59, 59, 999)
  return x
}

// The seasonal window `now` falls inside, or null. Checks the current year and
// the previous year's Christmas window, so a run in early January is still
// evaluated against a window that opened the previous November.
export function activeSeasonalWindow(now: Date): string | null {
  const year = now.getUTCFullYear()

  for (const y of [year, year - 1]) {
    // Christmas — six weeks from approximately 13 November, through 25 Dec.
    const christmasStart = new Date(Date.UTC(y, 10, 13))
    const christmasEnd = new Date(Date.UTC(y, 11, 25, 23, 59, 59))
    if (now >= christmasStart && now <= christmasEnd) return `Christmas ${y}`
  }

  const mothersDay = lastSundayBefore(year, 2, 31)
  if (now >= daysBefore(mothersDay, 14) && now <= endOfDay(mothersDay)) return `Mother's Day ${year}`

  const fathersDay = thirdSundayOfJune(year)
  if (now >= daysBefore(fathersDay, 14) && now <= endOfDay(fathersDay)) return `Father's Day ${year}`

  return null
}

// Returns a copy of the client with post_days widened to every day when this
// brand is in a seasonal window, or the client untouched otherwise.
//
// Only post_days is overridden — post_time and everything else stay as
// configured, so the brand keeps its 20:00 slot and simply uses it daily.
// Note this affects clients whose cadence comes from client.post_days; a
// platform with its own mkt_content_schedule rows keeps those (see
// platformSchedule in _shared/fill.ts), which is deliberate — an explicit
// per-platform schedule is a stronger statement of intent than a default.
function applySeasonalPosting(client: Record<string, unknown>, now: Date): { client: Record<string, unknown>; note: string | null } {
  if (String(client.slug ?? '') !== SEASONAL_SLUG) return { client, note: null }
  const window = activeSeasonalWindow(now)
  if (!window) return { client, note: null }
  return {
    client: { ...client, post_days: ALL_DAYS },
    note: `${client.name} — ${window} window active, posting daily (post_days widened from [${(client.post_days as string[] | undefined)?.join(', ') ?? 'default'}])`,
  }
}

serve(async () => {
  const started = Date.now()
  const errors: string[] = []
  const notes: string[] = []
  const skipped: string[] = []
  let clientsProcessed = 0
  let postsGenerated = 0
  let blogsGenerated = 0
  let approvalRatesUpdated = 0

  const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)

  try {
    const now = new Date()
    // Load EVERY active client — including CRHQ. CRHQ is skipped for content
    // generation below (it has its own dedicated 22:00 run, see the file
    // header), but it's loaded here so (a) its nightly approval_rate_30d is
    // still updated, and (b) the skip is logged explicitly rather than the
    // brand silently vanishing from a filtered query.
    const { data: clients, error: clientsError } = await admin.from('mkt_clients').select('*').eq('active', true).order('name')
    if (clientsError) throw new Error(`could not load active clients: ${clientsError.message}`)
    console.log(`[midnight-cron] starting run — ${clients?.length ?? 0} active client(s)`)

    for (const client of clients ?? []) {
      // Content-quality tracking — refresh this brand's 30-day approval rate
      // every night, for EVERY active brand (CRHQ included, before its content
      // skip below). Pure stats read/write; a failure here must not stop the
      // rest of the run for this or any other brand.
      try {
        const rate = await computeApprovalRate30d(admin, client.id)
        const { error: rateError } = await admin.from('mkt_clients').update({ approval_rate_30d: rate }).eq('id', client.id)
        if (rateError) throw new Error(rateError.message)
        approvalRatesUpdated++
      } catch (e) {
        const msg = `${client.name} (approval-rate): ${String((e as Error)?.message ?? e)}`
        errors.push(msg)
        console.error(`[midnight-cron] ${msg}`)
      }

      // CRHQ content is generated only by crhq-nightly-content's dedicated
      // 22:00 run (see file header). Skip it here — but log which brand was
      // skipped and why, so no active brand drops out of the run silently (#4).
      if (client.slug === 'crhq') {
        const note = `Skipped ${client.name} content generation — handled by crhq-nightly-content (dedicated 22:00 run)`
        notes.push(note)
        skipped.push(client.name)
        console.log(`[midnight-cron] ${note}`)
        continue
      }

      // Guard against a genuinely misconfigured active brand with nowhere to
      // post — log the skip explicitly rather than letting fillClientGap fail
      // opaquely deeper in (#4).
      const connected = Array.isArray(client.connected_platforms) ? client.connected_platforms : []
      if (connected.length === 0) {
        const note = `Skipped ${client.name} — active but no connected_platforms configured`
        notes.push(note)
        skipped.push(client.name)
        console.log(`[midnight-cron] ${note}`)
        continue
      }

      clientsProcessed++

      // Seasonal cadence — a gift brand in its selling season posts daily.
      // Applied to the in-memory copy used for generation only; mkt_clients is
      // never written to, so the brand's configured post_days is still what it
      // reverts to the moment the window closes. Nothing to undo.
      const { client: generationClient, note: seasonalNote } = applySeasonalPosting(client, now)
      if (seasonalNote) {
        notes.push(seasonalNote)
        console.log(`[midnight-cron] ${seasonalNote}`)
      }

      // Weekly blog — current week only. Cron runs daily, so this is a no-op
      // every day except the first day it's missing for that client.
      //
      // Adrian Fielding — LinkedIn has no blog/website surface at all (it's a
      // single personal LinkedIn profile, one post/week) — every other brand
      // reaching this point owns a real site a blog post can be
      // published to. Skipped explicitly, same one-off-brand pattern already
      // used for CRHQ's own content skip above, rather than adding a general
      // "does this brand blog" column for what is currently a single case.
      if (client.slug !== 'adrian-linkedin') {
        try {
          const title = await ensureWeeklyBlog(admin, client, sundayOfWeek(now))
          if (title) blogsGenerated++
        } catch (e) {
          const msg = `${client.name} (blog): ${String((e as Error)?.message ?? e)}`
          errors.push(msg)
          console.error(`[midnight-cron] ${msg}`)
        }
      }

      // Every client gets its own full budget — see PER_CLIENT_POST_BUDGET
      // comment above. A per-client try/catch means one client throwing
      // (e.g. Anthropic API error) can't abort the run for everyone after it.
      try {
        const { generated, errors: fillErrors, notes: fillNotes } = await fillClientGap(admin, generationClient, PER_CLIENT_POST_BUDGET)
        postsGenerated += generated
        if (fillErrors.length) {
          errors.push(...fillErrors)
          for (const fe of fillErrors) console.error(`[midnight-cron] ${fe}`)
        }
        if (fillNotes.length) {
          notes.push(...fillNotes)
          for (const fn of fillNotes) console.log(`[midnight-cron] ${fn}`)
        }
        console.log(`[midnight-cron] ${client.name}: ${generated} post(s) generated`)
      } catch (e) {
        const msg = `${client.name} (fill): ${String((e as Error)?.message ?? e)}`
        errors.push(msg)
        console.error(`[midnight-cron] ${msg}`)
      }
    }
  } catch (e) {
    const msg = `fatal: ${String((e as Error)?.message ?? e)}`
    errors.push(msg)
    console.error(`[midnight-cron] ${msg}`)
  }

  const { error: logError } = await admin.from('mkt_cron_log').insert({
    job_name: 'midnight-content-generation',
    clients_processed: clientsProcessed,
    posts_generated: postsGenerated,
    errors: errors.length ? errors : null,
    notes: notes.length ? notes : null,
    duration_ms: Date.now() - started,
  })
  if (logError) console.error(`[midnight-cron] failed to write mkt_cron_log: ${logError.message}`)

  // One summary row per failed run in the cross-function error log (see
  // generate-daily-status's edge_function_errors_last_24h) — same one-row-
  // per-run granularity as mkt_cron_log above, not one row per client error.
  if (errors.length) {
    const { error: efeError } = await admin.from('edge_function_errors').insert({
      function_name: 'midnight-cron',
      error_message: errors.join(' | ').slice(0, 4000),
    })
    if (efeError) console.error(`[midnight-cron] failed to write edge_function_errors: ${efeError.message}`)
  }

  console.log(`[midnight-cron] run complete — ${clientsProcessed} client(s), ${postsGenerated} post(s), ${blogsGenerated} blog(s), ${approvalRatesUpdated} approval-rate(s), ${skipped.length} skipped, ${notes.length} note(s), ${errors.length} error(s)`)

  return new Response(JSON.stringify({ ok: true, clientsProcessed, postsGenerated, blogsGenerated, approvalRatesUpdated, skipped, notes, errors }), {
    headers: { 'Content-Type': 'application/json' },
  })
})
