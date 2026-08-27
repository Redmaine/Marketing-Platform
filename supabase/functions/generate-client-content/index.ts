// Supabase Edge Function: generate-client-content  (Deno)
// Does ONE active client's nightly fill: approval-rate refresh, weekly blog,
// real-events context (Adrian Fielding — LinkedIn only), and fillClientGap.
// Invoke: { client_id }
//
// Extracted from midnight-cron's old per-client loop body — see that file's
// header for the full story. Supabase Edge Functions have a hard 150s
// platform idle timeout independent of pg_cron/pg_net settings, and running
// every active client sequentially in one invocation took 13+ minutes,
// meaning midnight-cron never completed a run since 9 July (confirmed via a
// manual invocation that got killed after only 2 of 11 clients). Splitting
// each client's work into its own invocation, dispatched by midnight-cron
// (now a lightweight dispatcher — see that file), means each client's fill
// has its own 150s budget instead of sharing one across all active clients.
//
// Same internal-only auth as the old midnight-cron: no mkt_is_admin gate.
// This is invoked with the service role bearer the dispatcher already holds,
// never with a user JWT — cron has no user email to check (see the original
// midnight-cron header for why generate-content, the admin-gated function,
// was never an option here).
//
// checkCronAuth added (27 Aug 2026, header-fixes audit) — this was the one
// function in the checkCronAuth family with no code-level gate at all,
// relying solely on the platform's verify_jwt:true. That only proves "some
// valid signed JWT was presented" — the anon key is itself a valid JWT by
// design, so anyone holding the (public, client-side) anon key could invoke
// this and trigger real AI content generation. Same pattern as every other
// cron-only function in this repo (see check-client-news, midnight-cron,
// etc.) — checked first, before any other work.
//
// Deploy:  supabase functions deploy generate-client-content
// Secrets (vault): ANTHROPIC_API_KEY.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { checkCronAuth } from '../_shared/cronAuth.ts'
import { sundayOfWeek } from '../_shared/generate.ts'
import { ensureWeeklyBlog } from '../_shared/blog.ts'
import { fillClientGap } from '../_shared/fill.ts'
import { buildRealEventsContext } from '../_shared/realEvents.ts'

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
// Every client invocation gets this full budget independently — there is no
// shared pool to split, since each client now runs in its own invocation.
const PER_CLIENT_POST_BUDGET = 20

// ── Seasonal posting windows (Once Upon A You) ──────────────────────────────
// OUAY is a gift product, so its three selling seasons are worth more than the
// rest of the year combined. Inside a window the brand posts DAILY; outside it
// keeps its normal cadence.
//
// The brand is resolved from the mkt_clients row this run already loaded
// (slug), not from a name hardcoded in a constant — same approach as the
// CRHQ skip below. If OUAY's slug ever changes, this stops applying rather
// than silently applying to the wrong brand.
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

