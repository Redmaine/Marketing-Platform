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
//
// SELF-ERROR-LOGGING — added 20 Aug 2026. Real 14-day evidence (Supabase's
// function_edge_logs, cross-checked against cron.job_run_details) found this
// function had already failed silently on 2 of its first 7 real production
// days: 17 Aug ("ReferenceError: cronSecret is not defined" — the exact
// historical bug the comment below describes) and 14 Aug (its own invocation
// never appears in the function logs at all, despite pg_cron's
// cron.job_run_details reporting the outer net.http_post() call
// "succeeded" — that only proves the async request was queued, not that
// this function ever ran or that Resend accepted anything). Neither failure
// left ANY trace anywhere a human or another check would see it: this
// function has no fallback alert channel of its own, and previously wrote
// nothing to edge_function_errors on either failure path below — so
// tomorrow's daily-ops-check (which DOES read edge_function_errors) would
// have had nothing to surface even the day after. logEdgeError below is a
// partial mitigation, not a same-day catch: it makes a repeat of the 17 Aug
// incident show up in the NEXT day's report instead of never at all. A real
// same-day catch would need a separate monitor calling this function's own
// status (the same shape as outreach-platform's gmail-health-check), which
// is a bigger, separate decision, not made here.
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { checkCronAuth } from '../_shared/cronAuth.ts'
// Display-only UK-local formatting — this file's entire output is an email a
// human reads, so any timestamp reaching the body gets converted (see
// _shared/ukTime.ts). Nothing here is stored, compared or sent to an API.
import { formatUkDateTime } from '../_shared/ukTime.ts'

// deno-lint-ignore no-explicit-any
type Admin = any

const TO_EMAIL = 'adrianfielding@me.com'

