// Pins the CRHQ instruction-drift fix (25 Sep 2026) against the REAL posts
// Adrian quoted, taken verbatim from mkt_content_queue.
//
// Two brief violations were reported, and both were traced to the prompt
// asking for the thing the brief bans — not to the model ignoring it. These
// tests cover the enforcement half: whatever the model returns, a post that
// breaks either rule now fails review deterministically.
// Run: deno run --allow-env --allow-net --allow-read supabase/functions/_shared/__tests__/crhq_voice_rules_test.ts
import {
  crhqThirdPersonViolation, crhqStructureRepeatViolation, clientBannedWordViolation,
  crhqStockSignoffViolation,
} from '../review.ts'
import { buildSystemPrompt, buildUserMessage, clientBannedWords } from '../prompts.ts'

let pass = 0, fail = 0
const ok = (c: boolean, label: string, extra = '') => {
  c ? (pass++, console.log(`PASS  ${label}`)) : (fail++, console.log(`FAIL  ${label}${extra ? `\n        ${extra}` : ''}`))
}

const CRHQ = { id: 'c14', name: 'Combat Ready HQ', slug: 'crhq', banned_words: ['YOUTUBE10'], master_prompt: 'brief' }
const OTHER = { id: 'x', name: 'Hormonely', banned_words: [] }

// Real Facebook bodies from the queue, 19-26 Sep.
const REAL_FB = [
  'UK policy decisions at the national level rarely get examined for what they actually mean operationally until someone steps back far enough to see the full picture. Combat Ready HQ has just covered exactly that in "WOW, HUGE News That will AFFECT Everyone in the UK" — and the analysis cuts through the usual political positioning.',
  'The scale of public response to migrant arrivals in UK coastal towns is no longer fringe activity. Combat Ready HQ has documented exactly what\'s unfolding on the ground at https://youtube.com/watch?v=Y1CHq-zEBGU',
  'The language used in public discourse around Islam has shifted noticeably. Combat Ready HQ has examined exactly where that rhetoric is coming from and what it signals.',
  'Institutional decline doesn\'t announce itself with sirens. Combat Ready HQ has published analysis on exactly what that trajectory looks like in Britain right now.',
  'When the police appeal for the public to find someone, the baseline assumption is that the person presents a genuine threat. Combat Ready HQ has covered the detail in "BREAKING: EMERGENCY These Men MUST be FOUND".',
]

console.log('── Violation 1/2: the banned shape, on the real posts ──')
{
  let caught = 0
  for (const body of REAL_FB) if (crhqThirdPersonViolation(CRHQ, body)) caught++
  ok(caught === REAL_FB.length, `all ${REAL_FB.length} real Facebook posts now fail review`, `caught ${caught}`)
  const r = crhqThirdPersonViolation(CRHQ, REAL_FB[0])
  ok(!!r && /Combat Ready HQ has/.test(r), 'the reason quotes the offending phrase back', String(r))
  ok(!!crhqThirdPersonViolation(CRHQ, 'In this video we look at the new frigate order.'), '"in this video" is caught too')
  ok(!!crhqThirdPersonViolation(CRHQ, 'The analysis shows what the cuts really mean.'), '"the analysis shows" is caught too')
}

console.log('── …without catching a post written properly, as Craig ──')
{
  const good = [
    "Two frigates deferred again, and the reason given doesn't survive five minutes of scrutiny. I've watched this pattern for years: the capability gap gets absorbed by people who never voted for it. Full thing at combatreadyhq.co.uk",
    "What struck me about the Burnham speech wasn't the headline. It was the bit nobody clipped. That tells you where this is actually heading. combatreadyhq.co.uk",
    "I'd want to know who signed this off before I called it a plan. The detail matters here and it's being skipped. More at combatreadyhq.co.uk",
  ]
  for (const g of good) ok(!crhqThirdPersonViolation(CRHQ, g), `first-person opinion passes: "${g.slice(0, 44)}…"`, String(crhqThirdPersonViolation(CRHQ, g)))
  ok(!crhqThirdPersonViolation(OTHER, REAL_FB[0]), 'the rule is CRHQ-only — another brand is untouched')
}

console.log('── Violation 1: structural repetition (openings and CTAs) ──')
{
  // The three real Instagram closings Adrian quoted as "the same sentence,
  // three rewordings".
  const a = 'Policy shift carries implications.\nThe operational reality differs.\nWatch the full breakdown at combatreadyhq.co.uk'
  const b = 'Dyer said what others would not.\nIt forces a conversation.\nWatch the breakdown at combatreadyhq.co.uk'
  ok(!!crhqStructureRepeatViolation(CRHQ, b, [a]), 'same CTA skeleton with a different wording is caught', String(crhqStructureRepeatViolation(CRHQ, b, [a])))
  const sameOpen = 'Institutional decline accelerates when systems fail.\nSomething else entirely here.\nMore at combatreadyhq.co.uk'
  const prevOpen = 'Institutional decline accelerates when systems buckle.\nA different second line.\nRead it at combatreadyhq.co.uk'
  ok(!!crhqStructureRepeatViolation(CRHQ, sameOpen, [prevOpen]), 'same five-word opening is caught')
  const fresh = 'Nobody asked the obvious question this week.\nSo I will.\nThe whole argument is at combatreadyhq.co.uk'
  ok(!crhqStructureRepeatViolation(CRHQ, fresh, [a, b, prevOpen]), 'a genuinely different post passes')
  ok(!crhqStructureRepeatViolation(CRHQ, b, []), 'no history means nothing to repeat')
}

