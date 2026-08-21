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
//   2. DISPATCH_MAX_ATTEMPTS with backoff on a TRANSIENT failure —
//      same retry-with-backoff shape schedule-to-metricool already uses for
//      its own transient-failure handling, applied here for consistency.
//      "Transient" is RETRYABLE_STATUSES below, the same set
//      _shared/generate.ts already uses; a 4xx that means this caller is
//      wrong (400, 401, 404) fails immediately instead.
//   3. A 'midnight-cron-dispatch-outcome' mkt_cron_log row written once all
//      dispatches settle, so a retry that recovered and a retry that gave up
//      are both queryable afterwards — see logDispatchOutcome.
const STAGGER_MS = 750
const DISPATCH_MAX_ATTEMPTS = 3
const DISPATCH_BACKOFF_MS = [1000, 3000]

// Which HTTP statuses are worth a second go. Deliberately the SAME set
// _shared/generate.ts already uses for Anthropic (see its comment: "A 400
// (e.g. 'credit balance too low') or 401 is terminal and NOT retried —
// retrying those just wastes time and hides the real, actionable error"), so
// this project has one definition of "transient", not two.
//
// Tightened 21 Aug 2026. The first version of this retry (20 Aug) retried
// EVERY non-2xx, which is wrong here specifically, not just in principle:
// generate-client-content is fronted by checkCronAuth, which answers 401 on a
// credentials mismatch — and this project has already had exactly that
// failure, systemically, across every cron function at once (see commit
// f2b5305, the stale-JWT cron auth regression: Supabase changed the
// service_role key's representation underneath hardcoded copies). Under the
// old "retry anything" rule that outage would have had all 11 clients each
// burn 3 attempts and 4s of backoff, then write 33 near-identical rows into
// edge_function_errors — burying the one actionable fact (the key is wrong)
// under noise, in the very table daily-ops-check reads to tell Adrian what
// broke. A terminal status now fails once, immediately, and says so.
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 529])

export type DispatchResult = {
  client: string
  ok: boolean
  attempts: number
  lastError?: string
  // True when we stopped because the status was not worth retrying, as
  // opposed to having spent every attempt. The distinction matters to whoever
  // reads the log: "gave up after 3 transient failures" is a platform
  // problem, "refused to retry a 400" is a bug in this caller.
  terminal?: boolean
}

// Fires one client's dispatch, retrying a transient (RETRYABLE_STATUSES or
// network-level) failure up to DISPATCH_MAX_ATTEMPTS times before reporting a
// hard failure. Every failed attempt is logged individually, not just the
// final one — a client that failed twice and recovered on attempt 3 is
// exactly the early warning of platform pressure that should be visible
// before it becomes a full outage, same reasoning schedule-to-metricool's
// retry logging already uses.
//
// Deliberately NO per-attempt AbortController timeout, unlike
// schedule-to-metricool's callMetricoolWithRetry. That difference is load-
// bearing: this fetch stays open for the whole of generate-client-content's
// real work (14.8s for the slowest client on the 21 Aug run), so any timeout
// short enough to be useful would abort SUCCESSFUL generations. Worse,
// aborting the request does not stop the receiving function — it carries on
// server-side — so the retry would run a second, concurrent generation for
// that client and duplicate its content. A hung dispatch is instead bounded
// by the platform's own function budget, which is the lesser failure.
//
// Exported so the retry/backoff/classification behaviour is exercisable
// directly, rather than only provable by firing 11 real Anthropic
// generations at real client accounts.
export async function dispatchClientWithRetry(
  admin: Admin, targetUrl: string, serviceKey: string, client: { id: string; name: string },
): Promise<DispatchResult> {
  let lastMsg = 'unknown error'
  for (let attempt = 1; attempt <= DISPATCH_MAX_ATTEMPTS; attempt++) {
    let terminal = false
    try {
      const res = await fetch(targetUrl, {
        method: 'POST',
        headers: { Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ client_id: client.id }),
      })
      if (res.ok) {
        if (attempt > 1) console.log(`[midnight-cron] dispatch to ${client.name} succeeded on attempt ${attempt}/${DISPATCH_MAX_ATTEMPTS}`)
        return { client: client.name, ok: true, attempts: attempt }
      }
      terminal = !RETRYABLE_STATUSES.has(res.status)
      lastMsg = `dispatch to ${client.name} returned HTTP ${res.status}`
        + (terminal
          ? ` — not a transient status, not retried (attempt ${attempt}/${DISPATCH_MAX_ATTEMPTS})`
          : ` (attempt ${attempt}/${DISPATCH_MAX_ATTEMPTS})`)
    } catch (e) {
      // Network-level failure — transient by definition, same as
      // _shared/generate.ts treats it.
      lastMsg = `dispatch to ${client.name} failed: ${String((e as Error)?.message ?? e)} (attempt ${attempt}/${DISPATCH_MAX_ATTEMPTS})`
    }
    console.error(`[midnight-cron] ${lastMsg}`)
    await logEdgeError(admin, lastMsg)

    if (terminal) return { client: client.name, ok: false, attempts: attempt, lastError: lastMsg, terminal: true }
    if (attempt < DISPATCH_MAX_ATTEMPTS) await sleep(DISPATCH_BACKOFF_MS[attempt - 1])
  }
  const giveUp = `dispatch to ${client.name} exhausted ${DISPATCH_MAX_ATTEMPTS} attempts — giving up for tonight; this client's nightly fill did NOT run`
  console.error(`[midnight-cron] ${giveUp}`)
  // The individual attempts are already logged above, but the verdict was
  // previously console-only — so edge_function_errors showed failures with no
  // way to tell whether they were ever resolved. The give-up line is the
  // durable answer to "and did it eventually succeed".
  await logEdgeError(admin, giveUp)
  return { client: client.name, ok: false, attempts: DISPATCH_MAX_ATTEMPTS, lastError: lastMsg, terminal: false }
}

