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
// Deploy:  supabase functions deploy midnight-cron
// Schedule: see 11_cron_jobs.sql.  Secrets (vault): ANTHROPIC_API_KEY.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { sundayOfWeek } from '../_shared/generate.ts'
import { ensureWeeklyBlog } from '../_shared/blog.ts'
import { fillClientGap } from '../_shared/fill.ts'

// Per-client safety ceiling passed to fillClientGap as its `budget` param.
// This is NOT a shared pool split across clients — every active client gets
// this full budget independently, so client 1 needing a big catch-up fill
// can never starve client 2..N of that night's content generation. It only
// exists as a sane upper bound; fillClientGap already stops itself once a
// client's own posting-frequency target is met.
const PER_CLIENT_POST_BUDGET = 20

// CRHQ-specific: the 22:00 scrape-crhq-content cron (2 hours before this one)
// writes a row to crhq_scrape_cache. A scrape counts as "fresh enough to use"
// only within this window of its own run — an older row is stale and ignored,
// not used, so a broken/missed 22:00 run never silently reuses yesterday's
// content as if it were tonight's.
const SCRAPE_FRESHNESS_HOURS = 3

// Looks up the most recent crhq_scrape_cache row (if any, and if fresh) and
// attaches it to a COPY of the client object as _crhq_scrape, which
// buildUserMessage (prompts.ts) folds into the generation prompt. Every other
// client is returned untouched. Any lookup failure, or no fresh row, or an
// empty scrape, just returns the client as-is — fillClientGap then generates
// exactly as it always has, off the standard master-prompt pillars, with no
// error surfaced. This is the only integration point; fill.ts and review.ts
// are unchanged.
async function attachCrhqScrapeIfDue(admin: ReturnType<typeof createClient>, client: Record<string, any>): Promise<Record<string, any>> {
  if (!String(client.name || '').toLowerCase().includes('combat ready')) return client
  try {
    const cutoff = new Date(Date.now() - SCRAPE_FRESHNESS_HOURS * 3600_000).toISOString()
    const { data } = await admin
      .from('crhq_scrape_cache')
      .select('videos, articles, scraped_at')
      .gte('scraped_at', cutoff)
      .order('scraped_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (!data) return client
    const videos = Array.isArray(data.videos) ? data.videos : []
    const articles = Array.isArray(data.articles) ? data.articles : []
    if (videos.length === 0 && articles.length === 0) return client
    console.log(`[midnight-cron] ${client.name}: using scrape from ${data.scraped_at} (${videos.length} video(s), ${articles.length} article(s))`)
    return { ...client, _crhq_scrape: { videos, articles } }
  } catch (e) {
    console.error(`[midnight-cron] ${client.name}: crhq_scrape_cache lookup failed — ${String((e as Error)?.message ?? e)}`)
    return client
  }
}

serve(async () => {
  const started = Date.now()
  const errors: string[] = []
  let clientsProcessed = 0
  let postsGenerated = 0
  let blogsGenerated = 0

  const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)

  try {
    const now = new Date()
    const { data: clients, error: clientsError } = await admin.from('mkt_clients').select('*').eq('active', true).order('name')
    if (clientsError) throw new Error(`could not load active clients: ${clientsError.message}`)
    console.log(`[midnight-cron] starting run — ${clients?.length ?? 0} active client(s)`)

    for (const client of clients ?? []) {
      clientsProcessed++

      // Weekly blog — current week only. Cron runs daily, so this is a no-op
      // every day except the first day it's missing for that client.
      try {
        const title = await ensureWeeklyBlog(admin, client, sundayOfWeek(now))
        if (title) blogsGenerated++
      } catch (e) {
        const msg = `${client.name} (blog): ${String((e as Error)?.message ?? e)}`
        errors.push(msg)
        console.error(`[midnight-cron] ${msg}`)
      }

      // Every client gets its own full budget — see PER_CLIENT_POST_BUDGET
      // comment above. A per-client try/catch means one client throwing
      // (e.g. Anthropic API error) can't abort the run for everyone after it.
      try {
        const clientForGeneration = await attachCrhqScrapeIfDue(admin, client)
        const { generated, errors: fillErrors } = await fillClientGap(admin, clientForGeneration, PER_CLIENT_POST_BUDGET)
        postsGenerated += generated
        if (fillErrors.length) {
          errors.push(...fillErrors)
          for (const fe of fillErrors) console.error(`[midnight-cron] ${fe}`)
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

  console.log(`[midnight-cron] run complete — ${clientsProcessed} client(s), ${postsGenerated} post(s), ${blogsGenerated} blog(s), ${errors.length} error(s)`)

  return new Response(JSON.stringify({ ok: true, clientsProcessed, postsGenerated, blogsGenerated, errors }), {
    headers: { 'Content-Type': 'application/json' },
  })
})
