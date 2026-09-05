// Item 3 — automated pre-queue review. Every generated social post is checked
// here BEFORE it is written to the approval queue. Split into two layers:
//   1. Deterministic checks (content rules, required disclaimers) — done in
//      code because they are exact and cheap, and an LLM is unreliable at
//      "did this contain a double space".
//   2. Judgement checks (fabrication, repeat topic, brand voice, unsourced
//      statistics) — done by Anthropic with a structured tool response.
// The first failure wins and returns the spec's exact reason string.
import { callAnthropicStructured, generatePost } from './generate.ts'
import { recentBrandPosts } from './recentSubjects.ts'
import { BLOG_REFERENCE_KEYWORDS, wordCountRange } from './prompts.ts'

// deno-lint-ignore no-explicit-any
type Admin = any

// The ONLY businesses a post may reference as a real client / case study /
// result. Anything else is a fabrication and must be rejected.
//
// Safe Hands Funeral Services removed (2026-08-08) — pipeline client only,
// no agreement in place, Quill does not manage their social media. Must
// never be treated as a current/real client anywhere in the system, not
// just in Quill's own generation prompt (see prompts.ts's QUILL_CLIENTS,
// fixed alongside this).
export const REAL_CLIENTS = [
  'Riverside Sheetmetal Fabrications',
  'Combat Ready HQ',
  'Steady',
]

// The businesses Adrian Fielding personally owns/founded — real, not
// fabricated, so his own LinkedIn brand must be allowed to name them without
// tripping the fabricated-client check below.
const ADRIAN_OWNED_BRANDS = ['Quill', 'Your Company AI', 'Hormonely', 'Once Upon A You', 'Neuro Decoded', 'Steady']

// Shared by permittedReferences and personalFabricationViolation below —
// one identity check for "is this Adrian's personal LinkedIn brand", not
// duplicated slug/name matching in two places.
function isAdrianLinkedIn(client: Record<string, any>): boolean {
  const slug = String(client.slug || '').toLowerCase()
  const name = String(client.name || '').toLowerCase()
  return slug === 'adrian-linkedin' || name.includes('adrian fielding')
}

// Fix 2 — permitted references for a specific brand. Problem. Solution. is a
// sub-brand of Your Company AI whose entire pitch IS the YCA platform (YCA is
// named in its master prompt and key services), so a reference to YCA is the
// parent product it promotes, not an invented client. The YCA brand itself may
// obviously reference its own product too. Everything else stays a fabrication.
export function permittedReferences(client: Record<string, any>): string[] {
  const name = String(client.name || '').toLowerCase()
  const list = [...REAL_CLIENTS]
  const isPS = name.includes('problem') && name.includes('solution')
  const isYCA = name.includes('your company') || name.includes('yca')
  if (isPS || isYCA) {
    list.push('Your Company AI (also written YCA) — the parent product this brand exists to promote')
  }
  // Adrian's personal LinkedIn — the brief for this brand explicitly requires
  // referencing his own businesses by name every post, so all of them are
  // real, permitted references here (not case studies of someone else's
  // business).
  if (isAdrianLinkedIn(client)) {
    list.push(...ADRIAN_OWNED_BRANDS.map((b) => `${b} — a real business Adrian Fielding personally owns/founded`))
  }
  return list
}

