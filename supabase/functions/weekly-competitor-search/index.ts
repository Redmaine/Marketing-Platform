// Supabase Edge Function: weekly-competitor-search  (Deno)
// Part 5 of the SEO/content task. Runs every Monday 06:00 UTC, alongside
// metricool-weekly-pull (see 63_metricool_weekly_pull_cron.sql) and ahead of
// weekly-content-prompt (Monday 08:00).
//
// Uses the Anthropic API with the server-side web_search tool to run six
// fixed competitor-landscape searches in sequence, one per tracked market.
// For each, asks Claude to search the web then call a structured
// record_finding tool with a plain-text summary (<200 words) and the most
// relevant source URL. One row per search lands in competitor_intelligence.
//
// Sequential by design (not Promise.all) — six searches issued in parallel
// against the same Anthropic key risk bursting rate limits for no benefit;
// this only needs to finish well before the 07:30 digest reads it.
//
// ─────────────────────────────────────────────────────────────────────────
// WHY THIS FUNCTION WENT SILENT FOR A WEEK (fixed 2 Sep 2026)
//
// The 31 Aug 06:00 run inserted exactly ONE competitor_intelligence row
// (06:01:05, 65s after the cron fired) and then vanished: no mkt_cron_log
// row, no error anywhere. cron-healthcheck reported it stale at 196h.
//
// It was not the cron. cron.job 35 is active and fired on 31 Aug, as it had
// on the 24th, 17th and 10th. It was not auth either — that one inserted row
// proves checkCronAuth passed and the loop was running.
//
// What actually happened is that the run exceeded the platform's 400s wall
// clock limit and the worker was killed mid-loop, at which point the ONLY
// mkt_cron_log write — which lived after the loop, on the success path —
// never ran. The run therefore failed as pure silence rather than as an
// error, which is the same shape as the 12 Aug crhq-nightly-content outage.
//
// Three things combined to let a slow week become an invisible one:
//
//   1. NOTHING BOUNDED THE ANTHROPIC CALL. fetch() had no AbortController,
//      so a request that hung, hung forever. A server-side web_search turn
//      is not a normal completion: Anthropic runs up to max_uses searches
//      inside that single HTTP call, so its duration depends on how fast
//      third-party sites answer. Real per-query times measured from
//      competitor_intelligence bear that out — 24 Aug ran 25/15/14/27/36/40s
//      per query, but 31 Aug's first query alone took 65s. It is a long
//      right tail, not a constant.
//
//   2. THE RETRY MULTIPLIED IT. MAX_ATTEMPTS was 4, and on a 429 the wait
//      came straight from the retry-after header with no ceiling
//      (`retryAfter * 1000`). Anthropic is entitled to say retry-after: 60,
//      and four attempts of an unbounded request plus uncapped sleeps can
//      consume the entire 400s budget inside a SINGLE query.
//
//   3. THE RUN HAD NO DEADLINE OF ITS OWN. Six queries were attempted
//      unconditionally, so total runtime was however long six unbounded
//      calls happened to take. Successful runs took 103s, 148s and 178s —
//      already 45% of the budget, and trending the wrong way.
//
// The fix is to make it impossible for the function to die before it can say
// what happened, rather than to make the searches faster:
//
//   * Every request has an AbortController timeout (REQUEST_TIMEOUT_MS), and
//     that timeout is additionally clamped to the time left in the run, so a
//     single call can never run past the run's own deadline.
//   * Retry sleeps are capped (MAX_RETRY_SLEEP_MS) and also clamped to the
//     deadline, so retry-after can no longer eat the budget.
//   * A timeout is terminal for that query and is NOT retried, so one
//     pathological query cannot starve the ones after it — see the abort
//     branch in anthropicRequest for why, and for the measurement behind it.
//   * The search loop stops at SEARCH_DEADLINE_MS (300s) — 120s longer than
//     the slowest run this job has ever had — leaving ~100s of the 400s wall
//     clock reserved purely for writing the log and returning. Queries not
//     reached are recorded as skipped, with a reason, instead of silently
//     never happening.
//   * The mkt_cron_log insert's own error is now checked. It was the one
//     unchecked write in this file, so the table could have failed to record
//     a run and this function would still have returned 200.
//
// A 'weekly-competitor-search-started' row is written BEFORE any work, using
// the separate-job_name convention midnight-cron already uses for its
// dispatch/outcome split. Deliberately a different job_name from the real
// one: cron-healthcheck matches job_name exactly, so a started row can never
// mask a missing completion row and make a dead run look healthy. It exists
// so the next failure is diagnosable in one query — "started at X, never
// completed" — instead of having to be inferred from how many
// competitor_intelligence rows happened to land, which is how this outage
// had to be diagnosed.
//
// Worth knowing when reading pg_net: the caller NEVER sees this function's
// response. net.http_post times out at 5s and this job takes minutes, so
// every invocation leaves a "Timeout of 5000 ms reached" row in
// net._http_response and cron.job_run_details always says "succeeded" —
// it only records that the request was queued. A 546 wall-clock error would
// never have surfaced there. mkt_cron_log is the only real trace.
//
// Deploy: supabase functions deploy weekly-competitor-search
// Secrets (vault): ANTHROPIC_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { checkCronAuth } from '../_shared/cronAuth.ts'

