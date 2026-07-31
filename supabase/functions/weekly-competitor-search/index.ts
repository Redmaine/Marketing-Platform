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
// Deploy: supabase functions deploy weekly-competitor-search
// Secrets (vault): ANTHROPIC_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'

// deno-lint-ignore no-explicit-any
type Admin = any

const MODEL = 'claude-sonnet-5'

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

const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 529])
const MAX_ATTEMPTS = 4

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms))
}

async function anthropicRequest(payload: Record<string, unknown>): Promise<Record<string, any>> {
  let lastErr = ''
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let r: Response
    try {
      r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': Deno.env.get('ANTHROPIC_API_KEY')!,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: JSON.stringify(payload),
      })
    } catch (netErr) {
      lastErr = `network error: ${String((netErr as Error)?.message ?? netErr)}`
      if (attempt < MAX_ATTEMPTS) { await sleep(800 * 2 ** (attempt - 1)); continue }
      throw new Error(`Anthropic request failed after ${MAX_ATTEMPTS} attempts — ${lastErr}`)
    }

    if (r.ok) return await r.json()

    const errText = await r.text()
    lastErr = `Anthropic API error ${r.status}: ${errText.slice(0, 400)}`
    if (!RETRYABLE_STATUSES.has(r.status) || attempt === MAX_ATTEMPTS) throw new Error(lastErr)

    const retryAfter = Number(r.headers.get('retry-after'))
    const waitMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 800 * 2 ** (attempt - 1)
    await sleep(waitMs)
  }
  throw new Error(lastErr || 'Anthropic request failed')
}

// Single request combining the server-side web_search tool with a forced-ish
// custom tool: tool_choice is left "auto" (forcing a specific tool from turn
// one would stop the model calling web_search first) and the prompt instructs
// Claude to search, then always finish by calling record_finding. Web search
// itself is executed server-side by Anthropic within this one call — no
// client-side loop needed.
async function runSearch(query: string): Promise<{ result_summary: string; source_url: string }> {
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
  })

  const blocks: Record<string, any>[] = ai?.content ?? []
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

serve(async () => {
  const started = Date.now()
  const errors: string[] = []
  let searchesRun = 0

  const admin: Admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
  const runDate = new Date().toISOString().slice(0, 10)

  for (const query of SEARCH_QUERIES) {
    try {
      const { result_summary, source_url } = await runSearch(query)
      const { error } = await admin.from('competitor_intelligence').insert({
        search_query: query,
        result_summary,
        source_url: source_url || null,
        run_date: runDate,
      })
      if (error) { errors.push(`${query}: insert failed — ${error.message}`); continue }
      searchesRun++
    } catch (e) {
      errors.push(`${query}: ${String((e as Error)?.message ?? e)}`)
    }
  }

  await admin.from('mkt_cron_log').insert({
    job_name: 'weekly-competitor-search',
    clients_processed: searchesRun,
    posts_generated: 0,
    errors: errors.length ? errors : null,
    duration_ms: Date.now() - started,
  })

  return new Response(JSON.stringify({ ok: true, searchesRun, total: SEARCH_QUERIES.length, errors }), {
    headers: { 'Content-Type': 'application/json' },
  })
})
