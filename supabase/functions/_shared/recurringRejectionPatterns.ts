// Recurring rejection-pattern detection, shared by send-rejected-digest (the
// standalone email) and generate-daily-status (the dashboard JSON export).
// Extracted rather than duplicated so the two surfaces can never quietly
// drift into disagreeing about what counts as a pattern.
//
// A brand+reason pair whose rejection reason is an EXACT match
// (case-insensitive, trimmed — no semantic clustering) 3+ times in the last
// 30 days counts as a recurring pattern. Grouped per brand+reason, not
// globally by reason alone, so it reads as "this brand keeps hitting this
// exact wall" — the same scope recentRejectionFeedback() already reasons
// about per client.
//
// Deliberately excludes GENERIC_REASON: a one-tap "Rejected by Adrian" with
// no specific reason carries no learnable signal and must never count toward
// a pattern.

export const PATTERN_LOOKBACK_DAYS = 30
export const PATTERN_THRESHOLD = 3
export const GENERIC_REASON = 'Rejected by Adrian'

// client is left as `any` rather than a nominal object type, matching this
// codebase's existing convention for a supabase-js embedded FK relation
// (see generate-daily-status's own nameOf() and its Record<string, any> row
// casts) — the client library's inferred type for client:mkt_clients(...)
// disagrees with its actual single-object runtime shape for a many-to-one
// relation, a known, already-tolerated mismatch elsewhere in this repo.
// deno-lint-ignore no-explicit-any
type RejectedRow = {
  rejection_reason: string | null
  rejection_feedback_used: string | null
  client: any
}

export type RecurringPattern = {
  brand: string
  reason: string
  count: number
  // Whether ANY post in this pattern had rejection-feedback text fed into
  // its own generation — i.e. the content-quality feedback loop had already
  // told the model to avoid this exact problem before it kept recurring
  // anyway, versus not having caught it yet.
  rejection_feedback_used: boolean
  // The distinct feedback text(s) actually seen, as evidence — empty when
  // rejection_feedback_used is false.
  feedback_examples: string[]
}

// rejection_reason, rejection_feedback_used (mkt_content_queue) holds the
// exact rejection-feedback string that was fed into THAT post's own prompt
// at generation time, or null if there was none — see
// _shared/rejectionFeedback.ts for where it's written.
export function findRecurringRejectionPatterns(rows: RejectedRow[]): RecurringPattern[] {
  const counts = new Map<string, { brand: string; reason: string; n: number; feedbackSeen: Set<string> }>()

  for (const row of rows) {
    const reason = String(row.rejection_reason ?? '').trim()
    if (!reason || reason === GENERIC_REASON) continue
    const brand = row.client?.short_name || row.client?.name || 'Unknown brand'
    const key = `${brand.toLowerCase()}::${reason.toLowerCase()}`
    const feedback = row.rejection_feedback_used ? String(row.rejection_feedback_used).trim() : null

    const existing = counts.get(key)
    if (existing) {
      existing.n++
      if (feedback) existing.feedbackSeen.add(feedback)
    } else {
      counts.set(key, { brand, reason, n: 1, feedbackSeen: feedback ? new Set([feedback]) : new Set() })
    }
  }

  return [...counts.values()]
    .filter((p) => p.n >= PATTERN_THRESHOLD)
    .sort((a, b) => b.n - a.n)
    .map((p) => ({
      brand: p.brand,
      reason: p.reason,
      count: p.n,
      rejection_feedback_used: p.feedbackSeen.size > 0,
      feedback_examples: [...p.feedbackSeen],
    }))
}
