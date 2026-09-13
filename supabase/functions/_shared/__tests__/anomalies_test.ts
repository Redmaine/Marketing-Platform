// Run: deno run --allow-env --allow-net --allow-read supabase/functions/_shared/__tests__/anomalies_test.ts
//
// Not imported by any function's index.ts, so it is never bundled on deploy.
//
// Pins the anomaly rules (13 Sep 2026) against REAL shapes from the live
// tables on the day they were written: the weekly Metricool pull (Monday
// 06:00, last run 7 Sep, all 11 brands), the four brands carrying the exact
// Riverside image_gen_platforms mismatch, and the Anthropic cap message
// returned on 13 Sep.
import {
  alertHeadline, errorLogAlerts, exhaustedImageAlerts, imagePlatformMismatchAlerts,
  metricsPullAlerts, sortAlerts, zeroImageAlerts, ZERO_IMAGE_STREAK,
} from '../anomalies.ts'

let pass = 0, fail = 0
const check = (name: string, ok: boolean, extra = '') => {
  ok ? pass++ : fail++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  ${extra}`}`)
}
const ELEVEN = ['Adrian Fielding — LinkedIn', 'Combat Ready HQ', 'Hormonely', 'Neuro Decoded', 'Once Upon A You', 'Problem. Solution.', 'Quill', 'Quill — LinkedIn', 'Riverside Sheetmetal Fabrications', 'Steady', 'Your Company AI']

console.log('── Metrics pull: cadence-aware, not "48 hours" ──')
{
  // Sunday 13 Sep, last pull Monday 7 Sep 06:00 — six days. This is the
  // weekly design working, and it must NOT alarm.
  const sunday = new Date('2026-09-13T14:00:00Z')
  const r = metricsPullAlerts({ now: sunday, latestPulledAt: '2026-09-07T06:00:10Z', brandsInLatestPull: ELEVEN, expectedBrands: ELEVEN })
  check('six days stale on a Sunday, all 11 brands: no alert', r.length === 0, JSON.stringify(r))
  // Tuesday 15 Sep with no Monday pull — a missed slot.
  const tue = new Date('2026-09-15T14:00:00Z')
  const m = metricsPullAlerts({ now: tue, latestPulledAt: '2026-09-07T06:00:10Z', brandsInLatestPull: ELEVEN, expectedBrands: ELEVEN })
  check('eight days stale (a Monday was missed): CRITICAL metrics_pull_silent', m.length === 1 && m[0].severity === 'critical' && m[0].code === 'metrics_pull_silent', JSON.stringify(m))
  // Only one brand in the latest pull day — the reading in the brief.
  const p = metricsPullAlerts({ now: sunday, latestPulledAt: '2026-09-07T06:00:10Z', brandsInLatestPull: ['Neuro Decoded'], expectedBrands: ELEVEN })
  check('a pull covering 1 of 11 brands: WARNING naming the 10 missing', p.length === 1 && p[0].code === 'metrics_pull_partial' && p[0].detail.includes('Riverside Sheetmetal Fabrications') && !p[0].detail.includes('Neuro Decoded'), JSON.stringify(p))
  const never = metricsPullAlerts({ now: sunday, latestPulledAt: null, brandsInLatestPull: [], expectedBrands: ELEVEN })
  check('no rows at all: CRITICAL', never[0]?.severity === 'critical')
}

