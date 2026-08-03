// Item 3 — automated pre-queue review. Every generated social post is checked
// here BEFORE it is written to the approval queue. Split into two layers:
//   1. Deterministic checks (content rules, required disclaimers) — done in
//      code because they are exact and cheap, and an LLM is unreliable at
//      "did this contain a double space".
//   2. Judgement checks (fabrication, repeat topic, brand voice, unsourced
//      statistics) — done by Anthropic with a structured tool response.
// The first failure wins and returns the spec's exact reason string.
import { callAnthropicStructured, generatePost } from './generate.ts'
import { BLOG_REFERENCE_KEYWORDS } from './prompts.ts'

// deno-lint-ignore no-explicit-any
type Admin = any

// The ONLY businesses a post may reference as a real client / case study /
// result. Anything else is a fabrication and must be rejected.
export const REAL_CLIENTS = [
  'Riverside Sheetmetal Fabrications',
  'Combat Ready HQ',
  'Safe Hands Funeral Services',
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
const PERSONAL_FABRICATION_PATTERNS: { label: string; pattern: RegExp }[] = [
  { label: 'hiring claim', pattern: /\b(?:we|i)(?:'ve| have)? (?:just |recently )?hired\b/i },
  { label: 'hiring claim', pattern: /\bhiring (?:decision|someone|a new)\b/i },
  { label: 'hiring claim', pattern: /\bturned down (?:a|an|the) .{0,40}(?:offer|salary|job) to join\b/i },
  { label: 'new team member claim', pattern: /\bnew (?:hire|team member|employee|colleague)\b/i },
  { label: 'team member claim', pattern: /\bjoined (?:us|the team|our team)\b/i },
  { label: 'employee/team claim', pattern: /\b(?:our|my) (?:team|employees?|staff|colleagues?)\b/i },
  { label: 'employee claim', pattern: /\bemployees?\b/i },
  { label: 'employee claim', pattern: /\bstaff members?\b/i },
  { label: 'client quote/testimonial', pattern: /\b(?:a |one )?client (?:said|says|told (?:us|me))\b/i },
  { label: 'client quote/testimonial', pattern: /\bcustomer (?:said|says|told (?:us|me))\b/i },
  { label: 'client quote/testimonial', pattern: /\btestimonial\b/i },
]

function personalFabricationViolation(client: Record<string, any>, body: string): string | null {
  if (!isAdrianLinkedIn(client)) return null
  for (const { label, pattern } of PERSONAL_FABRICATION_PATTERNS) {
    if (pattern.test(body)) return `fabricated personal claim — ${label} detected`
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
    repeat_topic: { type: 'boolean', description: 'True if this post covers essentially the same topic/angle as one of the recent published posts provided.' },
    repeat_detail: { type: 'string', description: 'If repeat, which prior topic it duplicates. Else empty.' },
    wrong_brand_voice: { type: 'boolean', description: 'True if this post could just as easily belong to a different brand — i.e. it does not sound distinctly like THIS brand.' },
    voice_detail: { type: 'string', description: 'If wrong voice, why. Else empty.' },
    unsourced_statistic: { type: 'boolean', description: 'True ONLY for Steady: a statistic/number-claim is used without citing its source. False for all other brands or when no statistic is used.' },
    statistic_detail: { type: 'string', description: 'If unsourced statistic, which one. Else empty.' },
  },
  required: ['fabricated_client_or_result', 'repeat_topic', 'wrong_brand_voice', 'unsourced_statistic'],
}

export interface ReviewResult {
  pass: boolean
  reason: string | null
}

// Full review of one social post for one client. `admin` is used to load the
// brand's recent published topics for the repeat-topic check.
export async function reviewPost(admin: Admin, client: Record<string, any>, body: string): Promise<ReviewResult> {
  // Layer 1 — deterministic, first.
  const ruleBroken = contentRuleViolation(body)
  if (ruleBroken) return { pass: false, reason: `content rule violation: ${ruleBroken}` }

  const missingDisclaimer = disclaimerViolation(client, body)
  if (missingDisclaimer) return { pass: false, reason: `missing disclaimer: ${missingDisclaimer}` }

  const personalFabrication = personalFabricationViolation(client, body)
  if (personalFabrication) return { pass: false, reason: personalFabrication }

  const blogReference = blogReferenceViolation(client, body)
  if (blogReference) return { pass: false, reason: blogReference }

  // Layer 2 — judgement. Pull recent published copy for the repeat-topic check.
  // Fix 1 — only genuinely-past posts count as "already published". date_sent
  // was backfilled with future scheduled dates for some brands, so without the
  // upper bound a post scheduled for next week would block new content on the
  // same topic today. A future-scheduled post must not gate present generation.
  const now = new Date().toISOString()
  const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000).toISOString()
  const { data: recent } = await admin.from('published_posts')
    .select('content_pillar, post_copy, date_sent')
    .eq('client_id', client.id)
    .gte('date_sent', thirtyDaysAgo)
    .lte('date_sent', now)
    .order('date_sent', { ascending: false })
    .limit(30)

  const recentSummary = (recent ?? []).length
    ? (recent as Record<string, any>[]).map((r, i) => `${i + 1}. [${r.content_pillar || 'n/a'}] ${String(r.post_copy).slice(0, 200)}`).join('\n')
    : '(none published in the last 30 days)'

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
    `This brand's posts published in the last 30 days (for repeat-topic checking):`,
    recentSummary,
    '',
    `THE POST TO REVIEW:`,
    '"""',
    body,
    '"""',
    '',
    `Assess: fabricated client/result, repeat topic vs the list above, whether it sounds distinctly like ${client.name} (not any other brand), and — only if the brand is Steady — whether any statistic is used without citing a source. Return the review_post tool.`,
  ].filter(Boolean).join('\n')

  let r: Record<string, any>
  try {
    r = await callAnthropicStructured(system, userMessage, 'review_post', REVIEW_SCHEMA, 500)
  } catch (e) {
    // If the reviewer itself errors, fail closed with a clear reason rather
    // than silently letting an unreviewed post through.
    return { pass: false, reason: `review could not run: ${String((e as Error)?.message ?? e).slice(0, 120)}` }
  }

  if (r.fabricated_client_or_result) return { pass: false, reason: `fabricated client or result${r.fabrication_detail ? ` — ${r.fabrication_detail}` : ''}` }
  if (r.repeat_topic) return { pass: false, reason: `repeat topic${r.repeat_detail ? ` — ${r.repeat_detail}` : ''}` }
  if (r.unsourced_statistic) return { pass: false, reason: `missing disclaimer: Steady statistic without a cited source${r.statistic_detail ? ` — ${r.statistic_detail}` : ''}` }
  if (r.wrong_brand_voice) return { pass: false, reason: `wrong brand voice${r.voice_detail ? ` — ${r.voice_detail}` : ''}` }

  return { pass: true, reason: null }
}

export interface ReviewedGeneration {
  ok: boolean               // true = a post passed review
  body: string              // the passing post, or the last failed attempt
  reviewedAt: string        // ISO timestamp of the final review
  reason: string | null     // failure reason when ok=false
  attempts: number
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
    const { pass, reason } = await reviewPost(admin, client, body)
    if (pass) return { ok: true, body, reviewedAt: new Date().toISOString(), reason: null, attempts: attempt }
    lastReason = reason || 'failed review'
  }
  return { ok: false, body: lastBody, reviewedAt: new Date().toISOString(), reason: lastReason, attempts: MAX_ATTEMPTS }
}
