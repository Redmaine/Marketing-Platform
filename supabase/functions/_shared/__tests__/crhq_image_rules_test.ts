// Run: deno run --allow-env --allow-net --allow-read supabase/functions/_shared/__tests__/crhq_image_rules_test.ts
//
// Not imported by any function's index.ts, so it is never bundled on deploy.
//
// Pins CRHQ's four image rules (12 Sep 2026) at the REVIEW stage, against the
// real judge and the real pixel measurements — not against the prompt, which
// is advisory. The measurements used below are real ones taken during the
// build: the 6 Sep black-and-white frame measured exactly 0/0; the first
// colour frame measured 0.238/0.786; the deliberate tank control came back
// conf 0.95, era mis-read as 1950-1990 for an M4 Sherman — which is the
// case for rule 4 being a presence ban rather than an age test.
import {
  assembleImagePrompt,
  HEADLINE_MIN_YELLOW_FRACTION,
  HEADLINE_TEXT_COLOUR,
  IMAGE_REVIEW_THRESHOLDS,
  judgeImageMeasurement,
  measureColour,
  measureHeadlineOverlay,
} from '../image.ts'
import { Image } from '../vendor/imagescript/mod.ts'

let pass = 0, fail = 0
const check = (name: string, ok: boolean, extra = '') => {
  ok ? pass++ : fail++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  ${extra}`}`)
}
const CRHQ = { requireColour: true, banHardware: true, requireRelevance: true }
const clean = { faces: [], text_findings: [], hardware: [], subject: { depicted: 'x', relevance: 0.9 }, colour: { mean_saturation: 0.24, chromatic_fraction: 0.79, sampled: 4096 } }

console.log('── Rule 1: colour only ──')
{
  const bw = { ...clean, colour: { mean_saturation: 0, chromatic_fraction: 0, sampled: 4096 } }
  const r = judgeImageMeasurement(bw, IMAGE_REVIEW_THRESHOLDS, false, CRHQ)
  check('the real 6 Sep B&W measurement (0/0) is rejected', r.verdict === 'reject' && r.reasons.some((x) => x.startsWith('COLOUR')), r.reasons.join('; '))
  const c = judgeImageMeasurement(clean, IMAGE_REVIEW_THRESHOLDS, false, CRHQ)
  check('the real first colour measurement (0.238/0.786) passes', c.verdict === 'pass', c.reasons.join('; '))
  const missing = judgeImageMeasurement({ ...clean, colour: undefined }, IMAGE_REVIEW_THRESHOLDS, false, CRHQ)
  check('a MISSING colour measurement is a rejection, not a pass', missing.verdict === 'reject' && missing.reasons[0].startsWith('COLOUR: no colour measurement'), missing.reasons.join('; '))
  const off = judgeImageMeasurement(bw, IMAGE_REVIEW_THRESHOLDS, false, {})
  check('and with the rule OFF (every other brand) the same B&W frame passes as before', off.verdict === 'pass', off.reasons.join('; '))
}

console.log('\n── Rule 1, measured from pixels ──')
{
  const grey = new Image(64, 64).fill(0x808080ff)
  const g = await measureColour(await grey.encode())
  check('a flat grey frame measures 0 saturation, 0 chromatic', g.mean_saturation === 0 && g.chromatic_fraction === 0, JSON.stringify(g))
  const red = new Image(64, 64).fill(0xc03020ff)
  const rr = await measureColour(await red.encode())
  check('a coloured frame measures well above the thresholds', rr.mean_saturation > IMAGE_REVIEW_THRESHOLDS.colour.minMeanSaturation && rr.chromatic_fraction > IMAGE_REVIEW_THRESHOLDS.colour.minChromaticFraction, JSON.stringify(rr))
  const desat = new Image(64, 64).fill(0xc03020ff)
  desat.saturation(0)
  const d = await measureColour(await desat.encode())
  check('the exact saturation(0) treatment the old code applied measures 0/0', d.mean_saturation === 0 && d.chromatic_fraction === 0, JSON.stringify(d))
}

console.log('\n── Rule 2: yellow headline, measured from the composite ──')
{
  // A banner band with yellow text-coloured pixels in it.
  const img = new Image(200, 200).fill(0x406080ff)
  img.drawBox(0, 152, 200, 48, () => 0x000000ee)
  img.drawBox(40, 165, 120, 20, () => HEADLINE_TEXT_COLOUR)
  const y = await measureHeadlineOverlay(await img.encode())
  check('yellow text in the banner clears the threshold', y.yellow_fraction >= HEADLINE_MIN_YELLOW_FRACTION, JSON.stringify(y))
  const white = new Image(200, 200).fill(0x406080ff)
  white.drawBox(0, 152, 200, 48, () => 0x000000ee)
  white.drawBox(40, 165, 120, 20, () => 0xffffffff)
  const w = await measureHeadlineOverlay(await white.encode())
  check('the WHITE text the old code rendered does NOT count as yellow', w.yellow_fraction < HEADLINE_MIN_YELLOW_FRACTION, JSON.stringify(w))
  const black = new Image(200, 200).fill(0x406080ff)
  black.drawBox(0, 152, 200, 48, () => 0x000000ee)
  black.drawBox(40, 165, 120, 20, () => 0x000000ff)
  const b = await measureHeadlineOverlay(await black.encode())
  check('black text does not count as yellow', b.yellow_fraction < HEADLINE_MIN_YELLOW_FRACTION, JSON.stringify(b))
  const none = new Image(200, 200).fill(0x406080ff)
  none.drawBox(0, 152, 200, 48, () => 0x000000ee)
  const n = await measureHeadlineOverlay(await none.encode())
  check('no text at all does not count as yellow', n.yellow_fraction < HEADLINE_MIN_YELLOW_FRACTION, JSON.stringify(n))
  check('HEADLINE_TEXT_COLOUR is #FFD400 opaque', HEADLINE_TEXT_COLOUR === 0xffd400ff)
}

