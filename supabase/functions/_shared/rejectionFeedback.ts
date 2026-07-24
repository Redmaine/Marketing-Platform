// Shared lookup for the content-quality feedback loop — reads the last 30 days
// of rejection reasons for a client from mkt_content_queue and returns a short
// deduplicated summary string that buildSystemPrompt (prompts.ts) folds into
// generation, so the model steers away from whatever kept getting a brand's
// posts rejected. Read by fill.ts and crhq-nightly-content before generating,
// exactly like latestOptimisationNotes (see optimisation.ts).
//
// The generic quick-reject reason 'Rejected by Adrian' (ContentQueue.jsx's
// one-tap reject, which carries no learnable signal) is filtered out — only
// substantive, human-written reasons are surfaced. Returns null (a no-op for
// the prompt) when there are none, so a brand with a clean 30 days, or one
// whose only rejections were quick-rejects, generates with nothing extra
// appended.
// deno-lint-ignore no-explicit-any
type Admin = any

const LOOKBACK_DAYS = 30
const GENERIC_REASON = 'Rejected by Adrian'
const MAX_REASONS = 12

export async function recentRejectionFeedback(
  admin: Admin,
  clientId: string,
  days: number = LOOKBACK_DAYS,
): Promise<string | null> {
  try {
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString()
    const { data, error } = await admin
      .from('mkt_content_queue')
      .select('rejection_reason')
      .eq('client_id', clientId)
      .eq('status', 'rejected')
      .gte('rejected_at', since)
      .not('rejection_reason', 'is', null)
    if (error) {
      console.error(`[rejectionFeedback] lookup failed for client ${clientId} — ${error.message}`)
      return null
    }

    // Deduplicate case-insensitively and count how often each reason recurred,
    // so the prompt can lead with the most frequent mistakes.
    const counts = new Map<string, { reason: string; n: number }>()
    for (const row of data ?? []) {
      const reason = String(row.rejection_reason ?? '').trim()
      if (!reason || reason === GENERIC_REASON) continue
      const key = reason.toLowerCase()
      const existing = counts.get(key)
      if (existing) existing.n++
      else counts.set(key, { reason, n: 1 })
    }
    if (counts.size === 0) return null

    const ranked = [...counts.values()]
      .sort((a, b) => b.n - a.n)
      .slice(0, MAX_REASONS)
      .map(({ reason, n }) => (n > 1 ? `${reason} (rejected ${n}×)` : reason))

    return ranked.join('; ')
  } catch (e) {
    console.error(`[rejectionFeedback] lookup threw for client ${clientId} — ${String((e as Error)?.message ?? e)}`)
    return null
  }
}