console.log('── banned_words: configured since 14 Aug, enforced from today ──')
{
  ok(clientBannedWords(CRHQ).join() === 'YOUTUBE10', 'the brand\'s banned words are read')
  ok(!!clientBannedWordViolation(CRHQ, 'Use YOUTUBE10 at checkout.'), 'a post using the banned code fails review')
  ok(!clientBannedWordViolation(CRHQ, 'No code here.'), 'a clean post passes')
  ok(!clientBannedWordViolation(OTHER, 'Use YOUTUBE10 at checkout.'), 'only that brand\'s own list applies')
}

console.log('── The prompt itself no longer asks for the banned shape ──')
{
  const client = {
    ...CRHQ,
    key_services: 'Channel with 180,000 subscribers. Discount code YOUTUBE10 active for YouTube viewers.',
    _crhq_scrape: { videos: [{ title: 'WOW, HUGE News That will AFFECT Everyone in the UK', url: 'https://youtube.com/watch?v=6c7nAtUZOMs' }], articles: [] },
    _crhq_primary_source: { type: 'video', title: 'WOW, HUGE News That will AFFECT Everyone in the UK', url: 'https://youtube.com/watch?v=6c7nAtUZOMs' },
  }
  const fb = buildUserMessage(client, 'facebook', 'CRHQ latest content')
  const ig = buildUserMessage(client, 'instagram', 'CRHQ latest content')
  const sys = buildSystemPrompt(client)
  ok(!/the channel name \(Combat Ready HQ\)/.test(fb), 'the "reference the channel name" instruction is gone')
  ok(/not your subject/.test(fb), 'the scrape is framed as subject matter, not as the subject')
  ok(!/must be exactly three lines/.test(ig), 'the rigid three-line Instagram template is gone')
  ok(!/overrides all other formatting guidance/.test(ig), 'and its override claim with it')
  ok(/VARY IT/.test(ig), 'Instagram is told to vary the shape instead')
  ok(!/The shop is closed/.test(fb), 'the "shop is closed" contradiction of the brief is gone')
  // The code must still appear ONCE — in the explicit ban. What must not
  // survive is the profile field that advertised it as active.
  const servicesLine = fb.split('\n').find((l) => l.startsWith('Services:')) ?? ''
  ok(!/YOUTUBE10/.test(servicesLine), 'the banned code is scrubbed out of the injected Services field', servicesLine)
  // The stale "180,000 subscribers" figure was fixed in the client DATA
  // (supabase/manual/crhq_profile_fields_align_to_brief_20260925.sql), not in
  // code — this fixture deliberately still carries the old string to prove
  // the scrub only removes the banned-word sentence and leaves the rest of
  // the field intact rather than silently rewriting a brand's copy.
  ok(/180,000/.test(fb), 'the scrub removes only the banned-word sentence, nothing else')
  ok((fb.match(/YOUTUBE10/g) ?? []).length === 1 && /NEVER use these words or codes/.test(fb), 'it appears exactly once, in the instruction banning it')
  ok(/THE BRIEF WINS/.test(sys), 'the house rules now defer to the brief rather than override it')
  ok(!/Craig Sawyer/.test(sys), 'the unverified surname is gone')
  ok(/writing AS Craig/.test(sys), 'the model is told whose voice it is writing in')
}

console.log('── Caught by the first real verification run, now pinned ──')
{
  // Three real Instagram bodies from the 25 Sep harness run after the prompt
  // fix. They vary properly in opening and argument and all ended the same
  // way — one unbroken paragraph, so the old line-based CTA check saw three
  // different "last lines" and passed all three.
  const ig1 = "Defence procurement moves aren't minor budget adjustments. They reshape what Britain can actually do operationally for the next fifteen years. Full breakdown at combatreadyhq.co.uk."
  const ig2 = "When security services, police and political figures move in tight coordination, it's not routine work. Full breakdown at combatreadyhq.co.uk."
  ok(!!crhqStructureRepeatViolation(CRHQ, ig2, [ig1]), 'the same closing sentence is caught even with no line breaks', String(crhqStructureRepeatViolation(CRHQ, ig2, [ig1])))

  // The cross-platform echo from the same run: Facebook and Instagram both
  // opened "When a serving mayor starts…" off the same source video.
  const fb = 'When a serving mayor starts talking about the state of a city in terms that strip away the usual political language, you are looking at something worth paying attention to. More at combatreadyhq.co.uk'
  const ig = "When a serving mayor starts being that direct about institutional failure, it's not posturing. Read the rest at combatreadyhq.co.uk"
  ok(!!crhqStructureRepeatViolation(CRHQ, ig, [fb]), 'the same opening across two platforms is caught')

  // And a post that genuinely differs on both ends still passes.
  const fresh = "There's a particular quality to institutional panic that never shows up in a press release. I've put the whole argument together at combatreadyhq.co.uk"
  ok(!crhqStructureRepeatViolation(CRHQ, fresh, [ig1, ig2, fb, ig]), 'a genuinely different opening and closing passes')
}

