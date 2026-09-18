// Run: deno run --allow-env --allow-net --allow-read supabase/functions/_shared/__tests__/missedSlots_test.ts
//
// Pins the deterministic rules of the missed-slot mover (missedSlots.ts,
// 18 Sep 2026) against REAL shapes: the Metricool scheduler answers seen on
// 18 Sep for a published post (PUBLISHED + publicUrl), the two CRHQ Instagram
// posts Metricool errored on ("you need to add a picture…"), and the
// Neuro Decoded post Metricool 404s on.
import { MISSED_GRACE_HOURS, MISSED_MAX_AGE_DAYS, isCandidate, verdictFor } from '../missedSlots.ts'

let pass = 0, fail = 0
const check = (name: string, ok: boolean, extra = '') => {
  ok ? pass++ : fail++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  ${extra}`}`)
}
const NOW = new Date('2026-09-18T09:00:00Z')
const base = { content_type: 'post', is_manual: false, status: 'draft', scheduled_for: '2026-09-17T08:00:00Z', published_verified_at: null }

console.log('── Candidates ──')
{
  check('a draft whose slot passed yesterday is a candidate', isCandidate(base, NOW).ok)
  check('status scheduled (handed to Metricool) is a candidate — the verdict decides', isCandidate({ ...base, status: 'scheduled' }, NOW).ok)
  check('a slot inside the grace window is not', !isCandidate({ ...base, scheduled_for: new Date(NOW.getTime() - (MISSED_GRACE_HOURS - 1) * 3_600_000).toISOString() }, NOW).ok)
  check('a slot just past the grace window is', isCandidate({ ...base, scheduled_for: new Date(NOW.getTime() - (MISSED_GRACE_HOURS + 1) * 3_600_000).toISOString() }, NOW).ok)
  check(`older than ${MISSED_MAX_AGE_DAYS} days is not (the June/July pre-Metricool rows)`, !isCandidate({ ...base, scheduled_for: '2026-07-09T19:00:00Z' }, NOW).ok)
  check('a manual post is not', !isCandidate({ ...base, is_manual: true }, NOW).ok)
  check('a verified-published row is not asked again', !isCandidate({ ...base, published_verified_at: '2026-09-18T00:00:00Z' }, NOW).ok)
  check('rejected is not', !isCandidate({ ...base, status: 'rejected' }, NOW).ok)
  check('recycled is not', !isCandidate({ ...base, status: 'recycled' }, NOW).ok)
  check('a blog row is not', !isCandidate({ ...base, content_type: 'blog' }, NOW).ok)
  check('a reel is', isCandidate({ ...base, content_type: 'reel' }, NOW).ok)
}

console.log('── Verdicts, from the real Metricool answers ──')
{
  const published = { http: 200, providers: [{ status: 'PUBLISHED', detailedStatus: 'Published' }] }
  check('no Metricool id → unsent', verdictFor({ metricool_post_id: null }, null).verdict === 'unsent')
  check('PUBLISHED → published (380/383 on 18 Sep)', verdictFor({ metricool_post_id: '377941612' }, published).verdict === 'published')
  const errored = { http: 200, providers: [{ status: 'ERROR', detailedStatus: 'you need to add a picture to make a Instagram post' }] }
  const v = verdictFor({ metricool_post_id: '373806682' }, errored)
  check('ERROR → metricool_error, with the detail (CRHQ 11/12 Sep)', v.verdict === 'metricool_error' && /add a picture/.test(v.detail), v.detail)
  check('404 → unknown (Neuro Decoded 14 Jul)', verdictFor({ metricool_post_id: '348359915' }, { http: 404, providers: [] }).verdict === 'unknown')
  check('fetch failure → unknown, never moved', verdictFor({ metricool_post_id: 'x' }, { http: 0, providers: [] }).verdict === 'unknown')
  check('PENDING → unknown (still Metricool\'s to publish)', verdictFor({ metricool_post_id: 'x' }, { http: 200, providers: [{ status: 'PENDING', detailedStatus: null }] }).verdict === 'unknown')
  check('mixed providers with one ERROR → metricool_error', verdictFor({ metricool_post_id: 'x' }, { http: 200, providers: [{ status: 'PUBLISHED', detailedStatus: null }, { status: 'ERROR', detailedStatus: 'x' }] }).verdict === 'metricool_error')
}

console.log('── Scope ──')
{
  const src = await Deno.readTextFile(new URL('../missedSlots.ts', import.meta.url))
  check('CRHQ rows are never moved here (handed to the recycler or left)', /row\.client\?\.slug === CRHQ_SLUG/.test(src) && /continue\s*\}\s*const key = `\$\{row\.client_id\}\|\$\{row\.platform\}`/.test(src))
  check('every move goes through nextEmptySlot after the previous assignment', /nextEmptySlot\(admin, row\.client, row\.platform, after\)/.test(src) && /after = slot/.test(src))
  check('the only delete is the false published_posts row of a Metricool-ERROR post', (src.match(/\.delete\(\)/g) ?? []).length === 1 && /from\('published_posts'\)\.delete\(\)/.test(src))
}

console.log(`\n${pass} passed, ${fail} failed`)
Deno.exit(fail ? 1 : 0)
