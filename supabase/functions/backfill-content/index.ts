// Supabase Edge Function: backfill-content  (Deno)
// One-off manual trigger: fills the full 4-week social post window and the
// next 4 weekly blogs for every active client, immediately. Uses the same
// generation logic as midnight-cron (shared fillClientGap / ensureWeeklyBlog)
// so output is identical in style — this just runs the whole gap at once
// instead of a daily top-up.
//
// Deploy:  supabase functions deploy backfill-content --no-verify-jwt
// (Deployed with JWT verification off so it can be triggered directly by a
// single curl/manual call — protected instead by a service-role bearer check
// below, since it burns real Anthropic credits per invocation.)
// Secrets (vault): ANTHROPIC_API_KEY.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { cors, json } from '../_shared/cors.ts'
import { addDays, sundayOfWeek } from '../_shared/generate.ts'
import { ensureWeeklyBlog } from '../_shared/blog.ts'
import { fillClientGap } from '../_shared/fill.ts'

const WEEKS_OF_BLOGS = 4
const DEFAULT_WINDOW_DAYS = 28
const PER_CLIENT_POST_BUDGET = 40 // fillClientGap self-limits to each client's own posting-frequency target anyway

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })

  const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  const bearer = (req.headers.get('Authorization') ?? '').replace('Bearer ', '')
  if (bearer !== SERVICE_ROLE_KEY) return json({ error: 'Not authorised' }, 401)

  // Optional override — defaults to the normal 4-week backfill window.
  // Used for one-off shorter fills (e.g. a fresh 2-week restart) without
  // changing the default behaviour of this endpoint.
  let windowDays = DEFAULT_WINDOW_DAYS
  // Optional — scope the run to a single client (e.g. { "client_slug":
  // "quill" }) instead of every active client. Added for exactly the case
  // that motivated it: a manual one-off top-up for one brand shouldn't have
  // to re-walk every other brand's own backlog first. Omitted entirely,
  // behaviour is unchanged (every active client, as before).
  let clientSlug: string | null = null
  try {
    const body = await req.json()
    if (body?.window_days) windowDays = Number(body.window_days) || DEFAULT_WINDOW_DAYS
    if (body?.client_slug) clientSlug = String(body.client_slug)
  } catch { /* no body sent — use default */ }

  const started = Date.now()
  const errors: string[] = []
  const notes: string[] = []
  let clientsProcessed = 0
  let postsGenerated = 0
  let blogsGenerated = 0

  const admin = createClient(Deno.env.get('SUPABASE_URL')!, SERVICE_ROLE_KEY)

  try {
    const now = new Date()
    let clientsQuery = admin.from('mkt_clients').select('*').eq('active', true).order('name')
    if (clientSlug) clientsQuery = clientsQuery.eq('slug', clientSlug)
    const { data: clients } = await clientsQuery

    for (const client of clients ?? []) {
      clientsProcessed++

      // Next 4 Sundays of blogs.
      let sunday = sundayOfWeek(now)
      for (let w = 0; w < WEEKS_OF_BLOGS; w++) {
        try {
          const title = await ensureWeeklyBlog(admin, client, sunday)
          if (title) blogsGenerated++
        } catch (e) {
          errors.push(`${client.name} (blog wk${w + 1}): ${String((e as Error)?.message ?? e)}`)
        }
        sunday = addDays(sunday, 7)
      }

      // Full social post gap across the requested window.
      const { generated, errors: fillErrors, notes: fillNotes } = await fillClientGap(admin, client, PER_CLIENT_POST_BUDGET, windowDays)
      postsGenerated += generated
      errors.push(...fillErrors)
      // needs_attention flags land here now, not in errors (31 Aug 2026 fix
      // — see fill.ts) — captured so they stay visible in this function's
      // own response/log instead of silently disappearing now that they no
      // longer ride along inside `errors`.
      notes.push(...fillNotes)
    }
  } catch (e) {
    errors.push(`fatal: ${String((e as Error)?.message ?? e)}`)
  }

  await admin.from('mkt_cron_log').insert({
    job_name: 'backfill-content',
    clients_processed: clientsProcessed,
    posts_generated: postsGenerated,
    errors: errors.length ? errors : null,
    notes: notes.length ? notes : null,
    duration_ms: Date.now() - started,
  })

  return json({ ok: true, clientsProcessed, postsGenerated, blogsGenerated, errors, notes })
})
