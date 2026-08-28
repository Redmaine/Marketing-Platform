// Supabase Edge Function: pgrst-recovery-watch  (Deno)
//
// Watches for the END of the PGRST303 outage and emails Adrian the moment it
// clears — once, not every run.
//
// Context: since 2026-08-26 15:29 UTC, PostgREST has rejected every
// service-role request with PGRST303 ("JWT issued at future"). Confirmed on
// 28 Aug as a platform-wide Supabase incident (status.supabase.com,
// "Increased response times for requests", identified 01:38 UTC, rollback in
// progress) rather than anything in this project. The whole content pipeline
// is down behind it, so knowing the minute it recovers is worth a probe every
// five minutes.
//
// HOW IT DECIDES: it does not test itself. It issues the exact request that
// is currently failing — a service-role read against /rest/v1 — and reports
// on that. A pass means the real pipeline can run again.
//
// WHY THE STATE TABLE: the alert must fire once per incident, not every five
// minutes for the rest of time. The flag is written through PostgREST on
// purpose — at the moment of recovery PostgREST is by definition working, so
// the write and the probe succeed or fail together and cannot disagree.
//
// Deploy:  supabase functions deploy pgrst-recovery-watch --no-verify-jwt
// Schedule: every 5 minutes (see migration 104).
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { checkCronAuth } from '../_shared/cronAuth.ts'
import { formatUkDateTime } from '../_shared/ukTime.ts'

const FROM = 'Your Company AI <hello@yourcompanyai.co.uk>'
const RECIPIENT = 'adrianfielding@me.com'
// First observed PGRST303 failure, from the send-digest incident note.
const OUTAGE_STARTED = '2026-08-26T15:29:15Z'

serve(async (req) => {
  const json = (b: unknown, s = 200) =>
    new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json' } })

  const auth = await checkCronAuth(req, 'pgrst-recovery-watch')
  if (!auth.authorised) return auth.response!

  const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
  const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)

  // THE PROBE — the exact shape of request that is currently failing.
  const { error: probeError } = await admin.from('mkt_clients').select('id').limit(1)

  if (probeError) {
    // Still broken. Deliberately silent: a five-minute alarm that fires for
    // two days is noise, and the whole point of this function is that the
    // ONE message it sends is worth reading.
    console.log(`[pgrst-recovery-watch] still failing: ${probeError.message}`)
    return json({ ok: true, recovered: false, error: probeError.message })
  }

  // Recovered. Has this incident already been announced?
  const { data: existing, error: checkError } = await admin
    .from('pgrst_recovery_watch')
    .select('id, detected_at')
    .gte('detected_at', new Date(Date.now() - 24 * 3600_000).toISOString())
    .limit(1)

  if (checkError) {
    console.error(`[pgrst-recovery-watch] recovered, but the already-notified check failed: ${checkError.message}`)
    return json({ ok: false, recovered: true, notified: false, error: checkError.message }, 500)
  }
  if (existing?.length) {
    console.log('[pgrst-recovery-watch] recovered, already announced within the last 24h — staying quiet')
    return json({ ok: true, recovered: true, notified: false, reason: 'already announced' })
  }

  const now = new Date()
  const outageMs = now.getTime() - new Date(OUTAGE_STARTED).getTime()
  const outageHours = Math.round(outageMs / 3600_000)

  // Claim the announcement BEFORE emailing. If the email then fails we have
  // a recorded recovery and no alert, which is recoverable by looking at the
  // table; emailing first and failing to record would re-alert every five
  // minutes, which is not.
  const { error: insertError } = await admin
    .from('pgrst_recovery_watch')
    .insert({ note: `PostgREST service-role access recovered after ~${outageHours}h` })
  if (insertError) {
    console.error(`[pgrst-recovery-watch] could not record the recovery, not emailing to avoid an alert loop: ${insertError.message}`)
    return json({ ok: false, recovered: true, notified: false, error: insertError.message }, 500)
  }

  const resendKey = Deno.env.get('RESEND_API_KEY')
  let emailed = false
  if (!resendKey) {
    console.error('[pgrst-recovery-watch] RESEND_API_KEY not set — recovery recorded but not emailed')
  } else {
    const html =
      `<div style="font-family:Arial,sans-serif;color:#1C2B3A;max-width:560px">` +
      `<h2 style="color:#166534;margin:0 0 4px">Supabase PostgREST is back</h2>` +
      `<p style="color:#8FA3B1;margin:0 0 16px">${formatUkDateTime(now)}</p>` +
      `<p style="font-size:14px;margin:0 0 12px">A service-role read against <code>/rest/v1</code> just succeeded for the first time since <strong>26 Aug 15:29 UTC</strong> — roughly <strong>${outageHours} hours</strong>.</p>` +
      `<p style="font-size:14px;margin:0 0 12px">This was the platform-wide Supabase incident (status.supabase.com, identified 01:38 UTC 28 Aug), so the rollback has most likely landed.</p>` +
      `<p style="font-size:14px;margin:0 0 6px"><strong>Worth checking now:</strong></p>` +
      `<ul style="font-size:14px;margin:0 0 16px;padding-left:18px">` +
      `<li>Tonight's 00:00 content generation should run normally — 11 clients, nothing generated since 26 Aug.</li>` +
      `<li>send-digest will silently stop using its direct-Postgres fallback (check <code>data_source</code> in its response).</li>` +
      `<li>The outreach platform's Quill enrichment can now be verified — it was blocked on this plus an invalid ANTHROPIC_API_KEY.</li>` +
      `</ul>` +
      `<p><a href="${'https://ops.yourcompanyai.co.uk'}" style="background:#E8410A;color:#fff;text-decoration:none;padding:10px 18px;border-radius:8px;font-weight:700">Open the platform</a></p></div>`
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: FROM, to: RECIPIENT, subject: `Supabase PostgREST recovered after ~${outageHours}h`, html }),
    })
    emailed = r.ok
    if (!r.ok) console.error(`[pgrst-recovery-watch] Resend rejected the alert: ${await r.text()}`)
  }

  console.log(`[pgrst-recovery-watch] RECOVERED after ~${outageHours}h — alert emailed: ${emailed}`)
  return json({ ok: true, recovered: true, notified: emailed, outage_hours: outageHours })
})
