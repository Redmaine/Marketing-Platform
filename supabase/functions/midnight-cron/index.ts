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
// CRHQ (slug 'crhq') is deliberately excluded from this loop — see the query
// below. Its content goes stale within hours (geopolitics, defence), so a
// weeks-ahead bulk fill is exactly wrong for it; it gets its own 22:00
// dedicated run instead, which scrapes fresh, generates one post per
// platform, and enforces its own tight queue cap — see
// crhq-nightly-content/index.ts and 56_crhq_nightly_pipeline.sql.
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

serve(async () => {
  const started = Date.now()
  const errors: string[] = []
  let clientsProcessed = 0
  let postsGenerated = 0
  let blogsGenerated = 0

  const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)

  try {
    const now = new Date()
    // .neq('slug', 'crhq') — see the file header. CRHQ is generated only by
    // crhq-nightly-content's dedicated 22:00 run, never here.
    const { data: clients, error: clientsError } = await admin.from('mkt_clients').select('*').eq('active', true).neq('slug', 'crhq').order('name')
    if (clientsError) throw new Error(`could not load active clients: ${clientsError.message}`)
    console.log(`[midnight-cron] starting run — ${clients?.length ?? 0} active client(s) (CRHQ excluded)`)

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
        const { generated, errors: fillErrors } = await fillClientGap(admin, client, PER_CLIENT_POST_BUDGET)
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