// Writes the second, later mkt_cron_log row: what each dispatch actually
// ENDED UP doing, once every one of them has settled.
//
// A separate row rather than a field on the existing one, because the two
// answer different questions at different times. The original
// 'midnight-cron-dispatch' row is written the moment the fan-out is fired and
// says "the dispatcher woke up and fired N requests" — its errors column
// structurally CANNOT contain a dispatch failure, because the dispatches are
// deliberately not awaited before it is written. That is not theoretical: the
// real 19 Aug row says clients_processed=11, errors=null, on the exact night
// three clients hard-503'd and never generated anything. The durable summary
// contradicted the durable error log.
//
// This row closes that gap. It costs no extra wall-clock: each dispatch
// promise is already registered with waitUntil and already stays alive until
// generate-client-content returns, so awaiting them adds nothing to the
// envelope this function was already keeping open. If the platform kills the
// instance before this lands, the original row and the per-attempt
// edge_function_errors rows still exist — this is additive, never the only
// record.
async function logDispatchOutcome(admin: Admin, results: DispatchResult[], started: number) {
  const retried = results.filter((r) => r.ok && r.attempts > 1)
  const failed = results.filter((r) => !r.ok)

  const notes = [
    `${results.filter((r) => r.ok).length}/${results.length} client(s) dispatched successfully`,
    ...retried.map((r) => `${r.client}: recovered on attempt ${r.attempts}/${DISPATCH_MAX_ATTEMPTS} after a transient failure`),
  ]
  const errors = failed.map((r) =>
    r.terminal
      ? `${r.client}: terminal failure, not retried — ${r.lastError}`
      : `${r.client}: failed after ${r.attempts}/${DISPATCH_MAX_ATTEMPTS} attempts — ${r.lastError}`
  )

  const { error } = await admin.from('mkt_cron_log').insert({
    job_name: 'midnight-cron-dispatch-outcome',
    clients_processed: results.filter((r) => r.ok).length,
    posts_generated: 0,
    errors: errors.length ? errors : null,
    notes,
    duration_ms: Date.now() - started,
  })
  if (error) console.error(`[midnight-cron] failed to write dispatch-outcome mkt_cron_log row: ${error.message}`)
  else console.log(`[midnight-cron] dispatch outcome recorded — ${notes.join(' | ')}${errors.length ? ` | errors: ${errors.join(' | ')}` : ''}`)
}

