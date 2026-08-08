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

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
const FROM = 'Your Company AI <hello@yourcompanyai.co.uk>'
const TO = 'hello@yourcompanyai.co.uk'

// Recurring-pattern detection — a separate, wider lookback from the 24h
// digest body below. Exact-match only (case-insensitive, trimmed): this pass
// deliberately does NOT attempt semantic clustering of similarly-worded but
// non-identical reasons ("dated wrong" vs "wrong date") — that's out of
// scope. Mirrors the GENERIC_REASON exclusion in
// _shared/rejectionFeedback.ts's content-quality feedback loop: a one-tap
// reject carries no learnable signal and must never count toward a pattern.
const PATTERN_LOOKBACK_DAYS = 30
const PATTERN_THRESHOLD = 3
const GENERIC_REASON = 'Rejected by Adrian'

function dateLabel(d: Date): string {
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })
}

serve(async (req) => {
  const json = (b: unknown, s = 200) =>
    new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } })
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })

  // service_role only.
  const bearer = (req.headers.get('Authorization') ?? '').replace('Bearer ', '')
  let role = ''
  try { role = JSON.parse(atob(bearer.split('.')[1] || '')).role || '' } catch { /* */ }
  if (role !== 'service_role') return json({ error: 'Not authorised' }, 401)

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
      .select('rejection_reason, client:mkt_clients(name, short_name)')
      .eq('status', 'rejected')
      .gte('rejected_at', patternSince)
      .not('rejection_reason', 'is', null)
    if (patternError) console.error(`[send-rejected-digest] 30-day pattern query failed: ${patternError.message}`)

    const patternCounts = new Map<string, { brand: string; reason: string; n: number }>()
    for (const row of recent30d ?? []) {
      const reason = String(row.rejection_reason ?? '').trim()
      if (!reason || reason === GENERIC_REASON) continue
      const brand = row.client?.short_name || row.client?.name || 'Unknown brand'
      const key = `${brand.toLowerCase()}::${reason.toLowerCase()}`
      const existing = patternCounts.get(key)
      if (existing) existing.n++
      else patternCounts.set(key, { brand, reason, n: 1 })
    }
    const patterns = [...patternCounts.values()]
      .filter((p) => p.n >= PATTERN_THRESHOLD)
      .sort((a, b) => b.n - a.n)
    const patternSection = patterns.length
      ? `${'='.repeat(60)}\n⚠ RECURRING PATTERN — same rejection reason ${PATTERN_THRESHOLD}+ times in the last ${PATTERN_LOOKBACK_DAYS} days\n${'='.repeat(60)}\n` +
        patterns.map((p) => `${p.brand}: "${p.reason}" — rejected ${p.n}× in the last ${PATTERN_LOOKBACK_DAYS} days`).join('\n') +
        `\n${'='.repeat(60)}\n\n`
      : ''

    const now = new Date()
    const blocks = rejected.map((p) => {
      const brand = p.client?.short_name || p.client?.name || 'Unknown brand'
      const scheduled = p.scheduled_for ? dateLabel(new Date(p.scheduled_for)) : 'no date set'
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