async function logEdgeError(admin: Admin, message: string) {
  const { error } = await admin.from('edge_function_errors').insert({ function_name: 'notify-daily-ops', error_message: message })
  if (error) console.error(`[notify-daily-ops] failed to write edge_function_errors: ${error.message}`)
}

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
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  const admin: Admin = createClient(supabaseUrl, serviceKey)

  const checkRes = await fetch(`${supabaseUrl}/functions/v1/daily-ops-check`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${serviceKey}`, apikey: serviceKey, 'Content-Type': 'application/json' },
    body: JSON.stringify(body.date ? { date: body.date } : {}),
  })
  if (!checkRes.ok) {
    await logEdgeError(admin, `daily-ops-check returned ${checkRes.status} — no daily ops email sent`)
    return new Response(JSON.stringify({ ok: false, error: `daily-ops-check returned ${checkRes.status}` }), { status: 502, headers: { 'Content-Type': 'application/json' } })
  }
  const result = await checkRes.json()
  const report = result.report ?? {}
  const anyFlag = !!result.any_flag

  // Build a plain-English summary of exactly what's flagged, per check —
  // only the categories that actually have something wrong get a line. Each
  // gets a severity so the email can visually separate "needs action today"
  // from "FYI, low priority" — added 20 Aug 2026. Previously every flag
  // rendered identically in one flat list: a single stray contact with no
  // email looked exactly as urgent as a real edge function exception, so
  // there was no way to tell at a glance which finding actually needed
  // action today. critical = something is actually broken or losing money
  // (real exceptions, revenue-facing automation with no send evidence, a
  // cost overrun, the health-monitor itself failing) — minor = worth
  // knowing but not urgent (a data-hygiene gap, or a single brand's
  // zero-send day that could be legitimate).
  type Issue = { severity: 'critical' | 'minor'; text: string }
  const issues: Issue[] = []
  if (report.outreach?.flagged_zero_send?.length) {
    const allBrandsDown = report.outreach.flagged_zero_send.length >= 3
    issues.push({
      severity: allBrandsDown ? 'critical' : 'minor',
      text: `Outreach: zero sends for ${report.outreach.flagged_zero_send.join(', ')} on ${report.outreach.date_checked}`,
    })
  }
  if (report.cron_healthcheck?.stale) {
    issues.push({
      severity: 'critical',
      // last_run_at arrives from daily-ops-check as a UTC ISO string (it is a
      // raw mkt_cron_log.created_at and must STAY UTC there — that report
      // does hours_since_last_run arithmetic on it). It is converted here, at
      // the one point it turns into prose in an email, and nowhere earlier.
      text: `cron-healthcheck hasn't run in ${report.cron_healthcheck.hours_since_last_run ?? '?'}h (last: ${report.cron_healthcheck.last_run_at ? formatUkDateTime(report.cron_healthcheck.last_run_at) : 'never'})`,
    })
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
    issues.push({
      severity: 'critical',
      text: `cron-healthcheck itself flagged${ageLabel}: ${report.cron_healthcheck.reported_errors.join(', ')}`,
    })
  }
  if (report.invoice_chase_evidence?.flagged_no_evidence_found) {
    issues.push({ severity: 'critical', text: `No real invoice-chase send evidence found for ${report.invoice_chase_evidence.date_checked}` })
  }
  if (report.contacts_missing_email?.flagged?.length) {
    const names = report.contacts_missing_email.flagged.map((c: { name: string }) => c.name).join(', ')
    issues.push({
      severity: 'minor',
      text: `${report.contacts_missing_email.flagged.length} contact(s) created ${report.contacts_missing_email.date_checked} with no email on file: ${names}`,
    })
  }
  if (report.edge_function_errors_window?.total > 0) {
    const byFn = Object.entries(report.edge_function_errors_window.by_function ?? {}).map(([fn, n]) => `${fn} (${n})`).join(', ')
    issues.push({ severity: 'critical', text: `${report.edge_function_errors_window.total} edge function error(s) in the window: ${byFn}` })
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
    issues.push({
      severity: 'critical',
      text: `Voice-to-quote spend ${gbp(v.total_pence)} on ${v.date_checked}, over the ${gbp(v.threshold_pence)} daily threshold ` +
        `(${v.calls} call(s))${top ? ` — biggest: ${top}` : ''}`,
    })
  }

  const critical = issues.filter((i) => i.severity === 'critical')
  const minor = issues.filter((i) => i.severity === 'minor')

  // Structural safeguard, not a habit to remember: the real daily cron run
  // always calls with an empty body (no date override), so it always gets
  // the clean production subject. ANY manual/test invocation that supplies
  // a date override is guaranteed a visibly different subject prefix, so a
  // test run can never land in the inbox looking like a real report —
  // this is enforced in code, not left to whoever is testing to remember.
  const testPrefix = body.date ? '[MANUAL CHECK — not the daily report] ' : ''
  const subjectParts = [
    critical.length ? `${critical.length} critical` : null,
    minor.length ? `${minor.length} minor` : null,
  ].filter(Boolean).join(', ')
  const subject = testPrefix + (anyFlag ? `🔴 Daily Ops — ${subjectParts}` : `🟢 Daily Ops — Clean`)
  const dateLabel = report.outreach?.date_checked ?? 'yesterday'
  const testBanner = body.date
    ? `<p style="background:#FFF3CD;border:1px solid #FFE58F;padding:8px 12px;border-radius:6px;font-size:12px;margin-bottom:16px">Manually triggered re-check for ${body.date} — not the real daily report.</p>`
    : ''
  // Two visually distinct blocks so severity reads at a glance without
  // opening every line: a solid red block for anything needing action
  // today, a muted grey block below for FYI-only findings. A report with
  // only minor findings still gets the 🔴 subject (anyFlag is true) but the
  // body itself is visibly calmer — no red block at all — since nothing in
  // it is actually urgent.
  const criticalBlock = critical.length
    ? `<div style="background:#FDECEA;border:1px solid #F5C6CB;border-radius:8px;padding:16px;margin-bottom:16px">
        <p style="margin:0 0 8px;font-weight:bold;color:#C0392B">🔴 Needs action today (${critical.length})</p>
        <ul style="margin:0;padding-left:20px">${critical.map((i) => `<li style="margin-bottom:8px">${i.text}</li>`).join('')}</ul>
      </div>`
    : ''
  const minorBlock = minor.length
    ? `<div style="background:#F3F4F6;border:1px solid #E5E7EB;border-radius:8px;padding:16px">
        <p style="margin:0 0 8px;font-weight:bold;color:#6B7280">🟡 FYI — low priority (${minor.length})</p>
        <ul style="margin:0;padding-left:20px;color:#4B5563">${minor.map((i) => `<li style="margin-bottom:8px">${i.text}</li>`).join('')}</ul>
      </div>`
    : ''
  const html = anyFlag
    ? `<div style="font-family:Arial,sans-serif;max-width:600px;color:#1C1C2E">
        ${testBanner}
        <h2 style="color:${critical.length ? '#C0392B' : '#B7791F'}">${critical.length ? '🔴' : '🟡'} Daily Ops Check — ${dateLabel}</h2>
        <p>${critical.length ? `${critical.length} critical` : ''}${critical.length && minor.length ? ', ' : ''}${minor.length ? `${minor.length} minor` : ''} finding${issues.length === 1 ? '' : 's'}:</p>
        ${criticalBlock}
        ${minorBlock}
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
    await logEdgeError(admin, 'RESEND_API_KEY not configured — no daily ops email sent')
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
    await logEdgeError(admin, `Resend send failed (${sendRes.status}): ${detail.slice(0, 300)}`)
    return new Response(JSON.stringify({ ok: false, error: `Resend send failed: ${detail}` }), { status: 502, headers: { 'Content-Type': 'application/json' } })
  }
  const sendBody = await sendRes.json().catch(() => ({}))

  // Durable same-day evidence that this actually sent — added 20 Aug 2026
  // alongside notify-daily-ops-healthcheck, which reads this row to catch a
  // missing report the same morning instead of the next day. Only written
  // for a REAL scheduled run (no date override) — same reasoning as the
  // testPrefix/subject guard above: a manual re-check must never look like
  // today's real report, including to the healthcheck reading this table.
  if (!body.date) {
    const { error: logError } = await admin.from('mkt_cron_log').insert({
      job_name: 'notify-daily-ops',
      clients_processed: 0,
      posts_generated: 0,
      errors: null,
      notes: [subject],
    })
    if (logError) console.error(`[notify-daily-ops] failed to write mkt_cron_log: ${logError.message}`)
  }

  return new Response(JSON.stringify({
    ok: true, any_flag: anyFlag, issue_count: issues.length,
    critical_count: critical.length, minor_count: minor.length,
    subject, resend_id: sendBody.id ?? null,
  }), {
    headers: { 'Content-Type': 'application/json' },
  })
})
