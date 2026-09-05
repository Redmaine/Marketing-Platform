// Proof for _shared/recentSubjects.ts.
// Run: deno run supabase/functions/_shared/__tests__/recentSubjects.test.ts
//
// The fixtures are REAL post copy from mkt_content_queue for the two brands in
// the 5 Sep 2026 incident, and the status/table mix is the real one too: at the
// time of writing Quill — LinkedIn had 3 rows in published_posts and 33 in the
// queue, none of them ever at status='approved'. That combination is the whole
// bug, so it is what the fake client below returns.
import { recentBrandPosts, recentTopics, topicsToAvoidBlock } from '../recentSubjects.ts'

let pass = 0, fail = 0
const ok = (cond: boolean, label: string, extra = '') => {
  if (cond) { pass++; console.log(`PASS  ${label}`) }
  else { fail++; console.log(`FAIL  ${label}${extra ? `\n        ${extra}` : ''}`) }
}

// Minimal stand-in for the Supabase client, recording the filters applied so
// the test can assert on the QUERY, not just the rows. That matters here: the
// bug being fixed was a filter (status='approved') that silently matched
// nothing, which no amount of row-level assertion would have caught.
function fakeAdmin(tables: Record<string, Record<string, unknown>[]>) {
  const calls: Record<string, Record<string, unknown>> = {}
  return {
    calls,
    from(table: string) {
      const state: Record<string, unknown> = { table, eq: {}, neq: {}, notNull: [] }
      calls[table] = state
      let rows = [...(tables[table] ?? [])]
      const api = {
        select: () => api,
        eq: (col: string, val: unknown) => { (state.eq as Record<string, unknown>)[col] = val; rows = rows.filter((r) => r[col] === val); return api },
        neq: (col: string, val: unknown) => { (state.neq as Record<string, unknown>)[col] = val; rows = rows.filter((r) => r[col] !== val); return api },
        not: (col: string, _op: string, _v: unknown) => { (state.notNull as string[]).push(col); rows = rows.filter((r) => r[col] != null); return api },
        gte: (col: string, val: string) => { rows = rows.filter((r) => String(r[col]) >= val); return api },
        lte: (col: string, val: string) => { rows = rows.filter((r) => String(r[col]) <= val); return api },
        order: () => api,
        limit: (n: number) => Promise.resolve({ data: rows.slice(0, n) }),
      }
      return api
    },
  }
}

const iso = (daysAgo: number) => new Date(Date.now() - daysAgo * 86400000).toISOString()

console.log('── The bug: nothing is ever at status=\'approved\' ──')
{
  // Exactly the real shape — drafts and scheduled rows, no 'approved' anywhere,
  // which is what made the old recentApprovedBodies query return [] forever.
  const admin = fakeAdmin({
    mkt_content_queue: [
      { body: 'Queued post about robotic picking.', created_at: iso(1), status: 'draft', client_id: 'c1' },
      { body: 'Scheduled post about vetting failures.', created_at: iso(2), status: 'scheduled', client_id: 'c1' },
      { body: 'A rejected post nobody will ever see.', created_at: iso(1), status: 'rejected', client_id: 'c1' },
    ],
    published_posts: [
      { post_copy: 'An older post that actually went out.', date_sent: iso(5), client_id: 'c1' },
    ],
  })
  const rows = await recentBrandPosts(admin, 'c1')
  const bodies = rows.map((r) => r.body)
  ok(bodies.length === 3, 'returns queued AND published content (3), not just published (1)', JSON.stringify(bodies.length))
  ok(bodies.some((b) => b.includes('robotic picking')), 'a status=draft post IS included — the old query missed every one')
  ok(bodies.some((b) => b.includes('actually went out')), 'published history still included')
  ok(!bodies.some((b) => b.includes('nobody will ever see')), 'a REJECTED post is excluded — it was thrown away')
  // The filter itself, not just its output: an allow-list of statuses is the
  // exact mistake that produced the silent no-op.
  ok((admin.calls.mkt_content_queue.neq as Record<string, unknown>).status === 'rejected',
    "the queue filter is neq('status','rejected'), never an allow-list of statuses")
  ok(!('status' in (admin.calls.mkt_content_queue.eq as Record<string, unknown>)),
    "no eq('status', ...) is applied — that is what broke before")
}

