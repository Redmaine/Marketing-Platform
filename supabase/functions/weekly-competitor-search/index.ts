// Supabase Edge Function: weekly-competitor-search  (Deno)
// Part 5 of the SEO/content task. Runs every Monday 06:00 UTC, alongside
// metricool-weekly-pull (see 63_metricool_weekly_pull_cron.sql) and ahead of
// weekly-content-prompt (Monday 08:00).
//
// DISPATCHER ONLY as of 19 Sep 2026 — see weekly-competitor-search-query for
// where the real work (one Anthropic web-search call, one
// competitor_intelligence insert) now happens. This file fires one
// independent invocation per search query and reports on what they all did;
// it does no Anthropic work itself.
//
// ─────────────────────────────────────────────────────────────────────────
// WHY THIS CHANGED AGAIN (previously "fixed" 2 Sep 2026)
//
// The 2 Sep fix (AbortController timeouts, capped retries, a 300s in-run
// deadline covering all six queries) was real and necessary, but it died
// again on 14 Sep: 2/6 searches recorded (06:00:41, 06:00:56), then total
// silence — no error row, no completion row, nothing. Identical shape to
// the outage it was built to fix.
//
// ROOT CAUSE: the 2 Sep fix bounded the wrong ceiling. It was calibrated
// against Supabase's DOCUMENTED wall-clock limit (400s on paid plans —
// supabase.com/docs/guides/functions/limits). But this project had already
// discovered, on a different function, that the REAL ceiling for a
// pg_cron/pg_net-triggered invocation is far shorter and UNDOCUMENTED:
// midnight-cron's own header (8 Aug 2026) records "a hard 150-second
// platform idle timeout, independent of any pg_cron/pg_net setting",
// confirmed by live reproduction — killed after 2 of 11 clients, having
// never reached its own logging step. 14 Sep's "2 of 6, then silence" is
// the same signature. The 300s in-run deadline this function used to carry
// was never checked against that number — it was carefully engineered
// against a ceiling roughly 2.5x higher than the one that actually applies,
// so it could never fire in time to protect anything.
//
// THE FIX applies midnight-cron's own proven solution instead of re-tuning
// numbers against a limit that keeps turning out to be wrong: give each unit
// of work (here, one search query) its own independent invocation and its
// own fresh budget, so no single invocation is ever asked to do more than
// ~150s of the platform will allow it — see weekly-competitor-search-query.
// This file becomes a thin dispatcher, exactly like midnight-cron/
// generate-client-content: fire-and-report, no LLM work of its own, so it
// can never hit either ceiling itself.
//
// Deploy: supabase functions deploy weekly-competitor-search
// Deploy: supabase functions deploy weekly-competitor-search-query
// Secrets (vault): SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
// (weekly-competitor-search-query needs its own ANTHROPIC_API_KEY too)
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { checkCronAuth } from '../_shared/cronAuth.ts'

// deno-lint-ignore no-explicit-any
type Admin = any

const SEARCH_QUERIES = [
  'UK AI social media agency pricing and new entrants 2026',
  'trades business management software UK competitors 2026',
  'hormone health supplement brands UK new products 2026',
  "personalised children's books UK competitors 2026",
  'ADHD screening tools UK 2026',
  'GLP-1 companion apps UK 2026',
]

// Spacing between firing each query's dispatch — same reasoning and same
// value as midnight-cron's STAGGER_MS: avoids firing six requests in the
// same millisecond (the self-inflicted burst midnight-cron's own history
// warns about), while adding at most ~5s total across six queries, nowhere
// near either ceiling.
const STAGGER_MS = 750
const DISPATCH_MAX_ATTEMPTS = 3
const DISPATCH_BACKOFF_MS = [1000, 3000]

// Same set _shared/generate.ts and midnight-cron both already use — one
// definition of "transient" across the project, not several. A 4xx here
// means this dispatcher sent something wrong and retrying would not help;
// a 5xx/429 is worth a second attempt.
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 529])

async function logEdgeError(admin: Admin, message: string) {
  const { error } = await admin.from('edge_function_errors').insert({ function_name: 'weekly-competitor-search', error_message: message })
  if (error) console.error('[weekly-competitor-search] failed to write edge_function_errors:', error.message)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

type DispatchResult = {
  query: string
  ok: boolean
  attempts: number
  lastError?: string
  terminal?: boolean
}

// Fires one query's dispatch, retrying a transient HTTP failure or network
// error up to DISPATCH_MAX_ATTEMPTS times — mirrors midnight-cron's
// dispatchClientWithRetry exactly, including WHY there's no per-attempt
// AbortController here: this fetch stays open for the whole of
// weekly-competitor-search-query's real work (up to ~120s), and aborting it
// would not stop that function running server-side — it would just start a
// second, concurrent, duplicate search. A hung dispatch is bounded by the
// receiving function's own WORKER_DEADLINE_MS instead.
async function dispatchQueryWithRetry(
  admin: Admin, targetUrl: string, serviceKey: string, query: string, runDate: string,
): Promise<DispatchResult> {
  let lastMsg = 'unknown error'
  for (let attempt = 1; attempt <= DISPATCH_MAX_ATTEMPTS; attempt++) {
    let terminal = false
    try {
      const res = await fetch(targetUrl, {
        method: 'POST',
        headers: { Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, runDate }),
      })
      if (res.ok) {
        if (attempt > 1) console.log(`[weekly-competitor-search] "${query}" succeeded on attempt ${attempt}/${DISPATCH_MAX_ATTEMPTS}`)
        return { query, ok: true, attempts: attempt }
      }
      let detail = ''
      try { detail = String(((await res.json()) as { error?: string })?.error ?? '').slice(0, 300) } catch { /* body already consumed or not json */ }
      terminal = !RETRYABLE_STATUSES.has(res.status)
      lastMsg = `"${query}" returned HTTP ${res.status}${detail ? `: ${detail}` : ''}`
        + (terminal ? ' — not a transient status, not retried' : ` (attempt ${attempt}/${DISPATCH_MAX_ATTEMPTS})`)
    } catch (e) {
      lastMsg = `"${query}" dispatch failed: ${String((e as Error)?.message ?? e)} (attempt ${attempt}/${DISPATCH_MAX_ATTEMPTS})`
    }
    console.error(`[weekly-competitor-search] ${lastMsg}`)

    if (terminal) return { query, ok: false, attempts: attempt, lastError: lastMsg, terminal: true }
    if (attempt < DISPATCH_MAX_ATTEMPTS) await sleep(DISPATCH_BACKOFF_MS[attempt - 1])
  }
  return { query, ok: false, attempts: DISPATCH_MAX_ATTEMPTS, lastError: lastMsg, terminal: false }
}

