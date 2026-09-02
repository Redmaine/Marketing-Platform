// Run: deno run --allow-env --allow-net supabase/functions/_shared/__tests__/blog_guard_test.ts
//
// Not imported by any function's index.ts, so it is never bundled on deploy.
//
// Verifies the real _shared/blog.ts guard: a blog_enabled=false client must
// return null BEFORE any Supabase or Anthropic call. The "admin" passed in
// throws on any property access, so if the guard did not fire this test
// fails loudly rather than silently doing work.
import { ensureWeeklyBlog } from '../blog.ts'

const explodingAdmin = new Proxy({}, {
  get(_t, prop) { throw new Error(`guard did not fire — admin.${String(prop)} was accessed`) },
})

let pass = 0, fail = 0
const check = (name: string, ok: boolean, extra = '') => {
  ok ? pass++ : fail++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  ${extra}`}`)
}

// CRHQ, as mkt_clients now holds it.
const crhq = { id: 'c14ccad0-21f8-44f0-9464-24f321bea37b', name: 'Combat Ready HQ', slug: 'crhq', blog_enabled: false }
try {
  const r = await ensureWeeklyBlog(explodingAdmin, crhq, new Date('2026-09-06T00:00:00Z'))
  check('CRHQ: returns null without touching the DB or Anthropic', r === null, `got ${JSON.stringify(r)}`)
} catch (e) {
  check('CRHQ: returns null without touching the DB or Anthropic', false, String((e as Error).message))
}

// adrian-linkedin, migrated off the old hardcoded slug check onto the flag.
const adrian = { id: 'e8b2e773-c6c3-4630-b9cb-971f60234ca9', name: 'Adrian Fielding — LinkedIn', slug: 'adrian-linkedin', blog_enabled: false }
try {
  const r = await ensureWeeklyBlog(explodingAdmin, adrian, new Date('2026-09-06T00:00:00Z'))
  check('adrian-linkedin: still excluded, now via the flag', r === null, `got ${JSON.stringify(r)}`)
} catch (e) {
  check('adrian-linkedin: still excluded, now via the flag', false, String((e as Error).message))
}

// A blog-enabled brand must NOT be short-circuited — it should get past the
// guard and reach the DB (which then throws, proving it went further).
const quill = { id: 'b6d35682-5737-4987-9223-73ec4592e418', name: 'Quill', slug: 'quill', blog_enabled: true }
let reached = false
try {
  await ensureWeeklyBlog(explodingAdmin, quill, new Date('2026-09-06T00:00:00Z'))
} catch (e) {
  reached = String((e as Error).message).includes('admin.from')
}
check('blog-enabled brand is NOT short-circuited (reaches the DB call)', reached)

// A client row without the column must default to enabled.
const legacy = { id: 'x', name: 'Legacy', slug: 'legacy' }
let reachedLegacy = false
try {
  await ensureWeeklyBlog(explodingAdmin, legacy, new Date('2026-09-06T00:00:00Z'))
} catch (e) {
  reachedLegacy = String((e as Error).message).includes('admin.from')
}
check('missing blog_enabled defaults to ENABLED', reachedLegacy)

console.log(`\n${pass} passed, ${fail} failed`)
if (fail) Deno.exit(1)