console.log('\n── Most recent first, and the same copy is not counted twice ──')
{
  // A post that has gone out exists in BOTH tables, worded identically.
  const admin = fakeAdmin({
    mkt_content_queue: [
      { body: 'Newest thing.', created_at: iso(0), status: 'draft', client_id: 'c1' },
      { body: 'The   same    copy.', created_at: iso(4), status: 'scheduled', client_id: 'c1' },
    ],
    published_posts: [
      { post_copy: 'The same copy.', date_sent: iso(4), client_id: 'c1' },
    ],
  })
  const rows = await recentBrandPosts(admin, 'c1')
  ok(rows.length === 2, 'the duplicated post is counted once, not twice', JSON.stringify(rows.map((r) => r.body)))
  ok(rows[0].body === 'Newest thing.', 'most recent first', rows[0].body)
}

console.log('\n── Future-dated published rows never gate today\'s generation ──')
{
  // date_sent was backfilled with future scheduled dates for some brands; a
  // post going out next week must not block content on that topic today.
  const admin = fakeAdmin({
    mkt_content_queue: [],
    published_posts: [
      { post_copy: 'Scheduled for next week.', date_sent: iso(-7), client_id: 'c1' },
      { post_copy: 'Genuinely already out.', date_sent: iso(3), client_id: 'c1' },
    ],
  })
  const rows = await recentBrandPosts(admin, 'c1')
  ok(rows.length === 1 && rows[0].body === 'Genuinely already out.',
    'a future-dated published_posts row is excluded', JSON.stringify(rows.map((r) => r.body)))
}

console.log('\n── Topic labels: the compact steer ──')
{
  const admin = fakeAdmin({
    mkt_content_queue: [
      { topic: 'NATO nuclear posture and UK deterrence', created_at: iso(0), status: 'draft', client_id: 'c1' },
      { topic: 'nato nuclear posture and uk deterrence', created_at: iso(1), status: 'scheduled', client_id: 'c1' },
      { topic: 'Public sector vetting failures', created_at: iso(2), status: 'scheduled', client_id: 'c1' },
      { topic: 'Something rejected', created_at: iso(1), status: 'rejected', client_id: 'c1' },
      { topic: null, created_at: iso(3), status: 'draft', client_id: 'c1' },
    ],
  })
  const topics = await recentTopics(admin, 'c1')
  ok(topics.length === 2, 'case-insensitive dedupe: the same subject twice counts once', JSON.stringify(topics))
  ok(topics[0] === 'NATO nuclear posture and UK deterrence', 'most recent first, original casing kept', topics[0])
  ok(!topics.includes('Something rejected'), 'rejected posts contribute no topic')
}

console.log('\n── The prompt block ──')
ok(topicsToAvoidBlock([]) === '', 'no topics -> empty string, so nothing is pushed into the prompt')
{
  const b = topicsToAvoidBlock(['NATO nuclear posture and UK deterrence', 'Public sector vetting failures'])
  ok(b.includes('- NATO nuclear posture and UK deterrence') && b.includes('- Public sector vetting failures'),
    'every topic is named')
  ok(/ALREADY COVERED/.test(b) && /Do NOT build this post around any of them/.test(b),
    'the instruction is explicit, not a hint')
  ok(/most recent one or two is the worst case/.test(b),
    'the freshest subjects are called out as the worst thing to repeat')
}

console.log('\n── Empty brand: no crash, no invented content ──')
{
  const admin = fakeAdmin({ mkt_content_queue: [], published_posts: [] })
  ok((await recentBrandPosts(admin, 'new-client')).length === 0, 'a brand-new client returns no posts')
  ok((await recentTopics(admin, 'new-client')).length === 0, 'a brand-new client returns no topics')
}

console.log(`\n═══ ${pass} passed, ${fail} failed ═══`)
if (fail) Deno.exit(1)
