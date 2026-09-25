// One-off repair tool: fill in a queued post whose body is empty.
//
// NOT part of the pipeline, not called by any cron, and DELIBERATELY LEFT
// UNDEPLOYED — same convention as image-harness and crhq-voice-harness:
//
//   supabase functions deploy regenerate-blank-post --project-ref <ref>
//   …repair the rows…
//   supabase functions delete regenerate-blank-post --project-ref <ref>
//
// WHY IT EXISTS. On 24 Sep 2026 the Anthropic account hit its usage cap
// mid-run. Both generation attempts failed, review.body was '', and
// _shared/fill.ts wrote `body: review.body || ''` — queueing posts with no
// text at all, holding real slots. That bug is fixed (commit a6c1979: an
// empty body is now a real error and no row is written), but the rows it
// already created are still sitting in the queue, and a slot that will
// publish nothing is worth repairing rather than voiding: the schedule, the
// pillar and the brand's cadence were all correct — only the copy is missing.
//
// It regenerates IN PLACE — same row, same slot, same platform, same pillar —
// through generateReviewedPost, the exact function fill.ts calls, with the
// same context fill.ts attaches (recent topics, repeat prevention, topics to
// avoid, optimisation notes, rejection feedback, blog context). So the copy
// that lands is the copy the nightly run would have produced, reviewed by the
// same rules, including the CRHQ voice rules added in a6c1979 (which are
// brand-scoped and simply no-op for other brands — that is the point of
// running these two non-CRHQ rows through it).
//
// SAFETY: only ever touches rows that are genuinely blank, still in the
// future, and not rejected. A row that already has copy is never overwritten
// — if the body is non-empty it is skipped and reported, so this cannot
// clobber a human's edit. dry_run returns what it WOULD write without
// touching anything.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { generateReviewedPost } from '../_shared/review.ts'
import { recentBrandPosts, recentTopics as recentTopicLabels } from '../_shared/recentSubjects.ts'
import { recentPublishedSummaries, stripMarkdown } from '../_shared/generate.ts'
import { latestOptimisationNotes } from '../_shared/optimisation.ts'
import { recentRejectionFeedback } from '../_shared/rejectionFeedback.ts'
import { recentPublishedBlog } from '../_shared/fill.ts'
import { checkCronAuth } from '../_shared/cronAuth.ts'

// deno-lint-ignore no-explicit-any
type Admin = any

serve(async (req) => {
  const auth = await checkCronAuth(req, 'regenerate-blank-post')
  if (!auth.authorised) return auth.response ?? new Response('unauthorised', { status: 401 })

  const admin: Admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
  // rounds: generateReviewedPost allows 2 generation attempts per call, which
  // is right for the nightly run (it queues a needs_attention post and moves
  // on). A repair is different: the row already exists and already failed
  // once, so it is worth a few more rounds to land copy that actually passes
  // review rather than replacing a blank post with a flagged one. The best
  // result across the rounds is what gets written — a passing post if any
  // round produced one, otherwise the last one, flagged, which is still
  // strictly better than an empty body.
  const { ids = [], dry_run = false, rounds = 1 } = await req.json().catch(() => ({}))
  const maxRounds = Math.min(Math.max(Number(rounds) || 1, 1), 4)
  if (!Array.isArray(ids) || ids.length === 0) {
    return new Response(JSON.stringify({ error: 'ids: string[] required' }), { status: 400, headers: { 'Content-Type': 'application/json' } })
  }

  const out: Array<Record<string, unknown>> = []

  for (const id of ids as string[]) {
    const { data: row, error: rowErr } = await admin.from('mkt_content_queue')
      .select('id, client_id, platform, pillar, body, status, scheduled_for, review_status')
      .eq('id', id).maybeSingle()
    if (rowErr || !row) { out.push({ id, skipped: `row not found${rowErr ? `: ${rowErr.message}` : ''}` }); continue }
    if (String(row.body ?? '').trim()) { out.push({ id, skipped: 'row already has copy — never overwritten' }); continue }
    if (row.status === 'rejected') { out.push({ id, skipped: 'row is rejected' }); continue }
    if (new Date(row.scheduled_for).getTime() <= Date.now()) { out.push({ id, skipped: 'slot is in the past — left as a historical fact' }); continue }

    const { data: client } = await admin.from('mkt_clients').select('*').eq('id', row.client_id).maybeSingle()
    if (!client) { out.push({ id, skipped: 'client not found' }); continue }

    // Exactly the context fill.ts builds, in the same order.
    const [recentPosts, avoidTopics, optimisationNotes, rejectionFeedback, recentTopics, recentBlog] = await Promise.all([
      recentBrandPosts(admin, client.id, { days: 60, limit: 30 }),
      recentTopicLabels(admin, client.id, { days: 30, limit: 12 }),
      latestOptimisationNotes(admin, client.id),
      recentRejectionFeedback(admin, client.id),
      recentPublishedSummaries(admin, client.id, 30),
      recentPublishedBlog(admin, client.id, 7),
    ])

    const forGeneration = {
      ...client,
      _recent_topics: recentTopics,
      _optimisation_notes: optimisationNotes,
      _rejection_feedback: rejectionFeedback,
      _repeat_prevention_posts: recentPosts.map((r: { body: string }) => r.body),
      _topics_to_avoid: avoidTopics,
      _blog_context: { recentBlog },
    }

    let review = await generateReviewedPost(admin, forGeneration, row.platform, row.pillar)
    const roundReasons: string[] = review.ok ? [] : [`round 1: ${review.reason ?? 'failed'}`]
    for (let round = 2; round <= maxRounds && !review.ok; round++) {
      // Each failed attempt is itself shown to the next round as something
      // not to re-tread — the same signal the nightly run gives the second
      // platform on the same night.
      if (review.body) forGeneration._repeat_prevention_posts = [review.body, ...forGeneration._repeat_prevention_posts]
      review = await generateReviewedPost(admin, forGeneration, row.platform, row.pillar)
      if (!review.ok) roundReasons.push(`round ${round}: ${review.reason ?? 'failed'}`)
    }

    const body = review.body ? stripMarkdown(review.body) : ''
    const result: Record<string, unknown> = {
      id, client: client.name, platform: row.platform, pillar: row.pillar,
      scheduled_for: row.scheduled_for,
      review_ok: review.ok, review_reason: review.reason, attempts: review.attempts,
      rounds_used: roundReasons.length + (review.ok ? 1 : 0), failed_rounds: roundReasons,
      topic: review.topic, words: body ? body.trim().split(/\s+/).length : 0, body,
    }

    // The same rule the pipeline now follows: an empty body is never written.
    if (!body.trim()) {
      result.written = false
      result.error = `generation produced no text after ${review.attempts} attempt(s): ${review.reason ?? 'unknown'}`
      out.push(result); continue
    }
    if (dry_run) { result.written = false; result.dry_run = true; out.push(result); continue }

    const { error: updErr } = await admin.from('mkt_content_queue').update({
      body,
      review_status: review.ok ? 'passed' : 'needs_attention',
      review_reason: review.ok ? null : review.reason,
      reviewed_at: review.reviewedAt,
      generation_attempts: review.attempts,
      topic: review.topic,
      // Deliberately NOT auto-approved: these are repairs of a failure, and a
      // human should see them before they go out, whatever the brand's
      // auto_approve setting says.
      status: 'draft',
    }).eq('id', id)
    result.written = !updErr
    if (updErr) result.error = updErr.message
    out.push(result)
  }

  return new Response(JSON.stringify({ ok: true, results: out }, null, 2), { headers: { 'Content-Type': 'application/json' } })
})
