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
// MERGED WITH send-digest (19 Sep 2026). Adrian was getting two separate
// morning emails — this one, and send-digest's "Good morning — here's your
// day" at 07:30 UTC. Combined into this one send so there's exactly one
// morning email, not two.
//
// IMPORTANT — this merge was built starting from the LIVE DEPLOYED source of
// this function (fetched directly via the Supabase API), not from this
// repo's git history. The deployed version already included a "chase ladder
// exhausted / needs manual follow-up" block (FollowUpItem / followUps /
// followUpBlock below) that does not exist anywhere in this repo's commit
// history — it was deployed directly at some point without ever being
// committed. That drift is real and pre-existing, not something this merge
// introduced; flagging it here so it isn't mistaken for new. This file is
// now the first commit that actually captures that feature in git — worth
// treating as the new source of truth and keeping in sync from here on.
//
// Kept at THIS function's 10:35 UTC slot, not moved to send-digest's
// earlier 07:30 — not a coin flip. daily-ops-check's invoice-chase-evidence
// check (see that file's check 3) is only meaningful once
// process-invoice-chases (yca-platform, scheduled 09:00 UTC) has actually
// had its chance to run for the day; running the combined email at 07:30
// would make that check fire a false "no evidence found" every single
// morning, before the job it's checking for has even run yet. The
// approval-count section below has no such constraint, so it moved to this
// slot rather than the reverse.
//
// What moved here from send-digest: ONLY the simplified count of posts and
// blogs awaiting approval (see APPROVAL SUMMARY below), rendered above the
// existing daily-ops-check content, in this same email — Adrian explicitly
// asked for a count, not the old per-item preview list with a "Review"
// button on every single post. Everything else send-digest used to send
// (tasks due today, overdue tasks, Monday's competitor intelligence, the
// active-clients footer) is UNCHANGED and still renders, just lower down,
// since dropping it wasn't asked for and it's real, used functionality.
//
// send-digest itself is retired — see that file's own header. Its
// 'morning-digest' cron trigger is unscheduled (see migration
// 20260919_retire_morning_digest_cron.sql); the function is left deployed
// but stubbed to a harmless no-op rather than deleted outright, as a second
// line of defence against ever getting a duplicate email if the unschedule
// somehow didn't apply.
//
// job_name stays 'notify-daily-ops', unchanged — notify-daily-ops-
// healthcheck (10:50 UTC) alerts if THIS exact job_name doesn't log a row
// today, and renaming this function would silently break that watchdog
// unless it were updated too. Simplest correct choice: don't rename it.
//
// RECIPIENT: send-digest supported an optional DIGEST_RECIPIENT_EMAIL vault
// secret to override its default recipient; this function previously always
// sent to the hardcoded TO_EMAIL below with no override. The merged send now
// honours DIGEST_RECIPIENT_EMAIL if it's set, falling back to the same
// address either function used by default — so nothing changes for anyone
// unless that override was already in use, in which case the combined email
// now goes where the digest used to. Worth Adrian double-checking that
// secret isn't set to somewhere the ops-check content shouldn't go, since
// before this merge only the digest half honoured it.
//
// TRIAGE, NOT JUST FORMATTING (29 Aug 2026) — daily-ops-check now does its
// own pre-filtering before this function ever sees the report: edge
// function errors covered by a known-explained ops_known_events window
// (a recorded restart/incident, or logged test activity) are pulled out of
// `unexplained_total`/`by_function` into a separate `explained` list, and
// invoice-chase "no evidence" only fires once that cron has actually had
// its chance to run for the checked date. This function's job stays the
// same — render whatever daily-ops-check decided — but the critical issue
// below now reads `unexplained_total`, not `total`, and explained errors
// get their own clearly-separate blue block, never merged into the red
// "needs action" block or the grey FYI block.
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
//
// NEEDS-MANUAL-FOLLOW-UP BLOCK (2 Sep 2026) — daily-ops-check's new check 7
// (chase_ladder_exhausted) surfaces invoices that ran the full chase ladder
// and remain unpaid — real gap found via BCMY's INV-0001 (Riverside), which
// sat 33 days overdue with zero further visibility after its day-30 chase.
// Rendered in its OWN block below (amber/orange, "🟠 Needs manual
// follow-up"), deliberately never merged into the flat critical/minor
// `issues` list those two severities use: those are one-line-per-finding by
// design, and this needs structured per-invoice detail (invoice number,
// customer, amount outstanding, days overdue, last chase sent) a single
// text line can't carry. Still counted into the subject line and the
// header's colour/icon, same as every other real finding — see the block
// itself, and the summary/subject-building code below it, for where.
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { checkCronAuth } from '../_shared/cronAuth.ts'
// Display-only UK-local formatting — this file's entire output is an email a
// human reads, so any timestamp reaching the body gets converted (see
// _shared/ukTime.ts). Nothing here is stored, compared or sent to an API.
import { formatUkDateTime } from '../_shared/ukTime.ts'