// deno-lint-ignore no-explicit-any
type Admin = any

// Anthropic's response envelope and its content blocks are both
// loosely-typed JSON. Aliased once, with the ignore attached here, rather
// than repeating an inline `any` at each use site.
// deno-lint-ignore no-explicit-any
type JsonObject = Record<string, any>

const MODEL = 'claude-sonnet-5'

// ── Time bounds ──────────────────────────────────────────────────────────
// The platform wall clock is 400s on paid plans. Everything below exists so
// that the run always ends by DECIDING to stop, never by being killed.
//
// Searches stop being started past this point, leaving the remainder of the
// wall clock to write mkt_cron_log and return. 300s is 120s more than the
// slowest run this job has ever completed (178s on 11 Aug).
const SEARCH_DEADLINE_MS = 300_000

// Ceiling for one HTTP request to Anthropic. The slowest single query ever
// observed was 65s (31 Aug), so 90s allows for a bad-but-real week while
// still catching a genuine hang. Always additionally clamped to the time
// left in the run.
const REQUEST_TIMEOUT_MS = 90_000

// A 429's retry-after is honoured but not obeyed without limit — an hour-long
// retry-after must not silently become an hour-long function.
const MAX_RETRY_SLEEP_MS = 15_000

const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 529])
const MAX_ATTEMPTS = 3

const SEARCH_QUERIES = [
  'UK AI social media agency pricing and new entrants 2026',
  'trades business management software UK competitors 2026',
  'hormone health supplement brands UK new products 2026',
  "personalised children's books UK competitors 2026",
  'ADHD screening tools UK 2026',
  'GLP-1 companion apps UK 2026',
]

const RECORD_FINDING_TOOL = {
  name: 'record_finding',
  description: 'Record the outcome of the web search for this query.',
  input_schema: {
    type: 'object',
    properties: {
      result_summary: {
        type: 'string',
        description: 'Plain text summary of the most significant findings from the search — new entrants, pricing moves, notable launches. Under 200 words, no markdown.',
      },
      source_url: {
        type: 'string',
        description: 'The single most relevant source URL found during the search. Empty string if nothing usable was found.',
      },
    },
    required: ['result_summary', 'source_url'],
  },
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms))
}

