// Supabase Edge Function: send-rejected-digest  (Deno) — runs 07:00 Europe/
// London daily via pg_cron. Emails hello@yourcompanyai.co.uk a plain-text
// summary of every post rejected in the last 24 hours, across all brands.
// Sends nothing if there were no rejections in that 24h window.
//
// Also scans a separate, wider 30-day window for a brand+reason pair whose
// rejection reason is an EXACT match (case-insensitive, trimmed — no
// semantic clustering) 3+ times, and prepends a highlighted "RECURRING
// PATTERN" section to the email when one is found. This only ever adds a
// section to an email that was already going out on the 24h trigger above —
// it does not change whether the digest sends.
//
// The detection itself (grouping, threshold, the GENERIC_REASON exclusion,
// and surfacing mkt_content_queue.rejection_feedback_used as evidence of
// whether the content-quality feedback loop had already caught this exact
// problem) lives in _shared/recurringRejectionPatterns.ts, shared with
// generate-daily-status — the same analysis appears in the dashboard JSON
// as recurring_rejection_patterns, not just this standalone email.
//
// Body params (all optional):
//   { force: true }   -> bypass the London-07:00 check (manual/test runs).
//
// Auth: service_role only (called by pg_cron; guarded here too) — same
// pattern as send-weekly-brief. See 38_rejected_digest_cron.sql for the
// cron registration; it needs the project's service_role key in its
// Authorization header, which is intentionally NOT handled by this session
// (that's a live credential — see the migration file's header comment for
// the manual step this leaves for you).
// Deploy: supabase functions deploy send-rejected-digest
// Secrets (vault): RESEND_API_KEY.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { checkCronAuth } from '../_shared/cronAuth.ts'
import { findRecurringRejectionPatterns, PATTERN_LOOKBACK_DAYS, PATTERN_THRESHOLD } from '../_shared/recurringRejectionPatterns.ts'
// Display-only UK-local formatting — see _shared/ukTime.ts. The 24h and
// 30-day query windows below stay UTC.
import { formatUkDate, formatUkTime } from '../_shared/ukTime.ts'

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
const FROM = 'Your Company AI <hello@yourcompanyai.co.uk>'
const TO = 'hello@yourcompanyai.co.uk'

// UK-local. This was a bare toLocaleDateString, which formats in the
// runtime's own timezone — UTC on Supabase Edge — so a post scheduled just
// after UK midnight during BST was reported under the previous day.
function dateLabel(d: Date): string {
  return formatUkDate(d, { day: 'numeric', month: 'long', year: 'numeric' })
}

serve(async (req) => {
  const json = (b: unknown, s = 200) =>
    new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } })
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })

  const auth = await checkCronAuth(req, 'send-rejected-digest')
  if (!auth.authorised) return auth.response!

  let body: Record<string, unknown> = {}
  try { body = await req.json() } catch { /* no body */ }

  // DST-safe 07:00 Europe/London — pg_cron is UTC-only, so this function is
  // scheduled at both 06:00 and 07:00 UTC daily; only the invocation where
  // London local time is actually 07:00 sends. See 38_rejected_digest_cron.sql.
  if (body?.force !== true) {
    const londonHour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour: 'numeric', hour12: false }).format(new Date()))
    if (londonHour !== 7) return json({ ok: true, skipped: `not 07:00 in London (currently ${londonHour}:00)` })
  }

  try {
    const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()

    const { data: rejected, error } = await admin
      .from('mkt_content_queue')
      .select('platform, pillar, body, scheduled_for, rejection_reason, rejected_at, client:mkt_clients(name, short_name)')
      .eq('status', 'rejected')
      .gte('rejected_at', since)
      .order('rejected_at', { ascending: true })
    if (error) throw new Error(`query failed: ${error.message}`)

    if (!rejected || rejected.length === 0) {
      console.log('[send-rejected-digest] no rejections in the last 24 hours — nothing to send')
      return json({ ok: true, sent: false, count: 0 })
    }

    // 30-day recurring-pattern scan — a wider, independent query from the 24h
    // list above. Grouped per brand+reason (not globally by reason alone) so
    // the flag reads as "this brand keeps hitting this exact wall", the same
    // scope recentRejectionFeedback() already reasons about per client.
    const patternSince = new Date(Date.now() - PATTERN_LOOKBACK_DAYS * 24 * 60 * 60 * 1000).toISOString()
    const { data: recent30d, error: patternError } = await admin
      .from('mkt_content_queue')
      .select('rejection_reason, rejection_feedback_used, client:mkt_clients(name, short_name)')
      .eq('status', 'rejected')
      .gte('rejected_at', patternSince)
      .not('rejection_reason', 'is', null)
    if (patternError) console.error(`[send-rejected-digest] 30-day pattern query failed: ${patternError.message}`)

    const patterns = findRecurringRejectionPatterns(recent30d ?? [])
    const patternSection = patterns.length
      ? `${'='.repeat(60)}\n⚠ RECURRING PATTERN — same rejection reason ${PATTERN_THRESHOLD}+ times in the last ${PATTERN_LOOKBACK_DAYS} days\n${'='.repeat(60)}\n` +
        patterns.map((p) => {
          const header = `${p.brand}: "${p.reason}" — rejected ${p.count}× in the last ${PATTERN_LOOKBACK_DAYS} days`
          if (!p.rejection_feedback_used) {
            return `${header}\n  No prior rejection feedback was fed into generation for any of these — the feedback loop hadn't caught this yet.`
          }
          const evidence = p.feedback_examples.map((f) => `  Already told to avoid this, fed into generation, still recurred: "${f}"`).join('\n')
          return `${header}\n${evidence}`
        }).join('\n\n') +
        `\n${'='.repeat(60)}\n\n`
      : ''

    const now = new Date()
    const blocks = rejected.map((p) => {
      const brand = p.client?.short_name || p.client?.name || 'Unknown brand'
      // Slot time included, UK-local with its BST/GMT label — a rejected
      // post's slot is part of judging whether the rejection was right.
      const scheduled = p.scheduled_for
        ? `${dateLabel(new Date(p.scheduled_for))}, ${formatUkTime(p.scheduled_for)}`
        : 'no date set'
      const preview = String(p.body || '').slice(0, 100) + (String(p.body || '').length > 100 ? '…' : '')
      return [
        `Brand: ${brand}`,
        `Scheduled: ${scheduled}`,
        `Pillar: ${p.pillar || '—'}`,
        `Post: ${preview}`,
        `Reason: ${p.rejection_reason || 'No reason given.'}`,
      ].join('\n')
    })
    const text = `Rejected posts — last 24 hours (${rejected.length})\n\n${patternSection}${blocks.join('\n\n---\n\n')}\n`

    const resendKey = Deno.env.get('RESEND_API_KEY')
    if (!resendKey) {
      console.error('[send-rejected-digest] RESEND_API_KEY not configured — cannot send')
      return json({ error: 'RESEND_API_KEY not configured' }, 500)
    }
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: FROM, to: TO, subject: `Quill — Rejected posts digest — ${dateLabel(now)}`, text }),
    })
    if (!r.ok) {
      const detail = await r.text()
      console.error(`[send-rejected-digest] Resend rejected the email: ${detail}`)
      return json({ error: 'Resend rejected the email.', detail }, 502)
    }
    console.log(`[send-rejected-digest] sent — ${rejected.length} rejected post(s)`)
    return json({ ok: true, sent: true, count: rejected.length })
  } catch (e) {
    console.error(`[send-rejected-digest] fatal: ${String((e as Error)?.message ?? e)}`)
    return json({ error: String((e as Error)?.message ?? e) }, 500)
  }
})
