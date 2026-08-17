// Supabase Edge Function: sweep-stuck-metricool-posts  (Deno) — runs every
// 30 minutes via pg_cron.
//
// Catches what schedule-to-metricool's own inline retry (3 attempts, ~82s
// worst case) can't: a failure that outlasts a few seconds of backoff — a
// genuine Metricool outage, not a one-off blip. Built alongside that retry
// hardening (17 Aug 2026 incident: a failed schedule call left a post at
// status='approved'/metricool_post_id=null with zero trace anywhere until a
// human noticed a dashboard count and clicked retry by hand).
//
// Finds every mkt_content_queue row still stuck in that exact state —
// approved, no Metricool post id — long enough after its own approval that
// the inline retry has certainly already run and given up, then re-invokes
// schedule-to-metricool for each one. Deliberately does NOT duplicate any of
// the scheduling logic: it calls the real function, with the SAME retry,
// timeout and per-attempt logging that a human clicking "Approve" gets, so
// there is exactly one place that logic lives.
//
// Auth: this function is itself cronAuth-gated (like cron-healthcheck,
// daily-ops-check etc) — verify_jwt stays on at the Supabase gateway level,
// satisfied by the real anon-key apikey/Authorization pair that
// private.cron_request_headers() always sends alongside x-cron-secret;
// checkCronAuth below is the independent, code-level check on top of that.
//
// Auth for the re-invocation of schedule-to-metricool is this function's own
// SUPABASE_SERVICE_ROLE_KEY as a bearer token — its cronAuth fallback accepts
// that directly (see its own auth block), so no extra secret is needed here.
//
// Deploy: supabase functions deploy sweep-stuck-metricool-posts
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { checkCronAuth } from '../_shared/cronAuth.ts'

// deno-lint-ignore no-explicit-any
type Admin = any

// A post approved less than this long ago is left alone — schedule-to-metricool's
// own inline retry (up to ~82s worst case) is still the right thing to be
// relying on for anything that recent, and sweeping it too would just be racing
// that inline retry rather than catching something it couldn't. 20 minutes
// gives a wide, deliberate margin past that ~82s, so a row this sweep touches
// really has been abandoned, not merely mid-attempt.
const STALE_AFTER_MINUTES = 20

// Bounds one sweep's worst-case run time (each re-invocation can itself take
// up to ~82s if it fails all 3 of ITS OWN attempts) and caps how much of any
// single tick's cost lands on one run. A backlog larger than this is chipped
// away over successive 30-minute ticks rather than trying to clear it all in
// one pass — and is itself worth knowing about, see the log line below.
const MAX_PER_SWEEP = 20

async function logEdgeError(admin: Admin, message: string) {
  const { error } = await admin.from('edge_function_errors').insert({ function_name: 'sweep-stuck-metricool-posts', error_message: message })
  if (error) console.error('[sweep-stuck-metricool-posts] Failed to write edge_function_errors:', error.message)
}

serve(async (req) => {
  const auth = await checkCronAuth(req, 'sweep-stuck-metricool-posts')
  if (!auth.authorised) return auth.response!

  const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
  const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  const admin: Admin = createClient(SUPABASE_URL, SERVICE_KEY)

  const cutoff = new Date(Date.now() - STALE_AFTER_MINUTES * 60_000).toISOString()

  const { data: stuck, error: selErr } = await admin
    .from('mkt_content_queue')
    .select('id, client_id, platform, approved_at, client:mkt_clients(name)')
    .eq('status', 'approved')
    .is('metricool_post_id', null)
    .lt('approved_at', cutoff)
    .order('approved_at', { ascending: true })
    .limit(MAX_PER_SWEEP)

  if (selErr) {
    const msg = `Could not query for stuck posts: ${selErr.message}`
    console.error(`[sweep-stuck-metricool-posts] ${msg}`)
    await logEdgeError(admin, msg)
    return new Response(JSON.stringify({ ok: false, error: msg }), { status: 500, headers: { 'Content-Type': 'application/json' } })
  }

  const rows = stuck ?? []
  if (!rows.length) {
    console.log('[sweep-stuck-metricool-posts] nothing stuck — clean sweep')
    return new Response(JSON.stringify({ ok: true, found: 0, resolved: 0, stillStuck: 0 }), { headers: { 'Content-Type': 'application/json' } })
  }

  console.log(`[sweep-stuck-metricool-posts] ${rows.length} post(s) stuck at approved/no-metricool-id for >${STALE_AFTER_MINUTES}m — re-attempting each`)

  let resolved = 0
  const stillStuck: string[] = []
  for (const row of rows) {
    try {
      const res = await fetch(`${SUPABASE_URL}/functions/v1/schedule-to-metricool`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${SERVICE_KEY}`, apikey: SERVICE_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ content_queue_id: row.id }),
      })
      // schedule-to-metricool logs its own per-attempt failures and its own
      // "gave up" line to edge_function_errors already — this sweep does not
      // repeat that detail, only tallies the outcome so it can report a
      // one-line summary rather than staying silent about the backlog.
      if (res.ok) resolved += 1
      else stillStuck.push(`${row.id} (${row.client?.name ?? row.client_id}, ${row.platform}) — HTTP ${res.status}`)
    } catch (e) {
      stillStuck.push(`${row.id} (${row.client?.name ?? row.client_id}, ${row.platform}) — ${String((e as Error)?.message ?? e)}`)
    }
  }

  const summary = `${rows.length} stuck post(s) found, ${resolved} resolved, ${stillStuck.length} still stuck after re-attempt` +
    (rows.length === MAX_PER_SWEEP ? ` (hit the ${MAX_PER_SWEEP}-per-sweep cap — there may be more; next tick will pick them up)` : '')
  console.log(`[sweep-stuck-metricool-posts] ${summary}`)

  // Only logged as an incident when something is STILL stuck after this
  // sweep's own re-attempt — a post that resolved on this pass is exactly the
  // sweep doing its job, not something Adrian needs a notification about.
  if (stillStuck.length) {
    await logEdgeError(admin, `${summary}:\n${stillStuck.join('\n')}`.slice(0, 4000))
  }

  return new Response(JSON.stringify({ ok: true, found: rows.length, resolved, stillStuck: stillStuck.length }), {
    headers: { 'Content-Type': 'application/json' },
  })
})