// deno-lint-ignore no-explicit-any
type Admin = any

const DEFAULT_RECIPIENT = 'adrianfielding@me.com'
const OPS_URL = 'https://ops.yourcompanyai.co.uk'

// The status values that mean "not yet acted on" for mkt_content_queue.
// Mirrors src/lib/awaitingApproval.js's AWAITING_APPROVAL_STATUSES exactly —
// this is a Deno edge function and can't import across the src/ boundary
// through its own bundler, so it carries a matching constant with a pointer
// back to that file, same as send-digest used to. If that definition ever
// changes, this one must change with it.
const AWAITING_APPROVAL_STATUSES = ['draft', 'pending']

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

  // APPROVAL SUMMARY (19 Sep 2026, moved from send-digest) — run alongside
  // the daily-ops-check call, not after it, so merging the two emails adds
  // no extra latency to either. Two separate tables, not one query: posts
  // (mkt_content_queue, canonical AWAITING_APPROVAL_STATUSES) and blogs
  // (mkt_blog_posts) are genuinely distinct pipelines with their own status
  // vocabularies — confirmed against mkt_blog_posts' own CHECK constraint,
  // which permits 'draft' but has no 'pending' value at all, unlike
  // mkt_content_queue. head:true + count:'exact' so this is a cheap count,
  // not a fetch of every row's content — the old per-post preview list is
  // exactly what Adrian asked to stop getting.
  const [checkRes, postsCountRes, blogsCountRes] = await Promise.all([
    fetch(`${supabaseUrl}/functions/v1/daily-ops-check`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${serviceKey}`, apikey: serviceKey, 'Content-Type': 'application/json' },
      body: JSON.stringify(body.date ? { date: body.date } : {}),
    }),
    admin.from('mkt_content_queue').select('id', { count: 'exact', head: true }).in('status', AWAITING_APPROVAL_STATUSES),
    admin.from('mkt_blog_posts').select('id', { count: 'exact', head: true }).eq('status', 'draft'),
  ])
  if (!checkRes.ok) {
    await logEdgeError(admin, `daily-ops-check returned ${checkRes.status} — no daily ops email sent`)
    return new Response(JSON.stringify({ ok: false, error: `daily-ops-check returned ${checkRes.status}` }), { status: 502, headers: { 'Content-Type': 'application/json' } })
  }
  const result = await checkRes.json()
  const report = result.report ?? {}
  const anyFlag = !!result.any_flag

  // Fail loudly here too, same reasoning send-digest's own investigation
  // established (27 Aug 2026, see that file's history): a failed count query
  // must render as "unknown", never as a trusted zero. Doesn't abort the
  // whole email over it — the ops-check content below is independently
  // useful even if this one section can't be trusted this morning.
  const postsCountOk = !postsCountRes.error && typeof postsCountRes.count === 'number'
  const blogsCountOk = !blogsCountRes.error && typeof blogsCountRes.count === 'number'
  if (!postsCountOk) await logEdgeError(admin, `approval summary: posts count failed — ${postsCountRes.error?.message ?? 'no count returned'}`)
  if (!blogsCountOk) await logEdgeError(admin, `approval summary: blogs count failed — ${blogsCountRes.error?.message ?? 'no count returned'}`)
  const postsCount = postsCountOk ? postsCountRes.count : null
  const blogsCount = blogsCountOk ? blogsCountRes.count : null

  // ONE link, per the ask — not a per-post Review button any more. Points at
  // the dashboard root rather than /content?status=draft: posts and blogs
  // are two genuinely separate approval pages in this frontend (/content and
  // /blog — no single page lists both), but Dashboard.jsx already shows both
  // real counts as their own stat pills, each linking to its own queue
  // (confirmed in that file: "Awaiting approval" -> /content?status=draft,
  // "Blogs to review" -> /blog). That's the one honest single landing point
  // for "go deal with both of these", so that's what this links to.
  const approvalSummaryHtml = `<div style="font-family:Arial,sans-serif;max-width:600px;color:#1C1C2E;margin-bottom:20px">
        <h2 style="color:#1C2B3A;margin:0 0 4px">Good morning.</h2>
        <p style="font-size:14px;margin:0 0 12px">
          ${postsCountOk && blogsCountOk
            ? `<strong>${postsCount}</strong> post${postsCount === 1 ? '' : 's'} and <strong>${blogsCount}</strong> blog${blogsCount === 1 ? '' : 's'} awaiting approval.`
            : `Posts/blogs awaiting approval: <strong>count unavailable</strong> — the query failed, see edge_function_errors (notify-daily-ops).`}
        </p>
        <p style="margin:0 0 16px"><a href="${OPS_URL}" style="background:#E8410A;color:#fff;text-decoration:none;padding:8px 16px;border-radius:6px;font-size:13px;font-weight:700">Review the queue</a></p>
      </div>`

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
  if (report.edge_function_errors_window?.unexplained_total > 0) {
    const byFn = Object.entries(report.edge_function_errors_window.by_function ?? {}).map(([fn, n]) => `${fn} (${n})`).join(', ')
    issues.push({ severity: 'critical', text: `${report.edge_function_errors_window.unexplained_total} edge function error(s) in the window: ${byFn}` })
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

  // Chase-ladder-exhausted invoices — kept as its own typed list rather than
  // folded into `issues` above (see this file's header comment). Real money,
  // real customer, structured detail — a single text line would either drop
  // fields this needs (amount, days overdue, last chase date) or make the
  // critical/minor list unreadable once more than one invoice is stuck.
  type FollowUpItem = {
    invoice_id: string; invoice_number: string; account_id: string; account_name: string;
    customer: string; balance_pence: number; days_overdue: number;
    last_chase_stage: number | null; last_chase_sent_at: string | null
  }
  const followUps = (report.chase_ladder_exhausted?.items ?? []) as FollowUpItem[]

  // Structural safeguard, not a habit to remember: the real daily cron run
  // always calls with an empty body (no date override), so it always gets
  // the clean production subject. ANY manual/test invocation that supplies
  // a date override is guaranteed a visibly different subject prefix, so a
  // test run can never land in the inbox looking like a real report —
  // this is enforced in code, not left to whoever is testing to remember.
  const testPrefix = body.date ? '[MANUAL CHECK — not the daily report] ' : ''
  const subjectParts = [
    critical.length ? `${critical.length} critical` : null,
    followUps.length ? `${followUps.length} follow-up` : null,
    minor.length ? `${minor.length} minor` : null,
  ].filter(Boolean).join(', ')
  const subject = testPrefix + (anyFlag ? `🔴 Daily Ops — ${subjectParts}` : `🟢 Daily Ops — Clean`)
  const dateLabel = report.outreach?.date_checked ?? 'yesterday'
  const testBanner = body.date
    ? `<p style="background:#FFF3CD;border:1px solid #FFE58F;padding:8px 12px;border-radius:6px;font-size:12px;margin-bottom:16px">Manually triggered re-check for ${body.date} — not the real daily report.</p>`
    : ''
  // Three visually distinct severity blocks (plus the separate "explained"
  // block further down) so severity reads at a glance without opening every
  // line: solid red for anything needing action today, amber/orange for
  // real money sitting unresolved needing a human decision (not urgent in
  // the "something is broken" sense, but not routine either), muted grey
  // for FYI-only findings. A report with only minor findings still gets the
  // 🔴 subject (anyFlag is true) but the body itself is visibly calmer.
  const totalFindings = issues.length + followUps.length
  const criticalBlock = critical.length
    ? `<div style="background:#FDECEA;border:1px solid #F5C6CB;border-radius:8px;padding:16px;margin-bottom:16px">
        <p style="margin:0 0 8px;font-weight:bold;color:#C0392B">🔴 Needs action today (${critical.length})</p>
        <ul style="margin:0;padding-left:20px">${critical.map((i) => `<li style="margin-bottom:8px">${i.text}</li>`).join('')}</ul>
      </div>`
    : ''
  // Needs-manual-follow-up — chase ladder exhausted, real balance still
  // outstanding. Deliberately NOT an automated escalation: this block only
  // ever renders what daily-ops-check's read-only query found (see that
  // function's check-7 comment) — no email/webhook/status change is
  // triggered by this rendering or by this function at all. Stays on this
  // list, reappearing every day, until the invoice is paid, credited,
  // written off, or a contact/permanent-pause exclusion is set — nothing
  // here dismisses or snoozes an entry, by design (requirement: it must
  // keep surfacing, not be flagged once and dropped).
  const gbpFollow = (p: number) => `£${(p / 100).toFixed(2)}`
  const followUpBlock = followUps.length
    ? `<div style="background:#FFF7ED;border:1px solid #FED7AA;border-radius:8px;padding:16px;margin-bottom:16px">
        <p style="margin:0 0 8px;font-weight:bold;color:#C2410C">🟠 Needs manual follow-up — chase ladder exhausted, no payment (${followUps.length})</p>
        <p style="margin:0 0 10px;font-size:12px;color:#9A3412">Ran the full 7/14/30-day chase and got no payment — nothing further is sent automatically. Needs a human call: chase another way, write off, dispute, or otherwise resolve. Stays on this list every day until it is.</p>
        <table style="width:100%;border-collapse:collapse;font-size:12px;color:#7C2D12">
          <thead><tr style="text-align:left;color:#9A3412">
            <th style="padding:4px 8px 4px 0">Invoice</th>
            <th style="padding:4px 8px 4px 0">Customer</th>
            <th style="padding:4px 8px 4px 0">Outstanding</th>
            <th style="padding:4px 8px 4px 0">Days overdue</th>
            <th style="padding:4px 0">Last chase sent</th>
          </tr></thead>
          <tbody>
            ${followUps.map((f) => `<tr>
              <td style="padding:4px 8px 4px 0;font-weight:bold">${f.invoice_number}</td>
              <td style="padding:4px 8px 4px 0">${f.customer}${f.account_name ? ` (${f.account_name})` : ''}</td>
              <td style="padding:4px 8px 4px 0">${gbpFollow(f.balance_pence)}</td>
              <td style="padding:4px 8px 4px 0">${f.days_overdue}</td>
              <td style="padding:4px 0">${f.last_chase_sent_at ? formatUkDateTime(f.last_chase_sent_at) : '—'}</td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>`
    : ''
  const minorBlock = minor.length
    ? `<div style="background:#F3F4F6;border:1px solid #E5E7EB;border-radius:8px;padding:16px">
        <p style="margin:0 0 8px;font-weight:bold;color:#6B7280">🟡 FYI — low priority (${minor.length})</p>
        <ul style="margin:0;padding-left:20px;color:#4B5563">${minor.map((i) => `<li style="margin-bottom:8px">${i.text}</li>`).join('')}</ul>
      </div>`
    : ''
  // Kept in its own visually distinct block, separate from both the red
  // "needs action" block and the grey FYI block — these are edge function
  // errors that WOULD have been flagged, except an ops_known_events row
  // (a recorded restart/incident, or logged test activity — see
  // daily-ops-check's check-5 comment) already covers exactly when they
  // happened. Shown for transparency/audit, not as something to act on.
  const explainedErrors = (report.edge_function_errors_window?.explained ?? []) as
    { function_name?: string; error_message?: string; created_at?: string; reason?: string }[]
  const explainedBlock = explainedErrors.length
    ? `<div style="background:#EFF6FF;border:1px solid #BFDBFE;border-radius:8px;padding:16px;margin-top:16px">
        <p style="margin:0 0 8px;font-weight:bold;color:#1D4ED8">🔵 Explained — no action needed (${explainedErrors.length})</p>
        <ul style="margin:0;padding-left:20px;color:#1E3A8A">${explainedErrors.map((e) =>
          `<li style="margin-bottom:8px">${e.function_name ?? '(unknown)'}: ${e.error_message ?? ''} — ${e.reason ?? ''}</li>`,
        ).join('')}</ul>
      </div>`
    : ''
  // Header colour/icon: red beats orange beats amber — critical (something
  // broken or losing money right now) outranks a follow-up-only report
  // (real money stuck, but not a fresh break), which itself outranks a
  // minor-only report (routine hygiene, nothing urgent).
  const headerColor = critical.length ? '#C0392B' : followUps.length ? '#C2410C' : '#B7791F'
  const headerIcon = critical.length ? '🔴' : followUps.length ? '🟠' : '🟡'
  const summaryParts = [
    critical.length ? `${critical.length} critical` : null,
    followUps.length ? `${followUps.length} needing manual follow-up` : null,
    minor.length ? `${minor.length} minor` : null,
  ].filter(Boolean).join(', ')
  // approvalSummaryHtml is its own top-level block, prepended before the
  // ops-check content — NOT folded inside it — so the ops-check half stays
  // byte-for-byte the same markup it already was, per "keep the Daily Ops
  // Check content exactly as it currently is".
  const opsCheckHtml = anyFlag
    ? `<div style="font-family:Arial,sans-serif;max-width:600px;color:#1C1C2E">
        ${testBanner}
        <h2 style="color:${headerColor}">${headerIcon} Daily Ops Check — ${dateLabel}</h2>
        <p>${summaryParts} finding${totalFindings === 1 ? '' : 's'}:</p>
        ${criticalBlock}
        ${followUpBlock}
        ${minorBlock}
        ${explainedBlock}
        <p style="font-size:12px;color:#9CA3AF;margin-top:24px">This is a report only — nothing was changed or resent automatically.</p>
      </div>`
    : `<div style="font-family:Arial,sans-serif;max-width:600px;color:#1C1C2E">
        ${testBanner}
        <h2 style="color:#2E7D32">🟢 Daily Ops Check — ${dateLabel}</h2>
        <p>All 7 checks came back clean — outreach volume, cron-healthcheck, invoice-chase evidence, contact emails, edge function errors, voice-to-quote spend${
          report.voice_quote_spend ? ` (£${((report.voice_quote_spend.total_pence ?? 0) / 100).toFixed(2)} across ${report.voice_quote_spend.calls ?? 0} call(s))` : ''
        }, and chase-ladder follow-ups.</p>
        ${explainedBlock}
      </div>`
  const html = approvalSummaryHtml + opsCheckHtml

  const resendKey = Deno.env.get('RESEND_API_KEY')
  if (!resendKey) {
    await logEdgeError(admin, 'RESEND_API_KEY not configured — no daily ops email sent')
    return new Response(JSON.stringify({ ok: false, error: 'RESEND_API_KEY not configured' }), { status: 500, headers: { 'Content-Type': 'application/json' } })
  }
  // DIGEST_RECIPIENT_EMAIL — see the merge note at the top of this file for
  // why this now honours the override send-digest used to.
  const to = Deno.env.get('DIGEST_RECIPIENT_EMAIL') || DEFAULT_RECIPIENT
  const sendRes = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: 'Daily Ops Check <hello@yourcompanyai.co.uk>',
      to,
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
      notes: [subject, `awaiting approval: ${postsCountOk ? postsCount : 'unknown'} post(s), ${blogsCountOk ? blogsCount : 'unknown'} blog(s)`],
    })
    if (logError) console.error(`[notify-daily-ops] failed to write mkt_cron_log: ${logError.message}`)
  }

  return new Response(JSON.stringify({
    ok: true, any_flag: anyFlag, issue_count: issues.length + followUps.length,
    critical_count: critical.length, minor_count: minor.length, follow_up_count: followUps.length,
    posts_awaiting_approval: postsCount, blogs_awaiting_approval: blogsCount,
    subject, resend_id: sendBody.id ?? null,
  }), {
    headers: { 'Content-Type': 'application/json' },
  })
})
