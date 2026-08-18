// Supabase Edge Function: midnight-cron  (Deno) — runs 00:00 daily via pg_cron
//
// DISPATCHER ONLY as of 8 Aug 2026. Used to run every active client's fill
// sequentially, in one invocation — approval-rate refresh, weekly blog,
// real-events context, fillClientGap, one client after another. That no
// longer happens here; see generate-client-content/index.ts, which now owns
// all of that per-client work.
//
// Why: Supabase Edge Functions have a hard 150-second platform idle timeout,
// independent of any pg_cron/pg_net setting. A full sequential run across 11
// active clients doing real Anthropic generation takes 13+ minutes at the
// observed rate — confirmed live by manually invoking the old sequential
// version with a 320s client-side timeout: it was killed by the platform
// after completing only 2 of 11 clients, having never reached its own
// logging step. mkt_cron_log had zero completed runs of this job since 9
// July as a direct result — this is also why midnight-content-generation
// never produced Quill's first LinkedIn draft even after connected_platforms
// was updated to include it (see mkt_content_schedule's Quill/linkedin row).
//
// This file now just loads active clients and fires one request per client
// at generate-client-content, registered with EdgeRuntime.waitUntil so each
// keeps running in the background after THIS function's own response
// returns — this function does no LLM work itself and returns in well under
// a second regardless of how many clients are active, so it can never hit
// the 150s ceiling itself. Each per-client invocation gets its own fresh
// 150s budget instead of all clients sharing one.
//
// Deploy:  supabase functions deploy midnight-cron
// Deploy:  supabase functions deploy generate-client-content
// Schedule: see 11_cron_jobs.sql (unchanged — same job, same 00:00 trigger).
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { checkCronAuth } from '../_shared/cronAuth.ts'

// deno-lint-ignore no-explicit-any
type Admin = any

// Same cross-function error log every other cron function already writes to
// (see daily-ops-check's edge_function_errors_window check). Added 18 Aug
// 2026 — a dispatch failure (e.g. "Your Company AI" returning HTTP 503 on
// 17 Aug) previously only reached console.error, which daily-ops-check has
// no way to read, so a real per-client dispatch failure was invisible to
// the daily report even though every other function's failures show up
// there. No separate alerting path — this reuses the existing one.
async function logEdgeError(admin: Admin, message: string) {
  const { error } = await admin.from('edge_function_errors').insert({ function_name: 'midnight-cron', error_message: message })
  if (error) console.error(`[midnight-cron] failed to write edge_function_errors: ${error.message}`)
}

serve(async (req) => {
  const auth = await checkCronAuth(req, 'midnight-cron')
  if (!auth.authorised) return auth.response!

  const started = Date.now()
  const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
  const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  const admin: Admin = createClient(SUPABASE_URL, SERVICE_KEY)

  const dispatched: string[] = []
  const dispatchErrors: string[] = []

  try {
    // Load EVERY active client, including CRHQ — generate-client-content
    // itself decides whether to skip a given client's content generation
    // (CRHQ, or a brand with no connected_platforms) and logs that skip
    // explicitly. This file has no opinion on which clients get content;
    // it dispatches all of them and lets each invocation make that call.
    const { data: clients, error: clientsError } = await admin
      .from('mkt_clients')
      .select('id, name')
      .eq('active', true)
      .order('name')
    if (clientsError) throw new Error(`could not load active clients: ${clientsError.message}`)

    const targetUrl = `${SUPABASE_URL}/functions/v1/generate-client-content`
    for (const client of clients ?? []) {
      // Not awaited in the loop — starting the fetch and moving straight to
      // the next client is what makes this a fan-out rather than another
      // sequential run under a different name. The promise is still tracked
      // (for the console log below) and handed to EdgeRuntime.waitUntil so
      // the underlying request actually completes in the background instead
      // of risking cancellation the moment this function's own response is
      // sent — an un-awaited, unregistered fetch can be torn down before it
      // ever reaches the network once the isolate thinks its work is done.
      const promise = fetch(targetUrl, {
        method: 'POST',
        headers: { Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ client_id: client.id }),
      }).then((res) => {
        if (!res.ok) {
          const msg = `dispatch to ${client.name} returned HTTP ${res.status}`
          console.error(`[midnight-cron] ${msg}`)
          logEdgeError(admin, msg)
        }
      }).catch((e) => {
        const msg = `dispatch to ${client.name} failed: ${String((e as Error)?.message ?? e)}`
        console.error(`[midnight-cron] ${msg}`)
        logEdgeError(admin, msg)
      })

      // deno-lint-ignore no-explicit-any
      const rt = (globalThis as any).EdgeRuntime
      if (rt?.waitUntil) {
        rt.waitUntil(promise)
      } else {
        // Local/dev fallback where EdgeRuntime isn't present — still don't
        // block the loop; the promise just isn't guaranteed to survive past
        // this function's own return in that environment.
        console.log(`[midnight-cron] EdgeRuntime.waitUntil unavailable — dispatched ${client.name} without background-task registration`)
      }

      dispatched.push(client.name)
    }
    console.log(`[midnight-cron] dispatched ${dispatched.length} client(s): ${dispatched.join(', ')}`)
  } catch (e) {
    const msg = `fatal: ${String((e as Error)?.message ?? e)}`
    dispatchErrors.push(msg)
    console.error(`[midnight-cron] ${msg}`)
  }

  // Lightweight dispatch-only summary — distinct job_name from the
  // per-client 'midnight-content-generation' rows generate-client-content
  // writes, so "did the dispatcher fire tonight" and "did client X's fill
  // complete" are never conflated in mkt_cron_log.
  const { error: logError } = await admin.from('mkt_cron_log').insert({
    job_name: 'midnight-cron-dispatch',
    clients_processed: dispatched.length,
    posts_generated: 0,
    errors: dispatchErrors.length ? dispatchErrors : null,
    notes: null,
    duration_ms: Date.now() - started,
  })
  if (logError) console.error(`[midnight-cron] failed to write mkt_cron_log: ${logError.message}`)

  console.log(`[midnight-cron] dispatch complete — ${dispatched.length} client(s) dispatched, ${dispatchErrors.length} error(s), ${Date.now() - started}ms`)

  return new Response(JSON.stringify({ ok: true, dispatched, errors: dispatchErrors }), {
    headers: { 'Content-Type': 'application/json' },
  })
})
