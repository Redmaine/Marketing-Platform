// Supabase Edge Function: move-missed-posts  (Deno) — runs 23:30 UTC daily via
// pg_cron (migration 105), half an hour BEFORE midnight-content-generation so
// a moved post takes the earliest open slot before fresh generation fills it.
//
// Moves every post whose slot passed without publishing to the next open
// slot for its brand/platform — see _shared/missedSlots.ts for the ground
// truth used, the rules, and why CRHQ is handed to its own recycler instead.
//
// Body { dryRun: true } decides and reports without writing.
// Deploy: supabase functions deploy move-missed-posts
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { checkCronAuth } from '../_shared/cronAuth.ts'
import { moveMissedPosts } from '../_shared/missedSlots.ts'

serve(async (req) => {
  const auth = await checkCronAuth(req, 'move-missed-posts')
  if (!auth.authorised) return auth.response!
  const started = Date.now()
  const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
  const b = await req.json().catch(() => ({}))
  const dryRun = b?.dryRun === true

  const out = await moveMissedPosts(admin, { dryRun })
  const summary = `${out.moved.length} moved, ${out.verifiedPublished} verified published, ${out.handedToCrhqRecycler.length} handed to CRHQ recycling, ${out.flagged.length} flagged for a human, ${out.errors.length} error(s)${dryRun ? ' (dry run)' : ''}`
  console.log(`[move-missed-posts] ${summary}`)

  if (!dryRun) {
    const { error: logError } = await admin.from('mkt_cron_log').insert({
      job_name: 'move-missed-posts', clients_processed: new Set(out.moved.map((m) => m.brand)).size, posts_generated: 0,
      errors: out.errors.length ? out.errors : null,
      notes: [summary, ...out.moved.map((m) => `${m.brand} ${m.platform}: ${m.id} ${m.from} → ${m.to} (${m.verdict})`), ...out.notes],
      duration_ms: Date.now() - started,
    })
    if (logError) console.error(`[move-missed-posts] failed to write mkt_cron_log: ${logError.message}`)
    if (out.errors.length || out.flagged.length) {
      await admin.from('edge_function_errors').insert({
        function_name: 'move-missed-posts',
        error_message: [...out.errors, ...out.flagged.map((f) => `NEEDS A DECISION: ${f.brand} ${f.platform} ${f.id} — ${f.why}`)].join('\n').slice(0, 4000),
      })
    }
  }
  return new Response(JSON.stringify({ ok: true, dryRun, summary, ...out }), { headers: { 'Content-Type': 'application/json' } })
})