// The fan-out: fire one dispatch per query, spaced by STAGGER_MS, none of
// them awaited in the main loop, then register a background task that
// records what they all ended up doing once every one has settled.
async function dispatchAllQueries(
  admin: Admin, targetUrl: string, serviceKey: string, runDate: string, started: number,
) {
  const dispatched: string[] = []
  // deno-lint-ignore no-explicit-any
  const rt = (globalThis as any).EdgeRuntime
  const inFlight: Promise<DispatchResult>[] = []

  for (let i = 0; i < SEARCH_QUERIES.length; i++) {
    const query = SEARCH_QUERIES[i]
    const promise = dispatchQueryWithRetry(admin, targetUrl, serviceKey, query, runDate)
    inFlight.push(promise)

    if (rt?.waitUntil) {
      rt.waitUntil(promise)
    } else {
      console.log(`[weekly-competitor-search] EdgeRuntime.waitUntil unavailable — dispatched "${query}" without background-task registration`)
    }

    dispatched.push(query)
    if (i < SEARCH_QUERIES.length - 1) await sleep(STAGGER_MS)
  }
  console.log(`[weekly-competitor-search] dispatched ${dispatched.length} quer${dispatched.length === 1 ? 'y' : 'ies'}`)

  // This is the row cron-healthcheck and the digest actually watch (same
  // job_name as before the split, so neither needs to change). Written once
  // every dispatch has settled, as a background task registered via
  // waitUntil — same shape as midnight-cron's logDispatchOutcome — so this
  // function's own early HTTP response is never held up by the slowest
  // query, but the summary row still lands.
  const outcome = Promise.allSettled(inFlight).then(async (settled) => {
    const results = settled.map((s, i) =>
      s.status === 'fulfilled'
        ? s.value
        : { query: dispatched[i] ?? 'unknown', ok: false, attempts: 0, lastError: `dispatch task threw: ${String(s.reason)}`, terminal: true },
    )
    const searchesRun = results.filter((r) => r.ok).length
    const errors = results.filter((r) => !r.ok).map((r) => r.lastError || `"${r.query}" failed`)
    const durationMs = Date.now() - started

    const { error } = await admin.from('mkt_cron_log').insert({
      job_name: 'weekly-competitor-search',
      clients_processed: searchesRun,
      posts_generated: 0,
      errors: errors.length ? errors : null,
      duration_ms: durationMs,
      notes: [`${searchesRun}/${SEARCH_QUERIES.length} searches recorded in ${Math.round(durationMs / 1000)}s (dispatched)`],
    })
    if (error) {
      console.error(`[weekly-competitor-search] failed to write completion mkt_cron_log row: ${error.message}`)
      await logEdgeError(admin, `failed to write completion mkt_cron_log row: ${error.message}`)
    } else {
      console.log(`[weekly-competitor-search] complete — ${searchesRun}/${SEARCH_QUERIES.length} in ${durationMs}ms, ${errors.length} error(s)`)
    }
  })

  if (rt?.waitUntil) rt.waitUntil(outcome)
  return dispatched
}

serve(async (req) => {
  const auth = await checkCronAuth(req, 'weekly-competitor-search')
  if (!auth.authorised) return auth.response!

  const started = Date.now()
  const admin: Admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  const supabaseUrl = Deno.env.get('SUPABASE_URL')!
  const runDate = new Date().toISOString().slice(0, 10)
  const targetUrl = `${supabaseUrl}/functions/v1/weekly-competitor-search-query`

  // Written before any dispatch, under its OWN job_name so it can never be
  // mistaken for a completed run by cron-healthcheck. Unchanged from the
  // 2 Sep fix — still the trace that says the dispatcher itself woke up,
  // regardless of what its dispatches go on to do.
  const { error: startErr } = await admin.from('mkt_cron_log').insert({
    job_name: 'weekly-competitor-search-started',
    clients_processed: SEARCH_QUERIES.length,
    posts_generated: 0,
    notes: [`run started for ${runDate}; completion is recorded separately as weekly-competitor-search`],
  })
  if (startErr) console.error(`[weekly-competitor-search] failed to write start row: ${startErr.message}`)

  const dispatched = await dispatchAllQueries(admin, targetUrl, serviceKey, runDate, started)

  return new Response(JSON.stringify({
    ok: true,
    dispatched: dispatched.length,
    total: SEARCH_QUERIES.length,
    note: 'completion is recorded separately in mkt_cron_log once all dispatched queries settle',
  }), { headers: { 'Content-Type': 'application/json' } })
})