// The fan-out itself: fire one dispatch per client, spaced by STAGGER_MS,
// none of them awaited, then register a background task that records what
// they all ended up doing.
//
// Lifted out of serve() (21 Aug 2026) purely so it is exercisable end-to-end
// against a controlled endpoint — the previous version of this retry was only
// ever proven against a mocked fetch, never against a real HTTP 503 in the
// real edge runtime, and "the mock says it retries" is not evidence that it
// does. Same reasoning that made schedule-to-metricool export
// callMetricoolWithRetry. Returns the names dispatched, in order.
export async function dispatchAllClients(
  admin: Admin, targetUrl: string, serviceKey: string,
  clients: { id: string; name: string }[], started: number,
): Promise<string[]> {
  const dispatched: string[] = []
  // deno-lint-ignore no-explicit-any
  const rt = (globalThis as any).EdgeRuntime
  const inFlight: Promise<DispatchResult>[] = []

  for (let i = 0; i < clients.length; i++) {
    const client = clients[i]

    // The retry-with-backoff lives inside dispatchClientWithRetry — see that
    // function's comment for why (the 19 Aug 503s). Still not awaited here:
    // starting the request (with its own internal retries) and moving on is
    // what keeps this a fan-out. Each client's retries therefore run
    // concurrently with every other client's, so the retries cost the run at
    // most ONE client's backoff (4s), not 11 clients' worth serialised, and
    // the STAGGER_MS spacing below is untouched by them — the burst d1c2137
    // fixed is not reintroduced, and nothing here scales the run toward the
    // 150s ceiling.
    const promise = dispatchClientWithRetry(admin, targetUrl, serviceKey, client)
    inFlight.push(promise)

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
    if (i < clients.length - 1) await sleep(STAGGER_MS)
  }
  console.log(`[midnight-cron] dispatched ${dispatched.length} client(s): ${dispatched.join(', ')}`)

  // Not awaited — see logDispatchOutcome's comment. Registered as its own
  // background task so this function's response, and the fired-the-fan-out
  // mkt_cron_log row, are not held up by the slowest client.
  const outcome = Promise.allSettled(inFlight).then((settled) =>
    logDispatchOutcome(
      admin,
      settled.map((s, i) =>
        s.status === 'fulfilled'
          ? s.value
          : { client: dispatched[i] ?? 'unknown', ok: false, attempts: 0, lastError: `dispatch task threw: ${String(s.reason)}`, terminal: true },
      ),
      started,
    )
  )
  if (rt?.waitUntil) rt.waitUntil(outcome)
  else await outcome

  return dispatched
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
    dispatched.push(...await dispatchAllClients(admin, targetUrl, SERVICE_KEY, clients ?? [], started))
  } catch (e) {
    const msg = `fatal: ${String((e as Error)?.message ?? e)}`
    dispatchErrors.push(msg)
    console.error(`[midnight-cron] ${msg}`)
  }

  // Lightweight dispatch-only summary — distinct job_name from the
  // per-client 'midnight-content-generation' rows generate-client-content
  // writes, so "did the dispatcher fire tonight" and "did client X's fill
  // complete" are never conflated in mkt_cron_log.
  //
  // This row means "the fan-out was FIRED", never "the fan-out SUCCEEDED":
  // clients_processed is how many requests were started and its errors column
  // only ever carries a fatal error from the loading step above, because the
  // dispatches are deliberately not awaited before this runs. The
  // 'midnight-cron-dispatch-outcome' row written later by logDispatchOutcome
  // is the one that answers "and did they land".
  const { error: logError } = await admin.from('mkt_cron_log').insert({
    job_name: 'midnight-cron-dispatch',
    clients_processed: dispatched.length,
    posts_generated: 0,
    errors: dispatchErrors.length ? dispatchErrors : null,
    notes: ['dispatch fired; per-client outcome recorded separately as midnight-cron-dispatch-outcome'],
    duration_ms: Date.now() - started,
  })
  if (logError) console.error(`[midnight-cron] failed to write mkt_cron_log: ${logError.message}`)

  console.log(`[midnight-cron] dispatch complete — ${dispatched.length} client(s) dispatched, ${dispatchErrors.length} error(s), ${Date.now() - started}ms`)

  return new Response(JSON.stringify({ ok: true, dispatched, errors: dispatchErrors }), {
    headers: { 'Content-Type': 'application/json' },
  })
})
