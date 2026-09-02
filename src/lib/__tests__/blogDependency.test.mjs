// Run: node src/lib/__tests__/blogDependency.test.mjs
//
// Fixtures are real production rows (ids and field values copied verbatim
// from mkt_content_queue / mkt_blog_posts on 2 Sep 2026), not invented
// shapes — each case notes where it came from. The population-level claim
// ("38 posts were falsely blocked, now 0") is verified separately in SQL;
// this file pins the RULE those numbers come from.
import {
  blogOutcome, isBlogLinked, mentionsBlogWithoutLink, pickRelatedBlog,
  blogBlockStateFor, byScheduledFor,
} from '../blogDependency.js'

let pass = 0, fail = 0
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  ok ? pass++ : fail++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`}`)
}

// Real CRHQ blogs (mkt_blog_posts, client c14ccad0), newest-first.
const CRHQ_BLOGS = [
  { id: 'b5aedd17-33b9-4de8-a228-daba4a775714', client_id: 'c14ccad0-21f8-44f0-9464-24f321bea37b', status: 'rejected' },
  { id: 'f4f3dff5-56c1-4ad0-afa9-a381ba491429', client_id: 'c14ccad0-21f8-44f0-9464-24f321bea37b', status: 'rejected' },
  { id: '8a1b7abf-426e-45fe-a280-004045bf296d', client_id: 'c14ccad0-21f8-44f0-9464-24f321bea37b', status: 'publish_unverified' },
]

// ── The reported post: CRHQ Instagram, 3 Sept, blog_id NULL ──────────────
// Real body: "...Watch the breakdown at youtube.com/... or read more at
// combatreadyhq.co.uk" — a homepage link, matching the 'read more' keyword.
const REPORTED = {
  id: '79cad7e5-4e9c-4c9b-8ebc-8cc072fea438',
  client_id: 'c14ccad0-21f8-44f0-9464-24f321bea37b',
  blog_id: null,
  review_status: 'needs_attention',
  body: "Government just announced a major policy shift without proper detail.\nCombat Ready HQ examines what's really changing and why it matters.\nWatch the breakdown at youtube.com/watch?v=YMaZRtdxhyM or read more at combatreadyhq.co.uk",
}
eq('reported post is NOT blog-linked', isBlogLinked(REPORTED), false)
eq('reported post no longer blocked / no longer "blog was rejected"',
   blogBlockStateFor(REPORTED, CRHQ_BLOGS),
   { dependent: false, blocked: false, dead: false, unlinkedMention: true })
eq('reported post still gets the advisory', mentionsBlogWithoutLink(REPORTED), true)

// ── The old fallback must no longer fire for unlinked posts ─────────────
eq('unlinked post resolves to no blog at all', pickRelatedBlog(REPORTED, CRHQ_BLOGS), null)

// ── Genuinely blog-dependent posts must STILL be gated ──────────────────
const DEPENDENT = { id: 'x', client_id: 'c14ccad0-21f8-44f0-9464-24f321bea37b', blog_id: null, review_status: 'blog_dependent', body: 'read our blog' }
eq('blog_dependent row is blog-linked', isBlogLinked(DEPENDENT), true)
eq('blog_dependent row still uses the server-matching fallback',
   pickRelatedBlog(DEPENDENT, CRHQ_BLOGS)?.id, 'b5aedd17-33b9-4de8-a228-daba4a775714')
eq('blog_dependent row on a rejected blog is still dead-blocked',
   blogBlockStateFor(DEPENDENT, CRHQ_BLOGS),
   { dependent: true, blocked: true, dead: true, unlinkedMention: false })

// Real linked row: 6bd8e155 -> blog 2d279c34 (client 51695798).
const LINKED_WAITING = { id: '6bd8e155-0dee-4fbf-aef0-bf28e8f24337', client_id: '51695798-9cbb-4a30-926d-9368c6123295', blog_id: '2d279c34-144c-4de7-805e-2fdd3538dd86', review_status: 'passed', body: 'blog' }
const DRAFT_BLOG = [{ id: '2d279c34-144c-4de7-805e-2fdd3538dd86', client_id: '51695798-9cbb-4a30-926d-9368c6123295', status: 'draft' }]
eq('explicitly linked post whose blog is a draft is still blocked',
   blogBlockStateFor(LINKED_WAITING, DRAFT_BLOG),
   { dependent: true, blocked: true, dead: false, unlinkedMention: false })

// ── The client/server drift (defect B) ──────────────────────────────────
eq('publish_unverified passes, matching server outcomeFor()', blogOutcome({ status: 'publish_unverified' }), 'pass')
eq('published passes', blogOutcome({ status: 'published' }), 'pass')
eq('rejected -> attention', blogOutcome({ status: 'rejected' }), 'attention')
eq('draft -> wait', blogOutcome({ status: 'draft' }), 'wait')
eq('no blog -> pass', blogOutcome(null), 'pass')
const LINKED_UNVERIFIED = { id: 'y', client_id: 'c', blog_id: '8a1b7abf-426e-45fe-a280-004045bf296d', review_status: 'passed', body: 'blog' }
eq('post on a publish_unverified blog is released, not left waiting',
   blogBlockStateFor(LINKED_UNVERIFIED, CRHQ_BLOGS),
   { dependent: true, blocked: false, dead: false, unlinkedMention: false })

// ── Sort: strictly by scheduled_for, nulls last, no brand grouping ──────
const rows = [
  { id: 'c', client_id: 'B', scheduled_for: null },
  { id: 'a', client_id: 'A', scheduled_for: '2026-09-10T07:00:00+00:00' },
  { id: 'd', client_id: 'B', scheduled_for: '2026-09-02T08:00:00+00:00' },
  { id: 'b', client_id: 'A', scheduled_for: '2026-09-05T19:00:00+00:00' },
]
eq('soonest first, nulls last, brands interleaved',
   [...rows].sort(byScheduledFor).map((r) => r.id), ['d', 'b', 'a', 'c'])
eq('ties are deterministic by id',
   [{ id: 'z', scheduled_for: '2026-09-05T00:00:00Z' }, { id: 'a', scheduled_for: '2026-09-05T00:00:00Z' }]
     .sort(byScheduledFor).map((r) => r.id), ['a', 'z'])

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