// Every request is bounded twice: by REQUEST_TIMEOUT_MS, and by whatever is
// left before `deadline`. The second clamp is the one that matters — it is
// what makes "this function always reaches its own logging code" true
// regardless of how Anthropic behaves.
async function anthropicRequest(
  payload: Record<string, unknown>,
  deadline: number,
): Promise<JsonObject> {
  let lastErr = ''
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const remaining = deadline - Date.now()
    if (remaining <= 1_000) {
      throw new Error(lastErr ? `run deadline reached — last error: ${lastErr}` : 'run deadline reached before the request could be made')
    }

    const timeoutMs = Math.min(REQUEST_TIMEOUT_MS, remaining)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)

    // The whole attempt — including reading the body — happens inside one
    // timer. Clearing the timeout as soon as fetch() resolves would leave the
    // body read unguarded, and fetch() resolves on HEADERS: a response that
    // arrives and then stalls mid-body would hang exactly as before.
    let outcome:
      | { type: 'ok'; json: JsonObject }
      | { type: 'retry'; err: string; waitMs: number }
      | { type: 'fatal'; err: string }
    try {
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': Deno.env.get('ANTHROPIC_API_KEY')!,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      })

      if (r.ok) {
        outcome = { type: 'ok', json: await r.json() }
      } else {
        const errText = await r.text()
        const err = `Anthropic API error ${r.status}: ${errText.slice(0, 400)}`
        if (RETRYABLE_STATUSES.has(r.status) && attempt < MAX_ATTEMPTS) {
          // retry-after is honoured but capped — see MAX_RETRY_SLEEP_MS.
          const retryAfter = Number(r.headers.get('retry-after'))
          const asked = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 800 * 2 ** (attempt - 1)
          outcome = { type: 'retry', err, waitMs: Math.min(asked, MAX_RETRY_SLEEP_MS) }
        } else {
          outcome = { type: 'fatal', err }
        }
      }
    } catch (netErr) {
      // An abort is reported as what it is. Before this existed, this branch
      // could not be reached at all: the request simply never returned, and
      // the worker was killed still waiting on it.
      const aborted = (netErr as Error)?.name === 'AbortError'
      if (aborted) {
        // A timeout is TERMINAL for this query — deliberately not retried.
        // Observed hangs are query-specific and persistent, not transient
        // blips: the 2 Sep reproduction sat on one query for over 225s
        // without returning. Retrying a 90s timeout twice would spend 270s
        // of the 300s budget almost certainly failing again, and would do it
        // by starving the queries after it, turning one bad query into a
        // mostly-empty run. Failing it fast leaves the budget for the rest.
        outcome = { type: 'fatal', err: `timed out after ${Math.round(timeoutMs / 1000)}s — abandoned so the remaining searches keep their budget` }
      } else {
        // A genuine connection error is worth another go.
        const err = `network error: ${String((netErr as Error)?.message ?? netErr)}`
        outcome = attempt < MAX_ATTEMPTS
          ? { type: 'retry', err, waitMs: 800 * 2 ** (attempt - 1) }
          : { type: 'fatal', err: `Anthropic request failed after ${MAX_ATTEMPTS} attempts — ${err}` }
      }
    } finally {
      clearTimeout(timer)
    }

    if (outcome.type === 'ok') return outcome.json
    lastErr = outcome.err
    if (outcome.type === 'fatal') throw new Error(outcome.err)
    await sleepBounded(outcome.waitMs, deadline)
  }
  throw new Error(lastErr || 'Anthropic request failed')
}

// Never sleeps past the deadline — a wait that would outlive the run is
// pointless, and previously was the thing doing the outliving.
function sleepBounded(ms: number, deadline: number): Promise<void> {
  return sleep(Math.max(0, Math.min(ms, deadline - Date.now())))
}

// Single request combining the server-side web_search tool with a forced-ish
// custom tool: tool_choice is left "auto" (forcing a specific tool from turn
// one would stop the model calling web_search first) and the prompt instructs
// Claude to search, then always finish by calling record_finding. Web search
// itself is executed server-side by Anthropic within this one call — no
// client-side loop needed, which is also why one call can take a minute.
async function runSearch(query: string, deadline: number): Promise<{ result_summary: string; source_url: string }> {
  const system = [
    'You are a market-intelligence researcher for a UK marketing agency.',
    'For the given query: search the web for the most current, significant findings',
    '(new entrants, pricing changes, notable product launches), then call the',
    'record_finding tool exactly once with your summary. Always call record_finding',
    'as your final action, even if search results are sparse — in that case say so',
    'plainly in result_summary rather than inventing findings.',
  ].join(' ')

  const ai = await anthropicRequest({
    model: MODEL,
    max_tokens: 1500,
    system,
    messages: [{ role: 'user', content: `Search query: ${query}` }],
    tools: [
      { type: 'web_search_20260209', name: 'web_search', max_uses: 3 },
      RECORD_FINDING_TOOL,
    ],
  }, deadline)

  const blocks: JsonObject[] = ai?.content ?? []
  const toolUse = blocks.find((b) => b.type === 'tool_use' && b.name === 'record_finding')
  if (!toolUse) {
    // Model finished without calling record_finding (e.g. hit max_tokens
    // mid-search) — fall back to whatever text it did produce rather than
    // losing the run entirely.
    const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join(' ').trim()
    return { result_summary: text ? text.slice(0, 1200) : 'No structured result returned for this search.', source_url: '' }
  }
  const input = toolUse.input || {}
  return {
    result_summary: String(input.result_summary || '').trim() || 'No significant findings.',
    source_url: String(input.source_url || '').trim(),
  }
}

