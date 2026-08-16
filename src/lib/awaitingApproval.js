// Canonical definition of "a post awaiting approval".
//
// Why this file exists: three places computed this independently, with three
// silently different definitions, so one question ("how many posts need me?")
// had three different answers on screen at the same time:
//
//   * Dashboard.jsx      — status='draft' AND (review_status='passed' OR null).
//                          Silently excluded needs_attention, so a post that
//                          FAILED review disappeared from the count entirely.
//   * ContentQueue.jsx   — the same, PLUS excluded anything whose scheduled_for
//                          was already in the past. Two silent exclusions.
//   * send-digest        — status IN ('draft','pending'), no review filter, no
//                          date filter. The most complete of the three.
//
// send-digest's is now the canonical one, and it is the right one: a post that
// failed automated review, or whose slot has passed, has NOT been dealt with.
// It still needs a human to look at it and decide — arguably more urgently
// than a clean one. Hiding it from the count doesn't make it handled, it just
// makes the number wrong and the work invisible.
//
// The subsets below exist so those cases can still get their own visual
// treatment where that's useful — but as a labelled section INSIDE the total,
// never as a silent subtraction from it.
//
// Deliberately dependency-free plain JS so it can be imported anywhere in the
// frontend without pulling in supabase/react. The Deno edge function
// (supabase/functions/send-digest) can't import across the src/ boundary
// through its own bundler, so it carries a matching constant with a pointer
// back here — see the note in that file. If the definition below ever changes,
// that one must change with it.

// The status values that mean "not yet acted on". Both are valid per
// mkt_content_queue's own CHECK constraint
// (draft/pending/approved/scheduled/published/rejected). 'pending' currently
// matches zero rows in production — nothing writes it today — but it stays in
// the definition because the constraint permits it, and a status that can
// exist but isn't counted is exactly how this class of bug starts.
export const AWAITING_APPROVAL_STATUSES = ['draft', 'pending']

export function isAwaitingApproval(item) {
  return AWAITING_APPROVAL_STATUSES.includes(item?.status)
}

// Stale = the scheduled slot is on a past calendar day. Compared by day, not
// exact timestamp, so a post scheduled for earlier THIS morning is not stale —
// its day is still live. A post with no scheduled_for is never stale; there is
// nothing to have missed.
export function isStale(item, now = new Date()) {
  if (!item?.scheduled_for) return false
  const startOfToday = new Date(now)
  startOfToday.setHours(0, 0, 0, 0)
  return new Date(item.scheduled_for) < startOfToday
}

// Which labelled section an awaiting post belongs in.
//
// Review state is checked before staleness on purpose: a post that failed
// review has a content problem that has to be resolved whatever its date, so
// that's the more useful thing to show the reader. A stale needs_attention
// post therefore reports as 'needs_attention', not 'stale'.
export function awaitingBucket(item, now = new Date()) {
  if (item?.review_status === 'needs_attention') return 'needs_attention'
  if (item?.review_status === 'blog_dependent') return 'blog_dependent'
  if (isStale(item, now)) return 'stale'
  return 'ready'
}

// Splits a full item list into the canonical total plus its labelled subsets.
// Every subset is a slice of `all` — the four always sum back to it exactly,
// which is the property that makes the displayed total trustworthy.
export function partitionAwaiting(items = [], now = new Date()) {
  const all = items.filter(isAwaitingApproval)
  const ready = []
  const needsAttention = []
  const blogDependent = []
  const stale = []

  for (const item of all) {
    switch (awaitingBucket(item, now)) {
      case 'needs_attention': needsAttention.push(item); break
      case 'blog_dependent': blogDependent.push(item); break
      case 'stale': stale.push(item); break
      default: ready.push(item)
    }
  }

  return { all, ready, needsAttention, blogDependent, stale, total: all.length }
}

// Applies the canonical status filter to a supabase-js query builder, so a
// server-side count (Dashboard) and a client-side filter (ContentQueue) can
// never drift apart the way they just did.
export function applyAwaitingApprovalFilter(query) {
  return query.in('status', AWAITING_APPROVAL_STATUSES)
}