console.log('── The opening-word tic (second verification run) ──')
{
  // Verbatim from the 25 Sep run 2: three Facebook posts, three genuinely
  // different sentences, all opening "When".
  const w1 = 'When a major policy direction changes at the national level, you rarely get a straightforward explanation. Full breakdown at combatreadyhq.co.uk'
  const w2 = 'When elected leaders start framing their own cities as existential problems, you need to listen carefully. Read it at combatreadyhq.co.uk'
  const w3 = 'When a government starts making arrests on a significant scale, the messaging gets careful. See it at combatreadyhq.co.uk'
  ok(!crhqStructureRepeatViolation(CRHQ, w2, [w1]), 'two posts sharing an opening word is coincidence — allowed')
  const r = crhqStructureRepeatViolation(CRHQ, w3, [w2, w1])
  ok(!!r && /third post in a row/.test(r), 'three in a row is a habit — rejected', String(r))
  const varied = 'Nobody in Whitehall wants to say this plainly. The whole argument is at combatreadyhq.co.uk'
  ok(!crhqStructureRepeatViolation(CRHQ, varied, [w2, w1]), 'a different opening word breaks the run')
}

console.log('── The stock sign-off Adrian quoted, in every rewording ──')
{
  // The three he quoted as "the same sentence, three rewordings", plus the
  // one the third verification run produced unprompted.
  for (const q of [
    'Follow for analysis that goes past the headlines.',
    "Craig doesn't accept the official line at face value.",
    'Analysis that goes past the surface, every week.',
    'This is what the mainstream media won\'t tell you.',
    'Subscribe for coverage that looks beyond the headlines.',
  ]) ok(!!crhqStockSignoffViolation(CRHQ, q), `caught: "${q.slice(0, 52)}"`)
  ok(!crhqStockSignoffViolation(CRHQ, 'The procurement timeline is the part nobody is arguing about. Full thing at combatreadyhq.co.uk'), 'a specific, story-level closing passes')
  ok(!crhqStockSignoffViolation(OTHER, 'Analysis that goes past the headlines.'), 'CRHQ-only, as with the other rules')
}

console.log('── Cross-brand scoping, on the two REAL repaired posts (25 Sep) ──')
{
  // Verbatim openings from the Riverside (16 Oct) and Quill (21 Oct) posts
  // regenerated after the blank-body failure. The CRHQ rules must no-op for
  // them — they are brand-scoped by design — while the general rules
  // (word count, repeat topic, banned words) still apply to every brand.
  const RIVERSIDE = { id: 'r', name: 'Riverside Sheetmetal Fabrications', banned_words: ['precision', 'craftsmanship', 'bespoke', 'artisan'] }
  const QUILL = { id: 'q', name: 'Quill', banned_words: [] }
  const riversideBody = 'Most suppliers have account managers and ticket systems. You ring them and hope to get through to someone who knows your file. We are small enough that you do not do that. When you call, you reach Stephanie. Get in touch at riversideonline.co.uk'
  const quillBody = 'A fabricator I work with picked up the phone last Tuesday without checking it first. The small win is that he stopped carrying social media as background anxiety. Quill, the AI social media agency for UK small businesses.'

  for (const [c, body, label] of [[RIVERSIDE, riversideBody, 'Riverside'], [QUILL, quillBody, 'Quill']] as Array<[Record<string, unknown>, string, string]>) {
    ok(!crhqThirdPersonViolation(c, body), `${label}: the CRHQ third-person rule does not fire`)
    ok(!crhqStockSignoffViolation(c, body), `${label}: the CRHQ stock sign-off rule does not fire`)
    ok(!crhqStructureRepeatViolation(c, body, [riversideBody, quillBody]), `${label}: the CRHQ structure rule does not fire`)
    ok(!clientBannedWordViolation(c, body), `${label}: clean against its own banned words`)
  }
  // …and the general banned-words rule, wired up in the same commit, DOES
  // apply to a non-CRHQ brand. Riverside's list had never been enforced.
  ok(!!clientBannedWordViolation(RIVERSIDE, 'Precision engineering and craftsmanship you can rely on.'),
    "Riverside's own banned words are enforced — the rule is not CRHQ-only")
  ok(/precision/i.test(String(clientBannedWordViolation(RIVERSIDE, 'Precision engineering.'))), 'and it names the offending word')
}

console.log(`\n═══ ${pass} passed, ${fail} failed ═══`)
if (fail) Deno.exit(1)