serve(async (req) => {
  const auth = await checkCronAuth(req, 'generate-client-content')
  if (!auth.authorised) return auth.response!

  const started = Date.now()
  const errors: string[] = []
  const notes: string[] = []
  let postsGenerated = 0
  let blogsGenerated = 0
  let approvalRateUpdated = false
  let skipped = false
  let clientName = 'unknown'

  const admin: Admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)

  try {
    const { client_id } = await req.json()
    if (!client_id) {
      return new Response(JSON.stringify({ ok: false, error: 'client_id required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    const { data: client, error: clientError } = await admin.from('mkt_clients').select('*').eq('id', client_id).maybeSingle()
    if (clientError) throw new Error(`could not load client ${client_id}: ${clientError.message}`)
    if (!client) throw new Error(`client ${client_id} not found`)
    clientName = client.name
    const now = new Date()

    // Content-quality tracking — refresh this brand's 30-day approval rate.
    // Pure stats read/write; a failure here must not stop the rest of this
    // client's run.
    try {
      const rate = await computeApprovalRate30d(admin, client.id)
      const { error: rateError } = await admin.from('mkt_clients').update({ approval_rate_30d: rate }).eq('id', client.id)
      if (rateError) throw new Error(rateError.message)
      approvalRateUpdated = true
    } catch (e) {
      const msg = `${client.name} (approval-rate): ${String((e as Error)?.message ?? e)}`
      errors.push(msg)
      console.error(`[generate-client-content] ${msg}`)
    }

    // CRHQ content is generated only by crhq-nightly-content's dedicated
    // 22:00 run (its content goes stale within hours — geopolitics, defence
    // — so a weeks-ahead bulk fill is exactly wrong for it). Skipped here,
    // but logged explicitly rather than silently doing nothing.
    if (client.slug === 'crhq') {
      const note = `Skipped ${client.name} content generation — handled by crhq-nightly-content (dedicated 22:00 run)`
      notes.push(note)
      skipped = true
      console.log(`[generate-client-content] ${note}`)
    } else {
      // Guard against a genuinely misconfigured active brand with nowhere to
      // post — log the skip explicitly rather than letting fillClientGap fail
      // opaquely deeper in.
      const connected = Array.isArray(client.connected_platforms) ? client.connected_platforms : []
      if (connected.length === 0) {
        const note = `Skipped ${client.name} — active but no connected_platforms configured`
        notes.push(note)
        skipped = true
        console.log(`[generate-client-content] ${note}`)
      } else {
        // Seasonal cadence — a gift brand in its selling season posts daily.
        // Applied to the in-memory copy used for generation only; mkt_clients
        // is never written to, so the brand's configured post_days is still
        // what it reverts to the moment the window closes. Nothing to undo.
        const { client: generationClient, note: seasonalNote } = applySeasonalPosting(client, now)
        if (seasonalNote) {
          notes.push(seasonalNote)
          console.log(`[generate-client-content] ${seasonalNote}`)
        }

        // Weekly blog — current week only. Cron runs daily, so this is a
        // no-op every day except the first day it's missing for that client.
        //
        // Adrian Fielding — LinkedIn has no blog/website surface at all
        // (it's a single personal LinkedIn profile, one post/week) — every
        // other brand reaching this point owns a real site a blog post can
        // be published to.
        if (client.slug !== 'adrian-linkedin') {
          try {
            const title = await ensureWeeklyBlog(admin, client, sundayOfWeek(now))
            if (title) blogsGenerated++
          } catch (e) {
            const msg = `${client.name} (blog): ${String((e as Error)?.message ?? e)}`
            errors.push(msg)
            console.error(`[generate-client-content] ${msg}`)
          }
        }

        // Adrian Fielding — LinkedIn only: real weekly activity, so
        // generation has true material to write from instead of inventing
        // something to satisfy its own "reference something real that
        // happened this week" brief (see _shared/realEvents.ts). Attached
        // directly onto generationClient BEFORE fillClientGap runs.
        if (client.slug === 'adrian-linkedin') {
          try {
            const context = await buildRealEventsContext(admin)
            ;(generationClient as Record<string, unknown>)._real_events_context = context
            console.log(`[generate-client-content] ${client.name}: real-events context built (${context.length} chars)`)
          } catch (e) {
            const msg = `${client.name} (real-events context): ${String((e as Error)?.message ?? e)}`
            errors.push(msg)
            console.error(`[generate-client-content] ${msg}`)
          }
        }

        try {
          const { generated, errors: fillErrors, notes: fillNotes } = await fillClientGap(admin, generationClient, PER_CLIENT_POST_BUDGET)
          postsGenerated += generated
          if (fillErrors.length) {
            errors.push(...fillErrors)
            for (const fe of fillErrors) console.error(`[generate-client-content] ${fe}`)
          }
          if (fillNotes.length) {
            notes.push(...fillNotes)
            for (const fn of fillNotes) console.log(`[generate-client-content] ${fn}`)
          }
          console.log(`[generate-client-content] ${client.name}: ${generated} post(s) generated`)
        } catch (e) {
          const msg = `${client.name} (fill): ${String((e as Error)?.message ?? e)}`
          errors.push(msg)
          console.error(`[generate-client-content] ${msg}`)
        }
      }
    }
  } catch (e) {
    const msg = `fatal: ${String((e as Error)?.message ?? e)}`
    errors.push(msg)
    console.error(`[generate-client-content] ${msg}`)
  }

  // One mkt_cron_log row per client per run (not an aggregated one-row-per-
  // run like the old midnight-cron) — each client now runs in its own
  // invocation with no shared state to aggregate into, and waiting for every
  // child to report back before writing one combined row would mean the
  // dispatcher blocking on all of them, recreating the exact timeout this
  // split exists to avoid. job_name is kept as 'midnight-content-generation'
  // (not renamed) so any existing query filtering on that job_name keeps
  // working unchanged — it now just returns one row per client per night
  // instead of one row for the whole run. midnight-cron's own dispatch
  // summary logs separately under 'midnight-cron-dispatch', so "did the
  // dispatcher fire" and "did client X's fill complete" are never conflated.
  const { error: logError } = await admin.from('mkt_cron_log').insert({
    job_name: 'midnight-content-generation',
    clients_processed: skipped ? 0 : 1,
    posts_generated: postsGenerated,
    errors: errors.length ? errors : null,
    notes: notes.length ? notes : null,
    duration_ms: Date.now() - started,
  })
  if (logError) console.error(`[generate-client-content] failed to write mkt_cron_log: ${logError.message}`)

  if (errors.length) {
    const { error: efeError } = await admin.from('edge_function_errors').insert({
      function_name: 'generate-client-content',
      error_message: `${clientName}: ${errors.join(' | ')}`.slice(0, 4000),
    })
    if (efeError) console.error(`[generate-client-content] failed to write edge_function_errors: ${efeError.message}`)
  }

  console.log(`[generate-client-content] ${clientName} complete — ${postsGenerated} post(s), ${blogsGenerated} blog(s), approval-rate updated: ${approvalRateUpdated}, skipped: ${skipped}, ${notes.length} note(s), ${errors.length} error(s)`)

  return new Response(JSON.stringify({ ok: true, client: clientName, postsGenerated, blogsGenerated, approvalRateUpdated, skipped, notes, errors }), {
    headers: { 'Content-Type': 'application/json' },
  })
})
