// Run: deno run --allow-env --allow-net --allow-read supabase/functions/_shared/__tests__/crhq_tactical_menu_test.ts
//
// 18 Sep 2026. Posts about tactics and capability (the "ambush coordination"
// posts of 15–17 Sep) exhausted three nights running: the concept model had
// no safe emblem for that topic class, so it reached for weapon imagery
// (attempt 3 on 17 Sep: HARDWARE other_weapon conf 0.92) or fell back to the
// wet wall (relevance 0.00). This pins the STEP 1b tactical menu, the
// matching fallback, and that every item on the menu clears the SAME
// deterministic concept guard production runs — the weapons ban is untouched.
import {
  CRHQ_CONCEPT_FALLBACK,
  CRHQ_CONCEPT_SYSTEM,
  CRHQ_TACTICAL_FALLBACK,
  CRHQ_TACTICAL_TOPIC,
  conceptProblem,
  crhqFallbackConceptFor,
  IMAGE_REVIEW_SYSTEM,
} from '../image.ts'

let pass = 0, fail = 0
const check = (name: string, ok: boolean, extra = '') => {
  ok ? pass++ : fail++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  ${extra}`}`)
}

// The three real posts, verbatim from mkt_content_queue.
const AMBUSH_1 = 'Ambush coordination now shows capability progression that changes threat assessment.\nUnderstanding how these operations execute tells you what forces can actually do.\nFull breakdown at combatreadyhq.co.uk'
const AMBUSH_2 = 'Coordinated ambush operations now signal genuine capability progression.\nWhat forces can execute changes threat assessment fundamentally.\nFull breakdown at combatreadyhq.co.uk'
const PORTSMOUTH = "Police accountability in England operates in a grey zone. When something goes wrong during an operation, the investigation machinery spins up, statements get made, and somewhere down the line a conclusion is reached."

console.log('── The menu exists and is built from permitted things only ──')
{
  const bullet = CRHQ_CONCEPT_SYSTEM.split('\n').find((l) => l.startsWith('- tactics, capability'))
  check('STEP 1b has a tactics/capability bullet', !!bullet)
  const items = [
    'A terrain model on a sand table, damp earth and gravel shaped into a ridge and a valley with plain wooden pegs and white cord laid across it marking positions, photographed close and low.',
    'A bare timber planning bench under a tarpaulin with binoculars, a torch, a coil of rope and a canteen laid out on it, rain dripping from the canvas edge.',
    'A sandbagged parapet and raw earth berm at first light, mist across the open ground beyond.',
    'A treeline at the edge of open ground at dawn, seen low from inside a wet ditch.',
    'Boot prints and tyre tracks across wet earth after rain, close at ground level.',
  ]
  for (const it of items) check(`menu item clears the concept guard: "${it.slice(0, 40)}…"`, conceptProblem(it) === null, String(conceptProblem(it)))
  check('the tactical fallback itself clears the concept guard', conceptProblem(CRHQ_TACTICAL_FALLBACK) === null, String(conceptProblem(CRHQ_TACTICAL_FALLBACK)))
  check('the original wall fallback still clears it', conceptProblem(CRHQ_CONCEPT_FALLBACK) === null)
}

console.log('── The weapons ban is untouched ──')
{
  const step3 = CRHQ_CONCEPT_SYSTEM.slice(CRHQ_CONCEPT_SYSTEM.indexOf('STEP 3'))
  check('STEP 3 still bans every weapon and piece of hardware of any era', /tanks, armoured vehicles, artillery, missiles, launchers, warships, submarines, military aircraft, helicopters, drones, rifles, guns, ammunition, any weapon or piece of military hardware of any era/.test(step3))
  check('STEP 3 still bans maps, charts and vehicles', /maps, charts, diagrams/.test(step3) && /any vehicle/.test(step3))
  // The radio handset and the camouflage net were on the first draft of the
  // menu; a real run (18 Sep, harness ambush-e2e-1) had the review stage
  // flag the handset as HARDWARE other_military_equipment conf 0.85. The
  // review ban is not loosened for them — they come off the menu instead,
  // and the concept guard now stops them before an attempt is spent.
  for (const bad of ['a shoulder-fired anti-tank launcher on a wall', 'a map spread on a table with markers', 'a vehicle silhouette at distance on the ridge', 'a soldier in uniform at the parapet', 'a field radio handset with its coiled cable on a sandbag', 'a camouflage net stretched over open ground']) {
    check(`concept guard still rejects "${bad}"`, conceptProblem(bad) !== null)
  }
  check('the tactical bullet itself tells the model no weapon, vehicle, radio, net or kit', /no weapon, no vehicle, no radio or comms set, no camouflage net and no other piece of military equipment may be described/.test(CRHQ_CONCEPT_SYSTEM))
}

console.log('── The fallback is chosen from the post, deterministically ──')
{
  check('ambush post 1 → tactical fallback', crhqFallbackConceptFor(AMBUSH_1) === CRHQ_TACTICAL_FALLBACK)
  check('ambush post 2 → tactical fallback', crhqFallbackConceptFor(AMBUSH_2) === CRHQ_TACTICAL_FALLBACK)
  check('Portsmouth policing post → the wall, unchanged', crhqFallbackConceptFor(PORTSMOUTH) === CRHQ_CONCEPT_FALLBACK)
  check('a company-results style post is not "tactical"', !CRHQ_TACTICAL_TOPIC.test('The company reported record engagement this quarter across its operational divisions.'))
  check('"training exercise" is', CRHQ_TACTICAL_TOPIC.test('The training exercise on Salisbury Plain'))
}

console.log('── The reviewer knows the emblems are the subject ──')
{
  check('reviewer prompt names the tactical emblems, and no radio or net', /terrain model or sand table/.test(IMAGE_REVIEW_SYSTEM) && !/field radio/.test(IMAGE_REVIEW_SYSTEM) && !/camouflage net/.test(IMAGE_REVIEW_SYSTEM))
  check('reviewer prompt names the policing emblems the 1b menu already had', /bare interview-room table/.test(IMAGE_REVIEW_SYSTEM) && /body-worn camera/.test(IMAGE_REVIEW_SYSTEM))
  check('reviewer is told not to mark down for missing weapons/vehicles', /Do not mark these down for the absence of weapons, vehicles or troops/.test(IMAGE_REVIEW_SYSTEM))
  check('0.3 is reserved for a frame with no emblem at all', /Reserve 0.3 and below for a frame that is only weather, texture, a wall, a street or a room/.test(IMAGE_REVIEW_SYSTEM))
}

console.log(`\n${pass} passed, ${fail} failed`)
Deno.exit(fail ? 1 : 0)