console.log('\n── Image platform mismatch: the Riverside bug, and the four brands still carrying it ──')
{
  const live = [
    { name: 'Riverside (before the manual fix)', connected_platforms: ['facebook'], image_gen_platforms: ['instagram'], image_gen_disabled_platforms: [] },
    { name: 'Riverside Sheetmetal Fabrications', connected_platforms: ['facebook'], image_gen_platforms: ['facebook'], image_gen_disabled_platforms: [] },
    { name: 'Neuro Decoded', connected_platforms: ['facebook'], image_gen_platforms: ['instagram'], image_gen_disabled_platforms: [] },
    { name: 'Once Upon A You', connected_platforms: ['facebook'], image_gen_platforms: ['instagram'], image_gen_disabled_platforms: [] },
    { name: 'Problem. Solution.', connected_platforms: ['facebook'], image_gen_platforms: ['instagram'], image_gen_disabled_platforms: [] },
    { name: 'Steady', connected_platforms: ['facebook'], image_gen_platforms: ['instagram'], image_gen_disabled_platforms: [] },
    { name: 'Hormonely', connected_platforms: ['facebook'], image_gen_platforms: ['instagram', 'facebook'], image_gen_disabled_platforms: [] },
    { name: 'Combat Ready HQ (6-12 Sep)', connected_platforms: ['facebook', 'instagram'], image_gen_platforms: ['instagram', 'facebook'], image_gen_disabled_platforms: ['facebook', 'instagram'], visual_style: 'Documentary…' },
    { name: 'Combat Ready HQ', connected_platforms: ['facebook', 'instagram'], image_gen_platforms: ['instagram', 'facebook'], image_gen_disabled_platforms: [] },
    { name: 'Adrian Fielding — LinkedIn', connected_platforms: ['linkedin'], image_gen_platforms: [], image_gen_disabled_platforms: ['linkedin'], visual_style: null },
    { name: 'A styled brand switched off everywhere', connected_platforms: ['facebook'], image_gen_platforms: [], image_gen_disabled_platforms: ['facebook'], visual_style: 'Some style' },
    { name: 'Quill — LinkedIn', connected_platforms: ['linkedin'], image_gen_platforms: [], image_gen_disabled_platforms: [] },
  ]
  const r = imagePlatformMismatchAlerts(live)
  const mism = r.filter((a) => a.code === 'image_platform_mismatch').map((a) => a.brand)
  check('the pre-fix Riverside shape is flagged', mism.includes('Riverside (before the manual fix)'))
  check('the fixed Riverside is NOT flagged', !mism.includes('Riverside Sheetmetal Fabrications'))
  check('Neuro Decoded, Once Upon A You, Problem. Solution., Steady — all four live cases flagged',
    ['Neuro Decoded', 'Once Upon A You', 'Problem. Solution.', 'Steady'].every((b) => mism.includes(b)), JSON.stringify(mism))
  check('Hormonely (instagram+facebook allowed, facebook connected) is fine', !mism.includes('Hormonely'))
  const dis = r.filter((a) => a.code === 'image_generation_disabled_everywhere').map((a) => a.brand)
  check('CRHQ as it stood 6-12 Sep (disabled on both connected platforms) is flagged', dis.includes('Combat Ready HQ (6-12 Sep)'))
  check('CRHQ now is not', !dis.includes('Combat Ready HQ'))
  check('Adrian LinkedIn (no visual_style — deliberately dormant) is NOT flagged', !dis.includes('Adrian Fielding — LinkedIn'))
  check('a brand WITH a style whose kill-switch covers every platform IS flagged', dis.includes('A styled brand switched off everywhere'))
  check('Quill — LinkedIn (no restriction, nothing disabled) is fine', !dis.includes('Quill — LinkedIn') && !mism.includes('Quill — LinkedIn'))
}

console.log('\n── Zero images across the last N posts ──')
{
  const clients = [
    { id: 'a', name: 'Brand A', connected_platforms: ['facebook'], image_gen_platforms: ['facebook'], image_gen_disabled_platforms: [] },
    { id: 'b', name: 'Brand B (misconfigured)', connected_platforms: ['facebook'], image_gen_platforms: ['instagram'], image_gen_disabled_platforms: [] },
  ]
  const posts = (id: string, urls: Array<string | null>) => urls.map((u, i) => ({ client_id: id, platform: 'facebook', image_url: u, created_at: `2026-09-1${9 - i}T10:00:00Z` }))
  const bad = zeroImageAlerts({ clients, recentPosts: posts('a', [null, null, null, 'x.png']) })
  check(`${ZERO_IMAGE_STREAK} newest posts with no image: WARNING`, bad.length === 1 && bad[0].code === 'brand_zero_images' && bad[0].brand === 'Brand A', JSON.stringify(bad))
  const ok = zeroImageAlerts({ clients, recentPosts: posts('a', [null, 'x.png', null]) })
  check('one image in the last three: no alert', ok.length === 0)
  const few = zeroImageAlerts({ clients, recentPosts: posts('a', [null, null]) })
  check('fewer than N posts: no alert (not enough evidence)', few.length === 0)
  const mis = zeroImageAlerts({ clients, recentPosts: posts('b', [null, null, null]) })
  check('a misconfigured brand is left to the mismatch rule, not double-flagged here', mis.length === 0)
}