console.log('\n── Rule 3: about THIS post ──')
{
  const generic = { ...clean, subject: { depicted: 'Empty institutional room', relevance: 0.0, note: 'No connection to port security' } }
  const r = judgeImageMeasurement(generic, IMAGE_REVIEW_THRESHOLDS, false, CRHQ)
  check('the real control (veterans frame vs a port-security post, relevance 0.00) is rejected', r.verdict === 'reject' && r.reasons.some((x) => x.startsWith('SUBJECT')), r.reasons.join('; '))
  const adj = { ...clean, subject: { depicted: 'tank', relevance: 0.4, note: 'generic military imagery' } }
  check('defence-adjacent (0.40) is rejected', judgeImageMeasurement(adj, IMAGE_REVIEW_THRESHOLDS, false, CRHQ).verdict === 'reject')
  const ok = { ...clean, subject: { depicted: 'waiting room', relevance: 0.6, note: 'evokes abandonment' } }
  check('the real first frame (0.60) passes', judgeImageMeasurement(ok, IMAGE_REVIEW_THRESHOLDS, false, CRHQ).verdict === 'pass')
  const missing = judgeImageMeasurement({ ...clean, subject: undefined }, IMAGE_REVIEW_THRESHOLDS, false, CRHQ)
  check('a MISSING relevance measurement is a rejection, not a pass', missing.verdict === 'reject' && missing.reasons[0].startsWith('SUBJECT: no relevance'), missing.reasons.join('; '))
}

console.log('\n── Rule 4: military hardware is a PRESENCE ban ──')
{
  const tank = { ...clean, hardware: [{ kind: 'tank', confidence: 0.95, apparent_era: '1950_1990', note: 'M4 Sherman variant, centre frame' }] }
  const r = judgeImageMeasurement(tank, IMAGE_REVIEW_THRESHOLDS, false, CRHQ)
  check('the real tank control (conf 0.95) is rejected', r.verdict === 'reject' && r.reasons.some((x) => x.startsWith('HARDWARE')), r.reasons.join('; '))
  const modern = { ...clean, hardware: [{ kind: 'military_aircraft', confidence: 0.9, apparent_era: 'post_2006', note: 'modern jet' }] }
  check('MODERN hardware is rejected too — the rule is presence, not age', judgeImageMeasurement(modern, IMAGE_REVIEW_THRESHOLDS, false, CRHQ).verdict === 'reject')
  const unclear = { ...clean, hardware: [{ kind: 'artillery', confidence: 0.8, apparent_era: 'unclear', note: '' }] }
  check('an "unclear" era still rejects — the model never has to date it', judgeImageMeasurement(unclear, IMAGE_REVIEW_THRESHOLDS, false, CRHQ).verdict === 'reject')
  const faint = { ...clean, hardware: [{ kind: 'drone', confidence: 0.3, apparent_era: 'unclear', note: 'possible speck' }] }
  check('below the confidence floor (0.30) is treated as noise', judgeImageMeasurement(faint, IMAGE_REVIEW_THRESHOLDS, false, CRHQ).verdict === 'pass')
  check('with the rule OFF, the tank measurement passes as before (other brands untouched)', judgeImageMeasurement(tank, IMAGE_REVIEW_THRESHOLDS, false, {}).verdict === 'pass')
}

console.log('\n── The existing face/text checks are unchanged ──')
{
  const face = { ...clean, faces: [{ confidence: 0.9, area_fraction: 0.05, resolvable_landmarks: ['eyes', 'nose', 'mouth'], lighting: 'well_lit', orientation: 'frontal' }] }
  check('a prominent resolvable face still rejects, with or without CRHQ rules',
    judgeImageMeasurement(face, IMAGE_REVIEW_THRESHOLDS, false, CRHQ).verdict === 'reject' && judgeImageMeasurement(face, IMAGE_REVIEW_THRESHOLDS, false, {}).verdict === 'reject')
  const text = { ...clean, text_findings: [{ content: 'HMS 123', legibility: 0.7, kind: 'hull_number' }] }
  check('a legible hull number still rejects', judgeImageMeasurement(text, IMAGE_REVIEW_THRESHOLDS, false, {}).verdict === 'reject')
}

console.log('\n── Abstract topics: the prompt keeps the concept as the subject (13 Sep 2026) ──')
{
  const crhq = { slug: 'crhq', name: 'Combat Ready HQ' }
  const concept = 'A bare interview-room table with one chair and the small red light of a wall-mounted recorder'
  const prompt = assembleImagePrompt(concept, 'STYLE TEXT', crhq)
  check('the concept is in the prompt verbatim', prompt.includes(concept))
  check('the style text is contiguous (passesStylePrefixCheck still holds)', prompt.includes('STYLE TEXT'))
  check('the closer no longer declares material "the whole subject" — that tail was pulling every abstract-topic frame to wet tarmac',
    !/material and light are the whole subject/.test(prompt))
  check('the closer instead keeps the described scene as the subject', /remains the subject of the photograph/.test(prompt))
  const other = assembleImagePrompt(concept, 'OTHER STYLE', { slug: 'quill' })
  check('a non-CRHQ brand gets its own three-part prompt, unchanged', other.startsWith(concept) && other.includes('OTHER STYLE') && !other.includes('Portra'))
}

console.log(`\n═══ ${pass} passed, ${fail} failed ═══`)
Deno.exit(fail ? 1 : 0)
