// Run: deno run --allow-env --allow-net --allow-read supabase/functions/_shared/__tests__/crhqRecycle_test.ts
//
// Pins the deterministic rules of CRHQ slot recycling (crhqRecycle.ts,
// 18 Sep 2026) against the REAL rows from mkt_content_queue that motivated
// it — b09c3603 (approved, no image, slot 14 Sep, stuck), 6235812f and
// ac3b822f (drafts whose image exhausted, slots 16 and 18 Sep), and the
// live posts that already told the ambush story on Facebook.
import {
  RECYCLE_MAX_AGE_DAYS,
  alreadyCovered,
  isEligible,
  recycleReasonFor,
  sourceUrlsIn,
  topicOverlap,
  type RecycleCandidate,
} from '../crhqRecycle.ts'

let pass = 0, fail = 0
const check = (name: string, ok: boolean, extra = '') => {
  ok ? pass++ : fail++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  ${extra}`}`)
}

const NOW = new Date('2026-09-18T07:40:00Z')
const base: RecycleCandidate = {
  id: 'x', platform: 'instagram', status: 'draft', review_status: 'needs_attention', scheduled_for: '2026-09-18T06:30:00Z',
  created_at: '2026-09-16T22:00:44Z', body: 'Coordinated ambush operations now signal genuine capability progression.\nFull breakdown at combatreadyhq.co.uk',
  topic: 'Coordinated ambush capability progression and threat assessment', content_source: 'youtube_scrape',
  is_manual: false, metricool_post_id: null, image_url: null, recycled_at: null, recycled_from: null,
}

console.log('── Eligibility, on the real rows ──')
{
  const ac3b = { ...base, id: 'ac3b822f' }
  check('ac3b822f (draft, image exhausted, slot 06:30 today, now 07:40) is eligible', isEligible(ac3b, NOW).ok)
  const b09c = { ...base, id: 'b09c3603', platform: 'facebook', status: 'approved', scheduled_for: '2026-09-14T17:00:00Z', created_at: '2026-09-12T22:00:25Z', topic: 'Police accountability and institutional bias in Portsmouth incident investigation' }
  check('b09c3603 (approved, never sent to Metricool, slot 14 Sep) is eligible', isEligible(b09c, NOW).ok)
  check('b09c3603 reads as stuck_approved', recycleReasonFor(b09c) === 'stuck_approved')
  check('ac3b822f reads as image_exhausted', recycleReasonFor(ac3b) === 'image_exhausted')
  // Adrian, 18 Sep: a rejection is a deliberate decision — never quietly retried.
  check('a human-REJECTED post is NOT eligible', !isEligible({ ...base, status: 'rejected' }, NOW).ok && isEligible({ ...base, status: 'rejected' }, NOW).why === 'status rejected')
  check('a draft that was never approved in time reads as missed', recycleReasonFor({ ...base, review_status: 'passed', image_url: 'x' }) === 'missed')
  check('slot still in the future → not eligible', !isEligible({ ...base, scheduled_for: '2026-09-19T06:30:00Z' }, NOW).ok)
  check('sent to Metricool → not eligible', !isEligible({ ...base, metricool_post_id: 'mc1' }, NOW).ok)
  check('status scheduled → not eligible', !isEligible({ ...base, status: 'scheduled' }, NOW).ok)
  check('already recycled → not eligible (once only)', !isEligible({ ...base, recycled_at: '2026-09-17T22:00:00Z' }, NOW).ok)
  check('a recycled post that itself died → not eligible (no loop)', !isEligible({ ...base, recycled_from: 'orig' }, NOW).ok)
  check('manual post → not eligible', !isEligible({ ...base, is_manual: true }, NOW).ok)
  check('themed weekly → not eligible', !isEligible({ ...base, content_source: 'themed_weekly' }, NOW).ok)
  const old = new Date(NOW.getTime() - (RECYCLE_MAX_AGE_DAYS + 1) * 86_400_000).toISOString()
  check(`slot older than ${RECYCLE_MAX_AGE_DAYS} days → not eligible`, !isEligible({ ...base, scheduled_for: old }, NOW).ok)
  check('nothing to regenerate from → not eligible', !isEligible({ ...base, topic: null, body: '' }, NOW).ok)
}

