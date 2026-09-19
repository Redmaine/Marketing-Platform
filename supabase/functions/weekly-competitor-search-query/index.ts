// Supabase Edge Function: weekly-competitor-search-query  (Deno)
//
// Does exactly ONE competitor-intelligence search and returns. Split out of
// weekly-competitor-search (19 Sep 2026) after that function died silently
// again on 14 Sep — 2/6 searches recorded, then total silence, no error row,
// despite the 2 Sep fix (AbortController timeouts, capped retries, a 300s
// in-run deadline).
//
// REAL ROOT CAUSE OF THE 14 SEP DEATH. The 2 Sep fix was calibrated against
// Supabase's DOCUMENTED wall-clock limit — 400s on paid plans (see
// supabase.com/docs/guides/functions/limits). But this project had already
// found, the hard way, on a different function, that the REAL ceiling for a
// pg_cron/pg_net-triggered invocation is far shorter: midnight-cron's own
// header (8 Aug 2026 incident) documents "a hard 150-second platform idle
// timeout, independent of any pg_cron/pg_net setting", confirmed by live
// reproduction — a sequential run was killed after 2 of 11 clients, having
// never reached its own logging step. The 14 Sep weekly-competitor-search
// death has the identical shape: 2 items completed, then killed before
// query 3 could log anything, error or otherwise — consistent with the
// SAME ~150s ceiling, which the 2 Sep fix's own 300s in-run deadline and 90s
// per-query timeout were never checked against. Supabase's own docs don't
// mention this shorter limit at all; it is only known from this project's
// own prior incident.
//
// THE FIX applies midnight-cron's own solution (dispatcher + independent
// per-unit invocations, each getting a fresh budget) rather than trying to
// find a smaller number that fits six queries into one invocation's share of
// an empirically-discovered, undocumented ceiling. This file is the "per-
// unit" half: one query, one Anthropic call (bounded by its own
// AbortController, unchanged from the 2 Sep fix), one insert, done — with a
// worst-case ceiling of its own (WORKER_DEADLINE_MS, 120s) that stays well
// under the 150s figure even if every retry is needed, instead of six
// queries' worth of that risk sharing one budget that was already too small
// for two.
//
// POST { query: string, runDate: string } — internal only, dispatched by
// weekly-competitor-search/index.ts using its own SUPABASE_SERVICE_ROLE_KEY
// as a bearer token, the same pattern sweep-stuck-metricool-posts already
// uses to call schedule-to-metricool.
//
// Deploy: supabase functions deploy weekly-competitor-search-query
// Secrets (vault): ANTHROPIC_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { checkCronAuth } from '../_shared/cronAuth.ts'

// deno-lint-ignore no-explicit-any
type Admin = any
// deno-lint-ignore no-explicit-any
type JsonObject = Record<string, any>

const MODEL = 'claude-sonnet-5'

// This invocation's own overall ceiling — deliberately well under the ~150s
// empirical limit documented above, even accounting for retries, so a single
// bad query can no longer risk a silent platform kill the way six queries
// sharing one 300s budget could. Not the documented-but-wrong 400s number.
const WORKER_DEADLINE_MS = 120_000

// Ceiling for one HTTP request to Anthropic — unchanged from the 2 Sep fix.
// The slowest single query ever observed was 65s, so 90s allows for a
// bad-but-real week while still catching a genuine hang. Always additionally
// clamped to WORKER_DEADLINE_MS via the `remaining` check in anthropicRequest.
const REQUEST_TIMEOUT_MS = 90_000

const MAX_RETRY_SLEEP_MS = 15_000
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 529])
const MAX_ATTEMPTS = 3

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

// Never sleeps past the deadline — unchanged reasoning from the 2 Sep fix,
// just scoped to this one worker's own deadline instead of a shared one.
function sleepBounded(ms: number, deadline: number): Promise<void> {
  return sleep(Math.max(0, Math.min(ms, deadline - Date.now())))
}

// Identical logic to the 2 Sep fix's anthropicRequest — every request bounded
// twice, by REQUEST_TIMEOUT_MS and by whatever is left before `deadline`; a
// timeout is terminal and not retried; retry sleeps are capped and clamped.
// See weekly-competitor-search-query's file header for what changed (the
// deadline this is measured against) and what didn't (this function itself).
async function anthropicRequest(
  payload: Record<string, unknown>,
  deadline: number,
): Promise<JsonObject> {
  let lastErr = ''
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const remaining = deadline - Date.now()
    if (remaining <= 1_000) {
      throw new Error(lastErr ? `worker deadline reached — last error: ${lastErr}` : 'worker deadline reached before the request could be made')
    }

    const timeoutMs = Math.min(REQUEST_TIMEOUT_MS, remaining)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)

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
          const retryAfter = Number(r.headers.get('retry-after'))
          const asked = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 800 * 2 ** (attempt - 1)
          outcome = { type: 'retry', err, waitMs: Math.min(asked, MAX_RETRY_SLEEP_MS) }
        } else {
          outcome = { type: 'fatal', err }
        }
      }
    } catch (netErr) {
      const aborted = (netErr as Error)?.name === 'AbortError'
      if (aborted) {
        outcome = { type: 'fatal', err: `timed out after ${Math.round(timeoutMs / 1000)}s` }
      } else {
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
  const auth = await checkCronAuth(req, 'weekly-competitor-search-query')
  if (!auth.authorised) return auth.response!

  const started = Date.now()
  const deadline = started + WORKER_DEADLINE_MS

  let body: { query?: string; runDate?: string }
  try {
    body = await req.json()
  } catch {
    return new Response(JSON.stringify({ ok: false, error: 'invalid JSON body' }), { status: 400, headers: { 'Content-Type': 'application/json' } })
  }
  const query = String(body.query || '').trim()
  const runDate = String(body.runDate || '').trim()
  if (!query || !runDate) {
    return new Response(JSON.stringify({ ok: false, error: 'missing "query" or "runDate"' }), { status: 400, headers: { 'Content-Type': 'application/json' } })
  }

  const admin: Admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)

  try {
    const { result_summary, source_url } = await runSearch(query, deadline)
    const { error } = await admin.from('competitor_intelligence').insert({
      search_query: query,
      result_summary,
      source_url: source_url || null,
      run_date: runDate,
    })
    if (error) {
      console.error(`[weekly-competitor-search-query] "${query}" insert failed: ${error.message}`)
      return new Response(JSON.stringify({ ok: false, query, error: `insert failed — ${error.message}` }), { status: 500, headers: { 'Content-Type': 'application/json' } })
    }
    console.log(`[weekly-competitor-search-query] ok "${query}" in ${Date.now() - started}ms`)
    return new Response(JSON.stringify({ ok: true, query, durationMs: Date.now() - started }), { headers: { 'Content-Type': 'application/json' } })
  } catch (e) {
    const msg = String((e as Error)?.message ?? e)
    console.error(`[weekly-competitor-search-query] "${query}" failed after ${Date.now() - started}ms — ${msg}`)
    return new Response(JSON.stringify({ ok: false, query, error: msg }), { status: 500, headers: { 'Content-Type': 'application/json' } })
  }
})