console.log('\n── Error-log alerts: the cap, and stale crons ──')
{
  const errs = [
    { function_name: 'generate-daily-status', error_message: 'summary generation failed: Anthropic API error 400: {"type":"error","error":{"type":"invalid_request_error","message":"You have reached your specified API usage limits. You will regain access on 2026-10-01 at 00:00 UTC."}}', created_at: '2026-09-13T15:00:00Z' },
    { function_name: 'cron-healthcheck', error_message: '[cron-healthcheck] "metricool-weekly-pull" (expected weekly) has no mkt_cron_log entry in 200h — last seen 7 Sep', created_at: '2026-09-13T06:00:00Z' },
    { function_name: 'cron-healthcheck', error_message: '[cron-healthcheck] "metricool-weekly-pull" (expected weekly) has no mkt_cron_log entry in 224h — last seen 7 Sep', created_at: '2026-09-14T06:00:00Z' },
    { function_name: 'image', error_message: 'Combat Ready HQ: image generation disabled for platform "facebook" — Stability error', created_at: '2026-09-13T01:00:00Z' },
  ]
  const r = errorLogAlerts(errs)
  const cap = r.find((a) => a.code === 'anthropic_usage_cap')
  check('the real 13 Sep cap message becomes a CRITICAL alert', !!cap && cap.severity === 'critical', JSON.stringify(cap))
  check('with the regain date pulled out of the message', !!cap && cap.title.includes('2026-10-01'))
  const stale = r.filter((a) => a.code === 'cron_job_stale')
  check('a stale cron is CRITICAL, and two entries for one job collapse to one alert', stale.length === 1 && stale[0].severity === 'critical' && stale[0].title.includes('metricool-weekly-pull'))
  check('an ordinary provider error is not promoted to an alert here', r.length === 2)
  check('no errors: no alerts', errorLogAlerts([]).length === 0)
}

console.log('\n── Exhausted image runs ──')
{
  const ev = [
    { client_name: 'Combat Ready HQ', verdict: 'exhausted' }, { client_name: 'Combat Ready HQ', verdict: 'exhausted' },
    { client_name: 'Combat Ready HQ', verdict: 'reject' }, { client_name: 'Quill', verdict: 'exhausted' },
  ]
  const r = exhaustedImageAlerts(ev)
  check('two exhausted posts on one brand (the 12 Sep CRHQ night): WARNING', r.length === 1 && r[0].brand === 'Combat Ready HQ' && r[0].title.includes('2 posts'), JSON.stringify(r))
  check('a single exhausted post is not enough', !r.some((a) => a.brand === 'Quill'))
}

console.log('\n── Ordering and headline ──')
{
  const s = sortAlerts([
    { severity: 'warning', code: 'b', title: 'B', detail: '' },
    { severity: 'critical', code: 'a', title: 'A', detail: '' },
  ])
  check('critical sorts above warning', s[0].severity === 'critical')
  check('headline counts both', alertHeadline(s) === '1 CRITICAL, 1 warning — read these before anything else.', alertHeadline(s))
  check('empty headline is explicit, not blank', alertHeadline([]) === 'No anomalies detected.')
}

console.log(`\n═══ ${pass} passed, ${fail} failed ═══`)
Deno.exit(fail ? 1 : 0)
