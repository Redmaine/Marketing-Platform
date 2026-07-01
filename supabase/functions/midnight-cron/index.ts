// Supabase Edge Function: midnight-cron  (Deno) — runs 00:00 daily via pg_cron
// Keeps every active client topped up with ~4 weeks of approved/scheduled
// content (weekdays only), rotates through their content pillars, and
// generates one blog post per client per week (scheduled for Sunday).
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

const MAX_POSTS_PER_RUN = 20

serve(async () => {
  const started = Date.now()
  const errors: string[] = []
  let clientsProcessed = 0
  let postsGenerated = 0
  let blogsGenerated = 0

  const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)

  try {
    const now = new Date()
    const { data: clients } = await admin.from('mkt_clients').select('*').eq('active', true).order('name')

    for (const client of clients ?? []) {
      clientsProcessed++

      // Weekly blog — current week only. Cron runs daily, so this is a no-op
      // every day except the first day it's missing for that client.
      try {
        const title = await ensureWeeklyBlog(admin, client, sundayOfWeek(now))
        if (title) blogsGenerated++
      } catch (e) {
        errors.push(`${client.name} (blog): ${String((e as Error)?.message ?? e)}`)
      }

      if (postsGenerated >= MAX_POSTS_PER_RUN) continue

      const { generated, errors: fillErrors } = await fillClientGap(admin, client, MAX_POSTS_PER_RUN - postsGenerated)
      postsGenerated += generated
      errors.push(...fillErrors)
    }
  } catch (e) {
    errors.push(`fatal: ${String((e as Error)?.message ?? e)}`)
  }

  await admin.from('mkt_cron_log').insert({
    job_name: 'midnight-content-generation',
    clients_processed: clientsProcessed,
    posts_generated: postsGenerated,
    errors: errors.length ? errors : null,
    duration_ms: Date.now() - started,
  })

  return new Response(JSON.stringify({ ok: true, clientsProcessed, postsGenerated, blogsGenerated, errors }), {
    headers: { 'Content-Type': 'application/json' },
  })
})
