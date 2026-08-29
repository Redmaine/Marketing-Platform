// Supabase Edge Function: daily-ops-check  (Deno) — runs daily via pg_cron
//
// STRICT DESIGN RULE: this function is 100% read-only against every table
// it touches (outreach_daily_log, mkt_cron_log, invoice_chaser_log,
// contacts, edge_function_errors, voice_quote_costs). It performs zero INSERT/UPDATE/DELETE
// anywhere, and calls no other function, sends no email, fixes nothing.
// It only queries, compares, and returns a JSON report of what it found.
// Deliberately does NOT self-log a row to mkt_cron_log — the durable record
// of each run is the separate notify-daily-ops function's email.
//
// Optional body { date: 'YYYY-MM-DD' } overrides which day is checked
// (defaults to real yesterday, UTC). Still purely read-only either way —
// this only changes WHICH day's data is read, added specifically so
// notify-daily-ops (and any future caller) can be tested against known
// real historical dates without waiting for a real problem day to occur.
//
// Checks (all against the SAME target date, UTC, matching this project's
// other daily cron jobs — every check below uses the identical
// [targetDate 00:00:00, targetDate 23:59:59.999] window, not a mix of
// calendar-day and rolling windows. Fixed 14 Aug 2026: check 5 previously
// used a rolling "last 24h from now" window on real (non-override) runs
// while every other check used the fixed calendar day, so on at least one
// occasion the emailed report attributed errors timestamped just after
// midnight on the FOLLOWING day to the report's own dated subject line —
// confusing, and inconsistent with the report's single stated date_checked.
// All five checks now agree on one window, matching the report's own dated
// subject line in notify-daily-ops):
//   1. Each of the 3 outreach brands (ps, quill, yca) logged outreach
//      volume — flags a brand with ZERO emails_sent, since no "expected
//      daily volume" target is stored anywhere in this schema to compare
//      against; zero-send silence is the honest, defensible signal
//      available, not a guessed number.
//   2. cron-healthcheck's own most recent run — surfaces whatever it found
//      (errors array) and flags if cron-healthcheck itself hasn't run
//      recently (a healthcheck-of-the-healthcheck).
//      IMPORTANT: this is a relay of cron-healthcheck's SINGLE latest run,
//      not a query scoped to targetDate — cron-healthcheck runs once a day
//      totally independently of daily-ops-check's own target date (which
//      can be overridden for testing). So `reported_errors` can genuinely
//      be a day or more old by the time a reader sees it. last_run_at /
//      hours_since_last_run are included specifically so a reader (or the
//      notify-daily-ops email built from this) can tell "flagged N hours
//      ago" instead of assuming it's a brand-new finding for targetDate.
//   3. 2-3 real invoice-chase sends from the target date, pulled from
//      invoice_chaser_log specifically (the only table with both real
//      sent_at AND resend_id — original invoice/quote sends via
//      send-invoice/quote-send don't capture resend_id at all, a known,
//      separate gap, not something this check tries to paper over).
//      Zero rows is only flagged once process-invoice-chases (yca-platform,
//      scheduled 09:00 UTC daily) has actually had its chance to run for
//      targetDate — see the "chase cron" guard below. Under the real daily
//      schedule targetDate is always yesterday, so this is always true; it
//      exists for a manual re-check of TODAY, before 09:00 UTC has passed.
//   4. Every contact created on the target date, across all non-demo
//      accounts, with no email and no accounts_email on file.
//   5. edge_function_errors on the target date (the same calendar day as
//      every other check, not a rolling 24h window), grouped by
//      function_name — EXCLUDING any row whose timestamp falls inside a
//      matching ops_known_events window (a recorded platform
//      restart/incident, or deliberate test activity — see migration
//      20260829120000 and _shared/opsKnownEvents.ts). Those are reported
//      separately as "explained", not mixed into what needs action.
//   6. Total voice-to-quote spend on the target date, from yca-platform's
//      voice_quote_costs ledger (same shared database), flagged only when it
//      crosses a daily threshold. Reported either way so a normal day's cost
//      is visible for context rather than only appearing when it is a problem.
//
// Deploy: supabase functions deploy daily-ops-check
// Schedule: 30 10 * * * (30 min after cron-healthcheck's own 10:00 UTC run)
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { checkCronAuth } from '../_shared/cronAuth.ts'

// deno-lint-ignore no-explicit-any
type Admin = any

