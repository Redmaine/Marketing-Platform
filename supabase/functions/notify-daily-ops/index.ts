// Supabase Edge Function: notify-daily-ops  (Deno) — runs daily via pg_cron,
// 5 minutes after daily-ops-check.
//
// This is the ONLY function in the daily-ops build that sends anything.
// daily-ops-check itself stays purely read-only (see its own file header) —
// this function's entire job is: call it, read its report, send exactly one
// summary email via Resend. No other side effects anywhere in this file.
//
// Optional body { date: 'YYYY-MM-DD' } is forwarded straight to
// daily-ops-check, letting a specific past day be checked-and-notified on
// demand (used to test both the clean and flagged email branches against
// real historical dates, and useful going forward for a manual re-check).
//
// Deploy: supabase functions deploy notify-daily-ops
// Schedule: 35 10 * * * (5 min after daily-ops-check's own 10:30 UTC run)
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { checkCronAuth } from '../_shared/cronAuth.ts'

const TO_EMAIL = 'adrianfielding@me.com'

serve(async (req) => {
  // Shared cronAuth helper — see the identical note in daily-ops-check. This
  // file carried the same duplicated inline block reading CRON_SECRET from
  // the environment, and broke the same way for the same reason when that
  // env var was retired in favour of Vault.
  const auth = await checkCronAuth(req, 'notify-daily-ops')
  if (!auth.authorised) return auth.response!

  let body: { date?: string } = {}
  try { body = await req.json() } catch { /* no body = real yesterday */ }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!
  // Service-role key as a bearer token, which daily-ops-check's own cronAuth
  // fallback accepts directly — the same way sweep-stuck-metricool-posts calls
  // schedule-to-metricool. This line used to pass a local `cronSecret` const
  // read straight from the environment; when the auth block above was replaced
  // with the shared checkCronAuth helper (16 Aug 2026) that const went with it
  // and this reference was missed. Auth then passed and the function died one
  // line later on "ReferenceError: cronSecret is not defined", so the daily
  // email silently stopped arriving while the cron job kept reporting a run.
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  const checkRes = await fetch(`${supabaseUrl}/functions/v1/daily-ops-check`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${serviceKey}`, apikey: serviceKey, 'Content-Type': 'application/json' },
    body: JSON.stringify(body.date ? { date: body.date } : {}),
  })
  if (!checkRes.ok) {
    return new Response(JSON.stringify({ ok: false, error: `daily-ops-check returned ${checkRes.status}` }), { status: 502, headers: { 'Content-Type': 'application/json' } })
  }
  const result = await checkRes.json()
  const report = result.report ?? {}
  const anyFlag = !!result.any_flag

  // Build a plain-English summary of exactly what's flagged, per check —
  // only the categories that actually have something wrong get a line.
  const issues: string[] = []
  if (report.outreach?.flagged_zero_send?.length) {
    issues.push(`Outreach: zero sends for ${report.outreach.flagged_zero_send.join(', ')} on ${report.outreach.date_checked}`)
  }
  if (report.cron_healthcheck?.stale) {
    issues.push(`cron-healthcheck hasn't run in ${report.cron_healthcheck.hours_since_last_run ?? '?'}h (last: ${report.cron_healthcheck.last_run_at ?? 'never'})`)
  }
  if (report.cron_healthcheck?.reported_errors?.length) {
    // Fix — this used to relay cron-healthcheck's errors with no timestamp,
    // so the same still-unresolved finding from a prior run read as a brand
    // new issue every morning (this is exactly what caused the "flagged on
    // both 10 Aug and 12 Aug" confusion — it was one ongoing finding, not
    // two). cron-healthcheck runs independently of this email, once a day,
    // so its errors can be up to ~24h+ old by the time this is read. The
    // age label makes that explicit instead of leaving it to be assumed.
    const ageLabel = report.cron_healthcheck.reported_errors_age_label
      ? ` (${report.cron_healthcheck.reported_errors_age_label})`
      : ''
    issues.push(`cron-healthcheck itself flagged${ageLabel}: ${report.cron_healthcheck.reported_errors.join(', ')}`)
  }
  if (report.invoice_chase_evidence?.flagged_no_evidence_found) {
    issues.push(`No real invoice-chase send evidence found for ${report.invoice_chase_evidence.date_checked}`)
  }
  if (report.contacts_missing_email?.flagged?.length) {
    const names = report.contacts_missing_email.flagged.map((c: { name: string }) => c.name).join(', ')
    issues.push(`${report.contacts_missing_email.flagged.length} contact(s) created ${report.contacts_missing_email.date_checked} with no email on file: ${names}`)
  }
  if (report.edge_function_errors_window?.total > 0) {
    const byFn = Object.entries(report.edge_function_errors_window.by_function ?? {}).map(([fn, n]) => `${fn} (${n})`).join(', ')
    issues.push(`${report.edge_function_errors_window.total} edge function error(s) in the window: ${byFn}`)
  }
  if (report.voice_quote_spend?.flagged_over_threshold) {
    const v = report.voice_quote_spend
    const gbp = (p: number) => `£${(p / 100).toFixed(2)}`
    // Names the top account inline: when this fires the question is always
    // "which account", and the answer belongs in the sentence rather than a
    // follow-up query against a table Adrian would have to go and find.
    const top = (v.by_account ?? []).slice(0, 3)
      .map((a: { account_id: string; pence: number }) => `${a.account_id} (${gbp(a.pence)})`)
      .join(', ')
    issues.push(
      `Voice-to-quote spend ${gbp(v.total_pence)} on ${v.date_checked}, over the ${gbp(v.threshold_pence)} daily threshold ` +
      `(${v.calls} call(s))${top ? ` — biggest: ${top}` : ''}`,
    )
  }

  // Structural safeguard, not a habit to remember: the real daily cron run
  // always calls with an empty body (no date override), so it always gets
  // the clean production subject. ANY manual/test invocation that supplies
  // a date override is guaranteed a visibly different subject prefix, so a
  // test run can never land in the inbox looking like a real report —
  // this is enforced in code, not left to whoever is testing to remember.
  const testPrefix = body.date ? '[MANUAL CHECK — not the daily report] ' : ''
  const subject = testPrefix + (anyFlag ? `🔴 Daily Ops — ${issues.length} issue${issues.length === 1 ? '' : 's'} found` : `🟢 Daily Ops — Clean`)
  const dateLabel = report.outreach?.date_checked ?? 'yesterday'
  const testBanner = body.date
    ? `<p style="background:#FFF3CD;border:1px solid #FFE58F;padding:8px 12px;border-radius:6px;font-size:12px;margin-bottom:16px">Manually triggered re-check for ${body.date} — not the real daily report.</p>`
    : ''
  const html = anyFlag
    ? `<div style="font-family:Arial,sans-serif;max-width:600px;color:#1C1C2E">
        ${testBanner}
        <h2 style="color:#C0392B">🔴 Daily Ops Check — ${dateLabel}</h2>
        <p>${issues.length} issue${issues.length === 1 ? '' : 's'} found:</p>
        <ul>${issues.map((i) => `<li style="margin-bottom:8px">${i}</li>`).join('')}</ul>
        <p style="font-size:12px;color:#9CA3AF;margin-top:24px">This is a report only — nothing was changed or resent automatically.</p>
      </div>`
    : `<div style="font-family:Arial,sans-serif;max-width:600px;color:#1C1C2E">
        ${testBanner}
        <h2 style="color:#2E7D32">🟢 Daily Ops Check — ${dateLabel}</h2>
        <p>All 6 checks came back clean — outreach volume, cron-healthcheck, invoice-chase evidence, contact emails, edge function errors, and voice-to-quote spend${
          report.voice_quote_spend ? ` (£${((report.voice_quote_spend.total_pence ?? 0) / 100).toFixed(2)} across ${report.voice_quote_spend.calls ?? 0} call(s))` : ''
        }.</p>
      </div>`

  const resendKey = Deno.env.get('RESEND_API_KEY')
  if (!resendKey) {
    return new Response(JSON.stringify({ ok: false, error: 'RESEND_API_KEY not configured' }), { status: 500, headers: { 'Content-Type': 'application/json' } })
  }
  const sendRes = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: 'Daily Ops Check <hello@yourcompanyai.co.uk>',
      to: TO_EMAIL,
      subject,
      html,
    }),
  })
  if (!sendRes.ok) {
    const detail = await sendRes.text()
    return new Response(JSON.stringify({ ok: false, error: `Resend send failed: ${detail}` }), { status: 502, headers: { 'Content-Type': 'application/json' } })
  }
  const sendBody = await sendRes.json().catch(() => ({}))

  return new Response(JSON.stringify({ ok: true, any_flag: anyFlag, issue_count: issues.length, subject, resend_id: sendBody.id ?? null }), {
    headers: { 'Content-Type': 'application/json' },
  })
})