// Incident fix — the Adrian Fielding LinkedIn brand generated "We hired
// someone last week who turned down a higher salary to join us." Redmaine
// has no employees. This slipped through because the LLM judgement check
// below (fabricated_client_or_result) only ever asked about named
// businesses/case studies, never about first-person personal claims — a
// hiring decision, a team member, a client quote, isn't "a business" in
// that check's sense at all. Deterministic pattern match, not another LLM
// judgement call, so the failure reason is always exactly "fabricated
// personal claim" (plus which pattern matched) rather than depending on the
// model to phrase it consistently. Scoped to Adrian's LinkedIn brand only —
// other brands genuinely do have real teams/employees/clients and must be
// allowed to write about them truthfully.
// Refined 2026-08-10 — the patterns above catch a fixed vocabulary
// (hiring/team/client-quote), but the LLM-only unverified_personal_narrative
// check meant to catch the open-ended rest (see its schema comment) passed
// 9 out of 9 real invented-event posts for this brand, including a
// turned-down deal and a customer refund that this same incident-fix
// comment already names as gaps. Adding those specific named-transaction
// types rather than trusting the model's judgement call again for this
// brand, and — per the same refinement — every pattern below (including the
// original hiring/team ones) is now checked against real_events_context
// before it's treated as a fabrication, not just pattern-matched blind.
//
// Deliberately narrow, both in what the patterns match and in what counts as
// grounded: the brief is to flag a NAMED, CHECKABLE transaction (a refund
// actually issued, a deal actually signed/turned down, a meeting with a
// specific named counterparty, a hire actually made), not general reflective
// "this week I've been thinking about..." framing — that's an approved,
// deliberate style for this brand, not fabrication. Each pattern requires a
// past-tense verb asserting the transaction occurred, not the topic word
// alone (e.g. "refund" appearing in a reflective sentence about pricing
// policy must not match — only "refunded a customer" etc. does). Two
// previously-standalone bare-noun patterns ("employees", "staff members")
// were removed for the same reason: they matched the word alone, with no
// transactional structure, unlike every other pattern here, and would have
// flagged purely topical mentions with no claimed event at all — the
// existing possessive form ("our/my team/employees/staff/colleagues") below
// already covers the actual claim-shaped version of this.
const PERSONAL_FABRICATION_PATTERNS: { label: string; keyword: string; pattern: RegExp }[] = [
  { label: 'hiring claim', keyword: 'hir', pattern: /\b(?:we|i)(?:'ve| have)? (?:just |recently )?hired\b/i },
  { label: 'hiring claim', keyword: 'hir', pattern: /\bhiring (?:decision|someone|a new)\b/i },
  { label: 'hiring claim', keyword: 'hir', pattern: /\bturned down (?:a|an|the) .{0,40}(?:offer|salary|job) to join\b/i },
  { label: 'new team member claim', keyword: 'hir', pattern: /\bnew (?:hire|team member|employee|colleague)\b/i },
  { label: 'team member claim', keyword: 'team', pattern: /\bjoined (?:us|the team|our team)\b/i },
  { label: 'employee/team claim', keyword: 'team', pattern: /\b(?:our|my) (?:team|employees?|staff|colleagues?)\b/i },
  { label: 'client quote/testimonial', keyword: 'client', pattern: /\b(?:a |one )?client (?:said|says|told (?:us|me))\b/i },
  { label: 'client quote/testimonial', keyword: 'customer', pattern: /\bcustomer (?:said|says|told (?:us|me))\b/i },
  { label: 'client quote/testimonial', keyword: 'testimonial', pattern: /\btestimonial\b/i },
  // Refund actually issued — a checkable transaction, not "refund" as a topic.
  { label: 'refund claim', keyword: 'refund', pattern: /\b(?:we|i)(?:'ve| have)? (?:just |recently )?refunded\b/i },
  { label: 'refund claim', keyword: 'refund', pattern: /\brefunded (?:a|an|the|one) (?:customer|client)\b/i },
  { label: 'refund claim', keyword: 'refund', pattern: /\b(?:issued|gave|processed) (?:a|the|their) (?:full |partial )?refund\b/i },
  // Deal signed, closed, or turned down — a checkable transaction, not
  // "deal" used generically (e.g. "a raw deal", "no big deal").
  { label: 'deal claim', keyword: 'deal', pattern: /\bsigned (?:a|an|the|our) (?:new )?(?:deal|contract|client|agreement)\b/i },
  { label: 'deal claim', keyword: 'deal', pattern: /\bclosed (?:a|an|the|our) (?:new )?deal\b/i },
  { label: 'deal claim', keyword: 'deal', pattern: /\bturned down (?:a|an|the) .{0,60}(?:deal|contract)\b/i },
  // A specific meeting with a named type of counterparty — not "meetings"
  // discussed as a general topic.
  { label: 'specific meeting claim', keyword: 'meeting', pattern: /\b(?:met|meeting) with (?:a|an|the|our|my) (?:client|customer|investor|supplier|partner|prospect)\b/i },
  { label: 'specific meeting claim', keyword: 'meeting', pattern: /\bsat down with (?:a|an|the|our|my) (?:client|customer|investor|supplier|partner|prospect)\b/i },
  { label: 'specific meeting claim', keyword: 'meeting', pattern: /\bhad (?:a|the) call with (?:a|an|the|our|my) (?:client|customer|investor|supplier|partner|prospect)\b/i },
]

// A matched claim is only a fabrication if nothing in the real weekly-
// activity context supplied to generation (see _shared/realEvents.ts)
// plausibly substantiates it. Crude keyword-presence check rather than
// semantic matching, deliberately: real_events_context is structured
// factual data (post counts, blog titles, rejection reasons), never
// narrative prose, so a genuine grounding would contain the relevant
// keyword somewhere in a structured line about it. Today's
// real_events_context never mentions hiring/refunds/deals/meetings at all,
// so this is a no-op in practice — it exists so the check correctly stands
// down if that context is ever extended to include genuinely verifiable
// events of these kinds, rather than false-positiving on legitimately
// grounded content forever.
function groundedInRealEvents(client: Record<string, any>, keyword: string): boolean {
  const context = typeof client._real_events_context === 'string' ? client._real_events_context : ''
  return !!context && context.toLowerCase().includes(keyword.toLowerCase())
}

function personalFabricationViolation(client: Record<string, any>, body: string): string | null {
  if (!isAdrianLinkedIn(client)) return null
  for (const { label, keyword, pattern } of PERSONAL_FABRICATION_PATTERNS) {
    if (pattern.test(body) && !groundedInRealEvents(client, keyword)) {
      return `fabricated personal claim — ${label} detected`
    }
  }
  return null
}

// ── Layer 1: blog-dependent copy with no blog to depend on ──────────────────
// The caller (fill.ts) resolves whether a blog actually went live for this
// brand in the last 7 days and attaches the answer as client._blog_context.
// buildUserMessage already instructs the model accordingly; this is the
// deterministic guarantee behind that instruction — a post that references a
// blog when none exists fails review and is regenerated (see
// generateReviewedPost's retry), rather than being queued and then blocked in
// the approval queue the way it used to be.
//
// Tri-state guard, matching buildUserMessage exactly: _blog_context absent
// means the caller never opted in, so this check is skipped entirely and
// non-cron generation paths are completely unaffected.
function blogReferenceViolation(client: Record<string, any>, body: string): string | null {
  const blogContext = client._blog_context as { recentBlog?: unknown } | undefined
  if (!blogContext) return null
  if (blogContext.recentBlog) return null
  for (const keyword of BLOG_REFERENCE_KEYWORDS) {
    // Word-boundary match so "blog" doesn't fire on a longer word, while
    // multi-word phrases still match across normal spacing.
    const pattern = new RegExp(`\\b${keyword.replace(/\s+/g, '\\s+')}\\b`, 'i')
    if (pattern.test(body)) {
      return `references a blog but none has been published for this brand in the last 7 days — matched "${keyword}"`
    }
  }
  return null
}

const HORMONELY_DISCLAIMER = 'Always speak to your GP before making changes to your health routine.'
const STEADY_DISCLAIMER = 'Steady provides lifestyle and wellbeing guidance only. Always follow the advice of your prescriber or GP.'

// Per-brand hard-banned strings — checked regardless of what the prompt says,
// since a prompt-only rule (e.g. CRHQ_FACEBOOK's old "use YOUTUBE10 sparingly")
// can still leak through. CRHQ's shop has closed, so YOUTUBE10 is no longer a
// valid discount code and must never appear, full stop — not "at most one post
// in three" as the prompt previously allowed.
const BANNED_PHRASES: Record<string, string[]> = {
  crhq: ['YOUTUBE10'],
}

function bannedPhraseViolation(client: Record<string, any>, body: string): string | null {
  const slug = String(client.slug || '').toLowerCase()
  const banned = BANNED_PHRASES[slug]
  if (!banned) return null
  const lower = body.toLowerCase()
  for (const phrase of banned) {
    if (lower.includes(phrase.toLowerCase())) return `banned phrase "${phrase}"`
  }
  return null
}

function isOuay(client: Record<string, any>): boolean {
  const slug = String(client.slug || '').toLowerCase()
  const name = String(client.name || '').toLowerCase()
  return slug === 'ouay' || name.includes('once upon a you')
}

// Deterministic backstop (26 Aug 2026) — OUAY's illustrations are 100%
// AI-generated from a customer's photo, not drawn by a person. Content
// claiming otherwise ("illustrator", "hand-drawn", "hand-drawing") has been
// generated and caught TWICE despite the master_prompt already telling the
// model not to; OUAY's master_prompt has now been corrected with an
// explicit HARD RULE section, but prompt-only reliance has already failed
// twice, so this backstop does not trust instruction-following a third
// time — same escalation as personalFabricationViolation below, once for
// this brand's own recurring incident. Unlike that check, there is no
// "grounded in real events" exception to weigh: there is no context in
// which this claim is ever true for OUAY, so any match is a violation.
// Deliberately does NOT match the bare stem "illustrat*": OUAY's own
// master_prompt legitimately and correctly describes the AI-generated
// artwork as "photo-matched illustrations" — that noun is accurate and
// approved. What is banned is a claim that a PERSON produced them: the role
// noun ("illustrator(s)") and the human-attribution phrase ("illustrated
// by"), not the plain product noun.
const OUAY_ILLUSTRATOR_PATTERNS: { label: string; pattern: RegExp }[] = [
  { label: 'illustrator claim', pattern: /\billustrators?\b/i },
  { label: 'illustrator claim', pattern: /\billustrated by\b/i },
  { label: 'hand-illustrated claim', pattern: /\bhand[\s-]?illustrat\w*\b/i },
  // hand-drawn, hand-drawing, hand drawn, hand drawing, handdrawn,
  // handdrawing, hand-drew, hand drew — hyphen/space between "hand" and the
  // draw-verb is optional so both spellings and no separator all match.
  { label: 'hand-drawn/hand-drawing claim', pattern: /\bhand[\s-]?(?:drawn|drawing|draws?|drew)\b/i },
  // Same claim, reversed word order — "drawn/drawing/drew ... by hand".
  { label: 'hand-drawn/hand-drawing claim', pattern: /\bdraw\w* by hand\b/i },
  { label: 'hand-drawn/hand-drawing claim', pattern: /\bdrew by hand\b/i },
]

function ouayIllustratorClaimViolation(client: Record<string, any>, body: string): string | null {
  if (!isOuay(client)) return null
  for (const { label, pattern } of OUAY_ILLUSTRATOR_PATTERNS) {
    const match = body.match(pattern)
    if (match) return `banned phrase — ${label} (matched "${match[0]}")`
  }
  return null
}

// ── Layer 1: deterministic content rules ────────────────────────────────────
// Returns the specific rule broken, or null if clean.
export function contentRuleViolation(body: string): string | null {
  if (/\p{Extended_Pictographic}/u.test(body)) return 'emoji'
  if (body.includes('!')) return 'exclamation mark'
  // Bullet points: line starting with -, •, or a single * (not ** bold), or "1. ".
  if (/^\s*(?:[-•]|\*(?!\*))\s+/m.test(body)) return 'bullet points'
  if (/^\s*\d+\.\s+/m.test(body)) return 'numbered list'
  if (/\*\*/.test(body)) return 'bold markdown asterisks'
  if (/\. {2,}/.test(body)) return 'double space after full stop'
  return null
}

// ── Layer 1: word count against the platform-appropriate target ─────────────
// The review step checked markdown/bullet formatting but never actually
// counted words against the range every post is instructed to hit (see
// prompts.ts's lengthInstruction/wordCountRange) — at least 15 posts across
// multiple brands went out over 250 words with nothing catching it. Applies
// to every brand and platform via the same wordCountRange() the generation
// prompt itself uses, so the two can never drift apart. Simple whitespace
// split — good enough for a target this wide (a 150-250 word range doesn't
// need exact editorial word-counting rules, just to catch posts that are
// dramatically outside it).
function wordCountViolation(body: string, platform: string): string | null {
  const count = body.trim().split(/\s+/).filter(Boolean).length
  const { min, max } = wordCountRange(platform)
  if (count < min || count > max) {
    return `word count ${count} outside the ${min}-${max} word target for ${platform}`
  }
  return null
}

// ── Layer 1: required disclaimers (brand-specific) ───────────────────────────
function disclaimerViolation(client: Record<string, any>, body: string): string | null {
  const name = String(client.name || '').toLowerCase()
  if (name.includes('hormonely') && !body.includes(HORMONELY_DISCLAIMER)) {
    return `Hormonely post must end with "${HORMONELY_DISCLAIMER}"`
  }
  if (name.includes('steady') && !body.includes(STEADY_DISCLAIMER)) {
    return `Steady post must include "${STEADY_DISCLAIMER}"`
  }
  return null
}

const REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    fabricated_client_or_result: { type: 'boolean', description: 'True if the post references any client, case study, result, metric, or business outcome that is not verifiable or names a business other than the approved real clients.' },
    fabrication_detail: { type: 'string', description: 'If fabricated, what exactly. Else empty.' },
    // The post's own subject, in a few words. Added 5 Sep 2026: the generator
    // had no compact statement of what this brand has recently been ABOUT, so
    // it kept re-covering the same ground and the reviewer kept catching it.
    // The reviewer is already reading the post in full and already returning
    // structured output, so naming the subject here costs no extra call. It is
    // stored on the queue row and fed to the next night's generation as
    // subject matter to steer away from (see _shared/recentSubjects.ts).
    // Required, so it is present even on a post that FAILS review — a rejected
    // post still tells us what the pipeline is fixating on.
    topic: { type: 'string', description: 'The specific subject of THIS post in 3-8 words, as a noun phrase a human would recognise (e.g. "NATO nuclear posture and UK deterrence", "AI vs traditional agency turnaround speed"). Describe the actual subject matter, not the format or the brand.' },
    repeat_topic: { type: 'boolean', description: 'True if this post covers essentially the same topic/angle as one of the recent posts provided (published OR currently queued).' },
    repeat_detail: { type: 'string', description: 'If repeat, which prior topic it duplicates. Else empty.' },
    wrong_brand_voice: { type: 'boolean', description: 'True if this post could just as easily belong to a different brand — i.e. it does not sound distinctly like THIS brand.' },
    voice_detail: { type: 'string', description: 'If wrong voice, why. Else empty.' },
    unsourced_statistic: { type: 'boolean', description: 'True ONLY for Steady: a statistic/number-claim is used without citing its source. False for all other brands or when no statistic is used.' },
    statistic_detail: { type: 'string', description: 'If unsourced statistic, which one. Else empty.' },
    // Audit finding — the original Adrian Fielding LinkedIn incident ("We
    // hired someone last week...") was fixed with a deterministic regex
    // backstop (personalFabricationViolation), but that only covers a fixed
    // vocabulary (hiring/team/client-quote). Three MORE posts for this same
    // brand were generated and passed review, then had to be caught by
    // Adrian manually rejecting them as "False" — a turned-down deal, a
    // customer refund — neither matches any existing pattern, because
    // they're not fixed-vocabulary claims, they're arbitrary invented
    // weekly-business-events. fabricated_client_or_result's own description
    // is scoped to "references a client... or names a business" — a
    // first-person "I did X this week" claim about no external party isn't
    // covered by it either, same gap as the original incident, just wider.
    // True ONLY for Adrian Fielding — LinkedIn: a specific event, decision,
    // or outcome presented as having genuinely happened that is not
    // grounded in anything actually supplied in this prompt. False for
    // every other brand, and false for genuinely reflective/introspective
    // commentary that doesn't claim a specific unverifiable event occurred.
    unverified_personal_narrative: { type: 'boolean', description: 'True ONLY for Adrian Fielding — LinkedIn: the post presents a specific event, decision, or business outcome (e.g. "I turned down a deal", "we refunded a customer", "I hired someone") as something that genuinely happened this week, but nothing in this prompt grounds it as real. False for every other brand. False for general reflection or opinion that makes no claim of a specific unverifiable event.' },
    narrative_detail: { type: 'string', description: 'If unverified_personal_narrative, which specific claimed event. Else empty.' },
  },
  required: ['topic', 'fabricated_client_or_result', 'repeat_topic', 'wrong_brand_voice', 'unsourced_statistic', 'unverified_personal_narrative'],
}

export interface ReviewResult {
  pass: boolean
  reason: string | null
  // The reviewer's own one-line statement of what this post is about. Null
  // when the review could not run (a deterministic Layer-1 rejection never
  // reaches the model, so there is nothing to report — see reviewPost).
  topic: string | null
}

// Full review of one social post for one client. `admin` is used to load the
// brand's recent published topics for the repeat-topic check. `platform`
// determines which word count target applies (see wordCountViolation).
export async function reviewPost(admin: Admin, client: Record<string, any>, body: string, platform: string): Promise<ReviewResult> {
  // Layer 1 — deterministic, first.
  const ruleBroken = contentRuleViolation(body)
  if (ruleBroken) return { pass: false, reason: `content rule violation: ${ruleBroken}`, topic: null }

  const wordCount = wordCountViolation(body, platform)
  if (wordCount) return { pass: false, reason: wordCount, topic: null }

  const missingDisclaimer = disclaimerViolation(client, body)
  if (missingDisclaimer) return { pass: false, reason: `missing disclaimer: ${missingDisclaimer}`, topic: null }

  const bannedPhrase = bannedPhraseViolation(client, body)
  if (bannedPhrase) return { pass: false, reason: bannedPhrase, topic: null }

  const ouayIllustratorClaim = ouayIllustratorClaimViolation(client, body)
  if (ouayIllustratorClaim) return { pass: false, reason: ouayIllustratorClaim, topic: null }

  const personalFabrication = personalFabricationViolation(client, body)
  if (personalFabrication) return { pass: false, reason: personalFabrication, topic: null }

  const blogReference = blogReferenceViolation(client, body)
  if (blogReference) return { pass: false, reason: blogReference, topic: null }

  // Layer 2 — judgement. Pull recent published copy for the repeat-topic check.
  // Fix 1 — only genuinely-past posts count as "already published". date_sent
  // was backfilled with future scheduled dates for some brands, so without the
  // upper bound a post scheduled for next week would block new content on the
  // same topic today. A future-scheduled post must not gate present generation.
  // QUEUE + PUBLISHED, not published_posts alone (5 Sep 2026 fix). This used
  // to read published_posts only, with the note below about excluding
  // future-dated rows. That upper bound is still right and is preserved inside
  // recentBrandPosts, but the table itself was the wrong sole source: a row
  // only lands there once Metricool has actually sent the post, so everything
  // generated in the last few days — the material most likely to be repeated —
  // was invisible to this check. Combat Ready HQ's 2 Sep post did not reach
  // published_posts until 4 Sep, so the 3 Sep review compared against a
  // version of the brand's output that did not include the previous night's.
  //
  // Fix 1 (kept): only genuinely-past posts count as "already published".
  // date_sent was backfilled with future scheduled dates for some brands, so
  // without an upper bound a post scheduled for next week would block new
  // content on the same topic today.
  const recent = await recentBrandPosts(admin, client.id, { days: 30, limit: 30 })

  const recentSummary = recent.length
    ? recent.map((r, i) => `${i + 1}. [${r.source === 'queue' ? 'queued' : 'published'}] ${r.body.slice(0, 200)}`).join('\n')
    : '(nothing published or queued in the last 30 days)'

  const system = `You are a strict editorial reviewer for a UK marketing agency. You review one social post at a time for a specific brand and decide, factually and conservatively, whether it must be rejected. When unsure, flag it. Return only the structured tool response.`

  const userMessage = [
    `BRAND BEING REVIEWED: ${client.name}`,
    client.industry ? `Industry: ${client.industry}` : '',
    client.target_customer ? `Audience: ${client.target_customer}` : '',
    client.tone_of_voice ? `Intended tone: ${client.tone_of_voice}` : '',
    '',
    `The ONLY businesses that may be named as a real client, case study, or result are:`,
    // Fix — this used to hardcode REAL_CLIENTS directly, silently bypassing
    // permittedReferences() entirely, so its PS/YCA (and now Adrian's own
    // brand family) additions never actually reached the reviewer. Wiring
    // it in here is what makes both the existing PS/YCA carve-out and the
    // new Adrian Fielding — LinkedIn one actually take effect.
    permittedReferences(client).map((c) => `- ${c}`).join('\n'),
    `Any other named client or specific business result is a fabrication.`,
    '',
    `This brand's posts from the last 30 days — both already published AND currently queued to go out (for repeat-topic checking). A queued post counts: it is going to the same audience, so repeating it is the same failure as repeating a published one:`,
    recentSummary,
    '',
    // Adrian Fielding — LinkedIn only. Its master_prompt requires the post to
    // "reference something real that has happened in the business in the
    // last week", but nothing in the generation prompt actually supplies
    // real weekly events — so the model has no way to satisfy that
    // instruction honestly except by inventing one. The deterministic
    // hiring/team/client-quote patterns (personalFabricationViolation) catch
    // a fixed, narrow vocabulary; this catches the open-ended rest — a
    // turned-down deal, a customer refund, anything presented as a specific
    // thing that genuinely happened this week with no grounding supplied
    // here.
    isAdrianLinkedIn(client)
      ? `This post is for Adrian Fielding's personal LinkedIn. Its brief asks for a real event from the past week, but no real weekly events have been supplied to the generator — so treat ANY specific claimed event, decision, or outcome (e.g. "I turned down a deal", "we refunded a customer", "I hired someone", "I built a feature that took ten days") as unverifiable unless it is a general reflection making no claim of a specific occurrence. Flag it via unverified_personal_narrative.`
      : '',
    '',
    `THE POST TO REVIEW:`,
    '"""',
    body,
    '"""',
    '',
    `Assess: fabricated client/result, repeat topic vs the published-or-queued list above, whether it sounds distinctly like ${client.name} (not any other brand), whether any specific claimed event is ungrounded (only relevant per the instruction above, else always false), and — only if the brand is Steady — whether any statistic is used without citing a source. Return the review_post tool.`,
  ].filter(Boolean).join('\n')

  let r: Record<string, any>
  try {
    r = await callAnthropicStructured(system, userMessage, 'review_post', REVIEW_SCHEMA, 500)
  } catch (e) {
    // If the reviewer itself errors, fail closed with a clear reason rather
    // than silently letting an unreviewed post through.
    return { pass: false, reason: `review could not run: ${String((e as Error)?.message ?? e).slice(0, 120)}`, topic: null }
  }

  // Normalised once here so every return below reports the same value. An
  // over-long or empty label is dropped rather than stored: a junk topic fed
  // into the next night's steer is worse than no topic, because it would look
  // like real guidance.
  const rawTopic = typeof r.topic === 'string' ? r.topic.trim().replace(/\s+/g, ' ') : ''
  const topic = rawTopic && rawTopic.length <= 120 ? rawTopic : null

  if (r.fabricated_client_or_result) return { pass: false, reason: `fabricated client or result${r.fabrication_detail ? ` — ${r.fabrication_detail}` : ''}`, topic }
  if (r.repeat_topic) return { pass: false, reason: `repeat topic${r.repeat_detail ? ` — ${r.repeat_detail}` : ''}`, topic }
  if (r.unsourced_statistic) return { pass: false, reason: `missing disclaimer: Steady statistic without a cited source${r.statistic_detail ? ` — ${r.statistic_detail}` : ''}`, topic }
  if (r.unverified_personal_narrative) return { pass: false, reason: `fabricated personal narrative${r.narrative_detail ? ` — ${r.narrative_detail}` : ''}`, topic }
  if (r.wrong_brand_voice) return { pass: false, reason: `wrong brand voice${r.voice_detail ? ` — ${r.voice_detail}` : ''}`, topic }

  return { pass: true, reason: null, topic }
}

export interface ReviewedGeneration {
  ok: boolean               // true = a post passed review
  body: string              // the passing post, or the last failed attempt
  reviewedAt: string        // ISO timestamp of the final review
  reason: string | null     // failure reason when ok=false
  attempts: number
  // The reviewer's own statement of what the post is about, stored by callers
  // on mkt_content_queue.topic and read back by the NEXT generation as subject
  // matter to steer away from. Present on failures too — a post rejected for
  // repeating a topic is the clearest possible signal of what to avoid next.
  topic: string | null
}

// Generate → review → (on fail) regenerate once → review again. Max two
// generation attempts per slot per night, per the spec. Returns the passing
// post, or ok=false with the last failure reason so the caller can queue a
// "needs attention" placeholder. Shared by the cron and the manual button so
// both enforce the exact same review before anything reaches the queue.
export async function generateReviewedPost(
  admin: Admin,
  client: Record<string, any>,
  platform: string,
  pillar: string,
): Promise<ReviewedGeneration> {
  const MAX_ATTEMPTS = 2
  let lastReason = 'no post produced'
  let lastBody = ''
  let lastTopic: string | null = null
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let body = ''
    try {
      body = await generatePost(client, platform, pillar)
    } catch (e) {
      lastReason = `generation failed: ${String((e as Error)?.message ?? e).slice(0, 120)}`
      continue
    }
    if (!body) { lastReason = 'empty AI response'; continue }
    lastBody = body
    const { pass, reason, topic } = await reviewPost(admin, client, body, platform)
    if (pass) return { ok: true, body, reviewedAt: new Date().toISOString(), reason: null, attempts: attempt, topic }
    lastReason = reason || 'failed review'
    // Keep the last non-null topic: a Layer-1 rejection on the second attempt
    // returns none, and losing the first attempt's label would throw away the
    // only record of what this slot kept trying to write about.
    if (topic) lastTopic = topic
  }
  return { ok: false, body: lastBody, reviewedAt: new Date().toISOString(), reason: lastReason, attempts: MAX_ATTEMPTS, topic: lastTopic }
}
