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
// returns — this function does no LLM work itself, so it can never hit the
// 150s ceiling itself. Each per-client invocation gets its own fresh 150s
// budget instead of all clients sharing one. (As of 20 Aug 2026 this no
// longer returns in under a second — see STAGGER_MS below — but the total
// is still trivial against the 150s ceiling: ~7.5s for 11 clients.)
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// Root cause of the 19 Aug 503s (Once Upon A You, Quill — LinkedIn, Adrian
// Fielding — LinkedIn — confirmed via mkt_cron_log: exactly the 8 of 11
// dispatched clients that DIDN'T 503 logged a midnight-content-generation
// row that night; the 3 that did have no row at all, meaning their nightly
// fill — approval-rate refresh, weekly blog, fillClientGap — silently never
// ran). generate-client-content's own code has no path that returns a
// non-2xx status (its top-level catch always falls through to an implicit
// 200), so this was never that function rejecting a request — it's Supabase's
// own edge-function gateway rejecting some of the burst before the function
// code even started. Nothing else is scheduled at 00:00 UTC in this project
// (checked cron.job) — the burst is self-inflicted: 11 fetches fired within
// the same tick of this loop, un-staggered.
//
// Two changes address that without reintroducing the sequential-run timeout
// this dispatcher exists to avoid (11 clients even fully serialised through
// both retries and the stagger below adds at most ~30s, nowhere near the
// 150s ceiling — and none of that time is spent waiting on the receiving
// function's own real work, only on firing the next request):
//   1. STAGGER_MS between firing each client's request, so 11 requests
//      leave over several seconds instead of all in the same millisecond.
//   2. DISPATCH_MAX_ATTEMPTS with backoff on a non-2xx/network failure —
//      same retry-with-backoff shape schedule-to-metricool already uses for
//      its own transient-failure handling, applied here for consistency.
const STAGGER_MS = 750
const DISPATCH_MAX_ATTEMPTS = 3
const DISPATCH_BACKOFF_MS = [1000, 3000]

// Fires one client's dispatch, retrying a non-2xx or network failure up to
// DISPATCH_MAX_ATTEMPTS times before logging a hard failure. Every failed
// attempt is still logged (not just the final one) — a client that failed
// twice and recovered on attempt 3 is exactly the early warning of platform
// pressure that should be visible before it becomes a full outage, same
// reasoning schedule-to-metricool's retry logging already uses.
async function dispatchClientWithRetry(
  admin: Admin, targetUrl: string, serviceKey: string, client: { id: string; name: string },
): Promise<void> {
  let lastMsg = 'unknown error'
  for (let attempt = 1; attempt <= DISPATCH_MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(targetUrl, {
        method: 'POST',
        headers: { Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ client_id: client.id }),
      })
      if (res.ok) {
        if (attempt > 1) console.log(`[midnight-cron] dispatch to ${client.name} succeeded on attempt ${attempt}/${DISPATCH_MAX_ATTEMPTS}`)
        return
      }
      lastMsg = `dispatch to ${client.name} returned HTTP ${res.status} (attempt ${attempt}/${DISPATCH_MAX_ATTEMPTS})`
    } catch (e) {
      lastMsg = `dispatch to ${client.name} failed: ${String((e as Error)?.message ?? e)} (attempt ${attempt}/${DISPATCH_MAX_ATTEMPTS})`
    }
    console.error(`[midnight-cron] ${lastMsg}`)
    await logEdgeError(admin, lastMsg)
    if (attempt < DISPATCH_MAX_ATTEMPTS) await sleep(DISPATCH_BACKOFF_MS[attempt - 1])
  }
  console.error(`[midnight-cron] dispatch to ${client.name} exhausted ${DISPATCH_MAX_ATTEMPTS} attempts — giving up for tonight`)
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
    // deno-lint-ignore no-explicit-any
    const rt = (globalThis as any).EdgeRuntime
    for (let i = 0; i < (clients ?? []).length; i++) {
      const client = (clients ?? [])[i]

      // The retry-with-backoff now lives inside dispatchClientWithRetry — see
      // that function's comment for why (the 19 Aug 503s). Still not awaited
      // here: starting the request (with its own internal retries) and
      // moving on is what keeps this a fan-out. Handed to EdgeRuntime.waitUntil
      // so it survives past this function's own response the same as before.
      const promise = dispatchClientWithRetry(admin, targetUrl, SERVICE_KEY, client)

      if (rt?.waitUntil) {
        rt.waitUntil(promise)
      } else {
        // Local/dev fallback where EdgeRuntime isn't present — still don't
        // block the loop; the promise just isn't guaranteed to survive past
        // this function's own return in that environment.
        console.log(`[midnight-cron] EdgeRuntime.waitUntil unavailable — dispatched ${client.name} without background-task registration`)
      }

      dispatched.push(client.name)

      // Stagger — see the STAGGER_MS comment above. Skipped after the last
      // client so this function doesn't wait out a pointless final delay
      // before returning.
      if (i < (clients ?? []).length - 1) await sleep(STAGGER_MS)
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
