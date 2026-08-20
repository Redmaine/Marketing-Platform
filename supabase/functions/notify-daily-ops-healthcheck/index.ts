// Supabase Edge Function: notify-daily-ops-healthcheck  (Deno) — runs daily
// via pg_cron, 15 minutes after notify-daily-ops's own 10:35 UTC run.
//
// Added 20 Aug 2026. Real 14-day evidence found notify-daily-ops had
// already failed silently on 2 of its first 7 real production days (see
// that function's own header) and, until that same investigation, wrote
// nothing anywhere a next-day report could even catch it — the earlier fix
// (logging its own failures to edge_function_errors) only surfaces a
// repeat in TOMORROW's report. This function is the same-day catch: it
// checks whether notify-daily-ops actually completed and sent today, and
// alerts immediately via Resend if not.
//
// Deliberately does NOT call notify-daily-ops or daily-ops-check, and does
// NOT read edge_function_errors as its only signal — either of those would
// make this monitor depend, directly or via daily-ops-check's own read of
// edge_function_errors, on the exact function it exists to catch failing.
// The only thing this checks is: does mkt_cron_log have a
// job_name='notify-daily-ops' row from TODAY (UTC)? notify-daily-ops writes
// that row itself, immediately after a successful Resend send (see its own
// file). No row today means no email went out today, full stop — matches
// exactly the same shape already proven working for outreach-platform's
// gmail-health-check (checks a real signal, alerts via a channel
// independent of what it's checking, self-logs every run).
//
// The alert path is a direct Resend API call from THIS function's own
// RESEND_API_KEY access — not a call to notify-daily-ops, not a shared
// helper either function imports, so a notify-daily-ops outage (code bug,
// crash before logging, Resend itself down) cannot also take out its own
// alert.
//
// Manual fire-drill: POST { force_failure: true } (still requires normal
// cron auth) to exercise the full failure + alert path on demand.
//
// Deploy: supabase functions deploy notify-daily-ops-healthcheck
// Schedule: 50 10 * * * (15 min after notify-daily-ops's 10:35 UTC run)
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { checkCronAuth } from '../_shared/cronAuth.ts'

// deno-lint-ignore no-explicit-any
type Admin = any

const ALERT_TO = 'adrianfielding@me.com'

async function sendAlert(resendKey: string, detail: string): Promise<string | null> {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: 'Daily Ops Check <hello@yourcompanyai.co.uk>',
      to: ALERT_TO,
      subject: '🔴 Daily Ops email did not send today',
      html: `<div style="font-family:Arial,sans-serif;max-width:600px;color:#1C1C2E">
        <h2 style="color:#C0392B">🔴 notify-daily-ops didn't complete today</h2>
        <p>${detail}</p>
        <p style="font-size:13px;color:#6b7280">This alert comes from notify-daily-ops-healthcheck, a separate check —
        it does not depend on notify-daily-ops itself, so it still fires even if that function is completely broken.</p>
      </div>`,
    }),
  })
  if (!res.ok) {
    console.error(`[notify-daily-ops-healthcheck] alert send failed (${res.status}): ${(await res.text()).slice(0, 300)}`)
    return null
  }
  const body = await res.json().catch(() => ({}))
  return body.id ?? null
}

serve(async (req) => {
  const auth = await checkCronAuth(req, 'notify-daily-ops-healthcheck')
  if (!auth.authorised) return auth.response!

  let body: { force_failure?: boolean } = {}
  try { body = await req.json() } catch { /* real scheduled call sends no body */ }

  const admin: Admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
  const todayUtc = new Date().toISOString().slice(0, 10)
  const windowStart = `${todayUtc}T00:00:00.000Z`

  let ranToday = false
  let lastRunAt: string | null = null

  if (body.force_failure) {
    // Fire-drill — skip the real check, pretend nothing ran today, so the
    // alert path can be proven live without waiting for a genuine outage.
    ranToday = false
  } else {
    const { data, error } = await admin
      .from('mkt_cron_log')
      .select('created_at')
      .eq('job_name', 'notify-daily-ops')
      .gte('created_at', windowStart)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (error) {
      console.error(`[notify-daily-ops-healthcheck] mkt_cron_log lookup failed: ${error.message}`)
      // A lookup failure isn't proof notify-daily-ops didn't run — don't
      // alert on this check's own error, same reasoning cron-healthcheck
      // uses for its per-job lookup failures.
      return new Response(JSON.stringify({ ok: false, error: error.message }), { status: 500, headers: { 'Content-Type': 'application/json' } })
    }
    ranToday = !!data
    lastRunAt = data?.created_at ?? null
  }

  let alertSent = false
  let resendId: string | null = null

  if (!ranToday) {
    const resendKey = Deno.env.get('RESEND_API_KEY')
    const detail = body.force_failure
      ? `Forced failure — manual fire-drill test, not a real outage. Ran at ${new Date().toISOString()}.`
      : `No mkt_cron_log row for notify-daily-ops since ${windowStart}. The report either crashed before logging, or never fired at all today.`
    if (!resendKey) {
      console.error('[notify-daily-ops-healthcheck] RESEND_API_KEY not configured — cannot send alert')
    } else {
      resendId = await sendAlert(resendKey, detail)
      alertSent = !!resendId
    }
  }

  const { error: logError } = await admin.from('mkt_cron_log').insert({
    job_name: 'notify-daily-ops-healthcheck',
    clients_processed: 0,
    posts_generated: 0,
    errors: ranToday ? null : ['notify-daily-ops did not log a run today'],
    notes: [`ran_today=${ranToday} alert_sent=${alertSent}${lastRunAt ? ` last_run_at=${lastRunAt}` : ''}`],
  })
  if (logError) console.error(`[notify-daily-ops-healthcheck] failed to write its own mkt_cron_log row: ${logError.message}`)

  return new Response(JSON.stringify({ ok: true, ran_today: ranToday, last_run_at: lastRunAt, alert_sent: alertSent, resend_id: resendId }), {
    headers: { 'Content-Type': 'application/json' },
  })
})