serve(async (req) => {
  const auth = await checkCronAuth(req, 'weekly-competitor-search')
  if (!auth.authorised) return auth.response!

  const started = Date.now()
  const searchDeadline = started + SEARCH_DEADLINE_MS
  const errors: string[] = []
  let searchesRun = 0

  const admin: Admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
  const runDate = new Date().toISOString().slice(0, 10)

  // Written before any work, under its OWN job_name so it can never be
  // mistaken for a completed run by cron-healthcheck (which matches job_name
  // exactly). If the worker is killed anyway, this row is the trace that
  // says so. Best-effort: failing to write it must not stop the actual job.
  const { error: startErr } = await admin.from('mkt_cron_log').insert({
    job_name: 'weekly-competitor-search-started',
    clients_processed: SEARCH_QUERIES.length,
    posts_generated: 0,
    notes: [`run started for ${runDate}; completion is recorded separately as weekly-competitor-search`],
  })
  if (startErr) console.error(`[weekly-competitor-search] failed to write start row: ${startErr.message}`)

  for (const query of SEARCH_QUERIES) {
    // Stopping early is a reported outcome, not a silent one. Before this,
    // "we ran out of time" and "this query returned nothing" were
    // indistinguishable, because neither was written down.
    if (Date.now() >= searchDeadline) {
      const msg = `${query}: skipped — ${Math.round(SEARCH_DEADLINE_MS / 1000)}s search budget exhausted before this query started`
      errors.push(msg)
      console.error(`[weekly-competitor-search] ${msg}`)
      continue
    }

    const queryStarted = Date.now()
    try {
      const { result_summary, source_url } = await runSearch(query, searchDeadline)
      const { error } = await admin.from('competitor_intelligence').insert({
        search_query: query,
        result_summary,
        source_url: source_url || null,
        run_date: runDate,
      })
      if (error) { errors.push(`${query}: insert failed — ${error.message}`); continue }
      searchesRun++
      console.log(`[weekly-competitor-search] ok "${query}" in ${Date.now() - queryStarted}ms (${Date.now() - started}ms into run)`)
    } catch (e) {
      const msg = `${query}: ${String((e as Error)?.message ?? e)}`
      errors.push(msg)
      console.error(`[weekly-competitor-search] failed after ${Date.now() - queryStarted}ms — ${msg}`)
    }
  }

  const durationMs = Date.now() - started
  // The one row cron-healthcheck watches. Its error is checked now — this
  // was the only unchecked write in the file, so a failure here would have
  // produced exactly the silence this whole function was fixed for, while
  // still returning 200.
  const { error: logError } = await admin.from('mkt_cron_log').insert({
    job_name: 'weekly-competitor-search',
    clients_processed: searchesRun,
    posts_generated: 0,
    errors: errors.length ? errors : null,
    duration_ms: durationMs,
    notes: [`${searchesRun}/${SEARCH_QUERIES.length} searches recorded in ${Math.round(durationMs / 1000)}s`],
  })
  if (logError) console.error(`[weekly-competitor-search] failed to write mkt_cron_log: ${logError.message}`)

  console.log(`[weekly-competitor-search] complete — ${searchesRun}/${SEARCH_QUERIES.length} in ${durationMs}ms, ${errors.length} error(s)`)

  return new Response(JSON.stringify({
    ok: true,
    searchesRun,
    total: SEARCH_QUERIES.length,
    durationMs,
    errors,
    logWritten: !logError,
  }), { headers: { 'Content-Type': 'application/json' } })
})