serve(async (req) => {
  // Uses the shared cronAuth helper rather than its own inline copy.
  //
  // This function previously duplicated the auth block, reading CRON_SECRET
  // straight from the environment. That went unnoticed when the cron secret
  // moved into Vault (16 Aug 2026) precisely because this file existed only
  // as a deployed function and in no repo — so the sweep that updated every
  // other scheduled function could not see it, and unsetting the old env var
  // left this returning 401 on every run until it was found and versioned.
  // Sharing the helper is what stops a repeat: the cron auth rule now lives
  // in exactly one place, and this function sits somewhere a sweep finds it.
  const auth = await checkCronAuth(req, 'daily-ops-check')
  if (!auth.authorised) return auth.response!

  let body: { date?: string } = {}
  try { body = await req.json() } catch { /* no body = real yesterday */ }

  const admin: Admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)

  const report: Record<string, unknown> = {}
  let anyFlag = false

  // ── 0. The one shared window every check below uses ──────────────
  const targetDate = body.date || new Date(Date.now() - 86400000).toISOString().slice(0, 10)
  const windowStart = `${targetDate}T00:00:00.000Z`
  const windowEnd = `${targetDate}T23:59:59.999Z`

  // ── 1. Outreach brand volume ────────────────────────────────────────
  const BRANDS = ['ps', 'quill', 'yca']
  const { data: outreachRows } = await admin
    .from('outreach_daily_log')
    .select('brand, emails_sent')
    .eq('date', targetDate)

  const brandTotals: Record<string, number> = { ps: 0, quill: 0, yca: 0 }
  for (const r of outreachRows ?? []) {
    const b = (r.brand as string) ?? ''
    if (b in brandTotals) brandTotals[b] += (r.emails_sent as number) ?? 0
  }
  const outreachFlags = BRANDS.filter((b) => brandTotals[b] === 0)
  if (outreachFlags.length) anyFlag = true
  report.outreach = {
    date_checked: targetDate,
    note: 'No stored "expected daily volume" exists in this schema — flags zero-send silence only, not a target comparison.',
    totals: brandTotals,
    flagged_zero_send: outreachFlags,
  }

  // ── 2. cron-healthcheck's own latest run ──────────────────────────
  const { data: chcRows } = await admin
    .from('mkt_cron_log')
    .select('created_at, errors, notes')
    .eq('job_name', 'cron-healthcheck')
    .order('created_at', { ascending: false })
    .limit(1)
  const chc = chcRows?.[0] ?? null
  const chcLastRunAt = chc?.created_at ?? null
  const chcHoursSince = chc ? (Date.now() - new Date(chc.created_at as string).getTime()) / 3600000 : null
  const chcHoursSinceRounded = chcHoursSince === null ? null : Math.round(chcHoursSince * 10) / 10
  const chcStale = chcHoursSince === null || chcHoursSince > 26
  const chcErrors = (chc?.errors ?? []) as unknown[]
  const chcHasErrors = !!chcErrors.length
  if (chcStale || chcHasErrors) anyFlag = true
  report.cron_healthcheck = {
    last_run_at: chcLastRunAt,
    hours_since_last_run: chcHoursSinceRounded,
    stale: chcStale,
    reported_errors: chcErrors,
    // Explicit, self-contained label so any consumer of this report (the
    // notify-daily-ops email, a future dashboard, a human reading raw JSON)
    // can tell at a glance whether reported_errors is a fresh finding or a
    // relay of a run from hours/days ago — see the check-2 comment above.
    reported_errors_age_label: chcHasErrors
      ? (chcLastRunAt === null
        ? 'cron-healthcheck has never run — age unknown'
        : `from cron-healthcheck's run at ${chcLastRunAt} (${chcHoursSinceRounded}h ago) — not necessarily a new finding today`)
      : null,
  }

  // ── 3. Real invoice-chase send evidence from the target date ───────
  const { data: chaseRows } = await admin
    .from('invoice_chaser_log')
    .select('invoice_id, account_id, stage, sent_at, resend_id')
    .gte('sent_at', windowStart)
    .lt('sent_at', windowEnd)
    .order('sent_at', { ascending: false })
    .limit(3)
  const chaseSample = (chaseRows ?? []).map((r: Record<string, unknown>) => ({
    invoice_id: r.invoice_id,
    account_id: r.account_id,
    stage: r.stage,
    sent_at: r.sent_at,
    resend_id: r.resend_id,
    has_real_evidence: !!(r.sent_at && r.resend_id),
  }))
  // Has process-invoice-chases (yca-platform, `0 9 * * *` UTC — see that
  // function's own deploy-schedule comment) actually had its chance to run
  // for targetDate yet? Always true when targetDate is a past calendar day
  // (the real daily schedule: this function checks yesterday, at 10:30 UTC,
  // over an hour after that cron's 09:00 run). Only matters for a manual
  // re-check with `date` set to today — before 09:10 UTC (09:00 + a small
  // grace period for the job to finish) that cron simply hasn't run yet
  // today, so zero rows means "not due", not "missing".
  const todayUtc = new Date().toISOString().slice(0, 10)
  const chaseCronHasHadChance = targetDate < todayUtc
    ? true
    : targetDate > todayUtc
      ? false
      : new Date() >= new Date(`${targetDate}T09:10:00.000Z`)

  const noEvidence = chaseSample.length === 0 && chaseCronHasHadChance
  if (noEvidence) anyFlag = true
  report.invoice_chase_evidence = {
    date_checked: targetDate,
    scope: 'invoice_chaser_log only — original invoice/quote sends via send-invoice/quote-send do not capture resend_id at all (known, separate gap)',
    sample: chaseSample,
    chase_cron_has_had_chance_to_run: chaseCronHasHadChance,
    flagged_no_evidence_found: noEvidence,
  }

  // ── 4. Contacts created on the target date with no email on file ─────
  const { data: contactRows } = await admin
    .from('contacts')
    .select('id, account_id, first_name, last_name, business_name, email, accounts_email, created_at, accounts!inner(demo_mode)')
    .gte('created_at', windowStart)
    .lt('created_at', windowEnd)

  const missingEmailContacts = (contactRows ?? [])
    .filter((c: Record<string, unknown>) => {
      const acct = c.accounts as { demo_mode?: boolean } | undefined
      if (acct?.demo_mode) return false
      const email = ((c.email as string) ?? '').trim()
      const accountsEmail = ((c.accounts_email as string) ?? '').trim()
      return !email && !accountsEmail
    })
    .map((c: Record<string, unknown>) => ({
      id: c.id,
      account_id: c.account_id,
      name: [c.first_name, c.last_name].filter(Boolean).join(' ') || c.business_name || '(no name on file)',
      created_at: c.created_at,
    }))
  if (missingEmailContacts.length) anyFlag = true
  report.contacts_missing_email = {
    date_checked: targetDate,
    total_contacts_created: (contactRows ?? []).length,
    flagged: missingEmailContacts,
  }

  // ── 5. edge_function_errors on the target date ──────────────────
  // Same fixed calendar-day window as every other check above — previously
  // this used a rolling "last 24h from now" window on real runs, which
  // could attribute errors from just after midnight on the FOLLOWING day
  // to this report's date_checked. Fixed 14 Aug 2026.
  const { data: errorRows } = await admin
    .from('edge_function_errors')
    .select('function_name, error_message, created_at')
    .gte('created_at', windowStart)
    .lte('created_at', windowEnd)
    .order('created_at', { ascending: false })

  // Known-explained windows (ops_known_events — migration 20260829120000):
  // a recorded platform restart/incident, or deliberate test activity
  // logged via _shared/opsKnownEvents.ts's recordOpsKnownEvent(). Fetched
  // pre-filtered to windows that could plausibly cover this target date;
  // the per-error match below still checks each error's own timestamp
  // (and function_name scope) individually rather than trusting the
  // pre-filter alone.
  const { data: knownEventRows } = await admin
    .from('ops_known_events')
    .select('starts_at, ends_at, function_name, reason')
    .lte('starts_at', windowEnd)
    .gte('ends_at', windowStart)

  function explainError(createdAt: string, functionName: string | null) {
    const t = new Date(createdAt).getTime()
    for (const ev of knownEventRows ?? []) {
      if (ev.function_name && ev.function_name !== functionName) continue
      const start = new Date(ev.starts_at as string).getTime()
      const end = new Date(ev.ends_at as string).getTime()
      if (t >= start && t <= end) return ev
    }
    return null
  }

  const unexplainedErrors: Record<string, unknown>[] = []
  const explainedErrors: Record<string, unknown>[] = []
  for (const e of (errorRows ?? []) as Record<string, unknown>[]) {
    const match = explainError(e.created_at as string, (e.function_name as string) ?? null)
    if (match) {
      explainedErrors.push({
        function_name: e.function_name,
        error_message: e.error_message,
        created_at: e.created_at,
        reason: match.reason,
        explained_window: [match.starts_at, match.ends_at],
      })
    } else {
      unexplainedErrors.push(e)
    }
  }

  const byFunction: Record<string, number> = {}
  for (const e of unexplainedErrors) {
    const fn = (e.function_name as string) ?? '(unknown)'
    byFunction[fn] = (byFunction[fn] ?? 0) + 1
  }
  // Only genuinely unexplained errors trip the flag — an error fully
  // covered by a known-event window is real evidence a human already ruled
  // out, not a fresh finding.
  if (unexplainedErrors.length > 0) anyFlag = true
  report.edge_function_errors_window = {
    date_checked: targetDate,
    window: [windowStart, windowEnd],
    total: (errorRows ?? []).length,
    unexplained_total: unexplainedErrors.length,
    by_function: byFunction,
    // Full detail capped to keep the response reasonable — count above is
    // the real total regardless of how many are shown here.
    recent: unexplainedErrors.slice(0, 20),
    // Kept separate, never merged into `recent`/`by_function` above — see
    // the check-5 comment at the top of this file.
    explained_total: explainedErrors.length,
    explained: explainedErrors.slice(0, 20),
  }

  // ── 6. Voice-to-quote spend on the target date ──────────────────
  // yca-platform's voice-to-quote feature bills per minute of audio (OpenAI)
  // and per token (Anthropic) on every use. voice_quote_costs is its ledger,
  // written by the two edge functions in that repo; this reads it and nothing
  // else, in keeping with this function's read-only rule.
  //
  // Lives here rather than in a separate monitor because the two projects
  // share one Supabase database and Adrian already reads exactly one ops
  // email a day — a second daily email for one feature's spend would be a
  // worse signal, not a better one.
  //
  // The per-ACCOUNT daily cap (10 recordings + 10 drafts, enforced in
  // yca-platform) already bounds any single account. What it cannot bound is
  // the total across every account at once, which is what this threshold
  // watches. Set at £5/day: comfortably above a normal day even with several
  // accounts working hard, low enough that a runaway loop shows up the next
  // morning rather than at the end of the month.
  const VOICE_QUOTE_DAILY_THRESHOLD_PENCE = 500

  const { data: voiceCostRows } = await admin
    .from('voice_quote_costs')
    .select('account_id, kind, cost_pence, created_at')
    .gte('created_at', windowStart)
    .lte('created_at', windowEnd)

  let voiceTotalPence = 0
  const voiceByAccount: Record<string, number> = {}
  const voiceByKind: Record<string, number> = {}
  for (const r of voiceCostRows ?? []) {
    const pence = Number(r.cost_pence ?? 0)
    if (!Number.isFinite(pence)) continue
    voiceTotalPence += pence
    const acct = (r.account_id as string) ?? '(unknown)'
    voiceByAccount[acct] = (voiceByAccount[acct] ?? 0) + pence
    const kind = (r.kind as string) ?? '(unknown)'
    voiceByKind[kind] = (voiceByKind[kind] ?? 0) + pence
  }
  const round2 = (p: number) => Math.round(p * 100) / 100
  const voiceOverThreshold = voiceTotalPence > VOICE_QUOTE_DAILY_THRESHOLD_PENCE
  if (voiceOverThreshold) anyFlag = true
  report.voice_quote_spend = {
    date_checked: targetDate,
    window: [windowStart, windowEnd],
    calls: (voiceCostRows ?? []).length,
    total_pence: round2(voiceTotalPence),
    threshold_pence: VOICE_QUOTE_DAILY_THRESHOLD_PENCE,
    // Only flagged when the threshold is actually crossed — a normal day's
    // spend is reported for context, not treated as an issue to act on.
    flagged_over_threshold: voiceOverThreshold,
    by_kind: Object.fromEntries(Object.entries(voiceByKind).map(([k, v]) => [k, round2(v)])),
    // Accounts, biggest spender first — when the threshold does fire, the
    // useful next question is always "which account", so the answer is in
    // the report rather than requiring a follow-up query.
    by_account: Object.entries(voiceByAccount)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([account_id, pence]) => ({ account_id, pence: round2(pence) })),
  }

  return new Response(JSON.stringify({ ok: true, checked_at: new Date().toISOString(), any_flag: anyFlag, report }), {
    headers: { 'Content-Type': 'application/json' },
  })
})