console.log('── Already covered since ──')
{
  // The real later posts on FACEBOOK about the same story — brand-wide, they
  // cover the Instagram original too (the reviewer's repeat rule is brand-wide):
  const fb16 = { topic: 'Modern ambush tactics and military coordination capability', body: 'Modern ambush tactics … combatreadyhq.co.uk' }
  const fb18 = { topic: 'Coordinated ambush operations and capability progression analysis', body: '… combatreadyhq.co.uk' }
  const cov = alreadyCovered(base, [fb16, fb18])
  check('the ambush story IS covered by the 18 Sep Facebook post (topic overlap, brand-wide)', cov.covered, cov.by ?? '')
  check(`overlap with the 18 Sep topic is high (${topicOverlap(base.topic, fb18.topic).toFixed(2)})`, topicOverlap(base.topic, fb18.topic) >= 0.6)
  check(`overlap with the 16 Sep topic is lower (${topicOverlap(base.topic, fb16.topic).toFixed(2)})`, topicOverlap(base.topic, fb16.topic) < topicOverlap(base.topic, fb18.topic))
  const unrelated = { topic: 'UK veteran welfare support and institutional accountability', body: '' }
  check('an unrelated later post does not cover it', !alreadyCovered(base, [unrelated]).covered)
  check('no later posts → not covered', !alreadyCovered(base, []).covered)
  // A shared specific source URL counts even when the topics are worded apart.
  const withUrl = { ...base, body: 'Watch now at youtube.com/watch?v=x0TIu0RZmkM' }
  const laterSame = { topic: 'Nuclear strike risk to the UK', body: 'Watch: https://youtube.com/watch?v=x0TIu0RZmkM' }
  check('the same YouTube link in a later post counts as covered', alreadyCovered(withUrl, [laterSame]).covered)
  check('the bare site link does not (every post carries it)', !alreadyCovered(base, [{ topic: 'Something else entirely', body: 'Full breakdown at combatreadyhq.co.uk' }]).covered)
  check('sourceUrlsIn finds the bare domain form', sourceUrlsIn('Full breakdown at combatreadyhq.co.uk').length === 1)
  // The real 16 Sep pair: 6235812f's topic vs the Facebook sibling's — they
  // differ by "coordination"/"coordinated" and "operations"/"analysis".
  const o6235 = 'Ambush coordination capability progression and threat assessment'
  check(`stemming: 6235812f vs the 18 Sep Facebook topic overlaps ≥ 0.6 (${topicOverlap(o6235, fb18.topic).toFixed(2)})`, topicOverlap(o6235, fb18.topic) >= 0.6)
}

console.log('── Scope ──')
{
  const src = await Deno.readTextFile(new URL('../crhqRecycle.ts', import.meta.url))
  check('every queue read/write is filtered by the client id', (src.match(/\.eq\('client_id', client\.id\)/g) ?? []).length >= 2)
  // Every deployed function that could reach this module — no brand other
  // than CRHQ can, because only CRHQ's own nightly function (and the
  // undeployed verification harness) import it.
  const importers: string[] = []
  for await (const d of Deno.readDir(new URL('../../', import.meta.url))) {
    if (!d.isDirectory || d.name.startsWith('_')) continue
    try {
      const idx = await Deno.readTextFile(new URL(`../../${d.name}/index.ts`, import.meta.url))
      if (idx.includes('crhqRecycle.ts')) importers.push(d.name)
    } catch { /* no index.ts */ }
  }
  check(`the module is imported only by crhq-nightly-content and the undeployed harness (found: ${importers.sort().join(', ')})`, importers.sort().join(',') === 'crhq-nightly-content,recycle-harness')
  const idx = await Deno.readTextFile(new URL('../../crhq-nightly-content/index.ts', import.meta.url))
  check('the nightly run calls recycleMissedSlots after fresh generation', idx.indexOf('recycleMissedSlots(admin, client)') > idx.indexOf('for (const platform of PLATFORMS)'))
}

console.log(`\n${pass} passed, ${fail} failed`)
Deno.exit(fail ? 1 : 0)
