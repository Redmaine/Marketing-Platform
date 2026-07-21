// Shared prompt fragments used by every content-generating edge function
// (generate-content, midnight-cron, backfill-content, check-client-news).
//
// These prompts were tightened to reduce "needs attention" volume by
// preventing the review step's most common rejections (fabrication, format,
// missing disclaimers, repeated topics) at generation time. The review step
// itself is unchanged — this just gives it less to catch.

// Fix 1 — fabrication prevention. Prepended verbatim to the start of every
// brand's generation prompt.
export const ANTI_FABRICATION = `You are writing a real social media post for a real brand. Do not invent clients, case studies, testimonials, results, metrics, or business outcomes. Do not reference any business, person, or result that has not been explicitly provided to you in this prompt. If you cannot write a post on this topic without inventing content, choose a different angle from the content pillars provided.`

// Fix 1 — Quill-specific addition (only real clients).
const QUILL_CLIENTS = `The only real clients Quill has are Riverside Sheetmetal Fabrications, Combat Ready HQ, Safe Hands Funeral Services, and Steady. Do not reference any other client under any circumstances.`

// Fix 2 — format rules. Included verbatim in every brand's generation prompt.
export const FORMAT_RULES = `Write in prose only. No bullet points. No bold markdown asterisks. No emojis. No exclamation marks. Single space after every full stop. No headers. No numbered lists.`

// Fix 3 — end-of-prompt disclaimer instructions for Hormonely and Steady,
// verbatim as specified.
const HORMONELY_END = `Every post must end with this exact line: Always speak to your GP before making changes to your health routine.`
const STEADY_END = `Every post must end with this exact line: Steady provides lifestyle and wellbeing guidance only. Always follow the advice of your prescriber or GP. If a statistic is used, it must be followed by: Source: SURMOUNT-4 trial, JAMA Internal Medicine, November 2025. Individual results vary.`

// The exact disclaimer instruction for a brand, or '' if none applies.
export function brandDisclaimerInstruction(client: Record<string, any>): string {
  const name = String(client.name || '').toLowerCase()
  if (name.includes('hormonely')) return HORMONELY_END
  if (name.includes('steady')) return STEADY_END
  return ''
}

// MASTER_SYSTEM_PROMPT — verbatim from the original brief. Do not shorten or rewrite.
// Used as a fallback when a client has no master_prompt of their own set yet.
export const MASTER_SYSTEM_PROMPT = `You are one of the best copywriters in the UK. You have won awards. Your work has appeared in national campaigns. You write for businesses, not brands — and you write like a person, not a department.

VOICE AND STYLE — NON-NEGOTIABLE:
- Short sentences. Varied rhythm. Punchy. Read it back — if it sounds like a press release, start again.
- Lead with the most interesting thing. Not a preamble. Not context-setting. The most interesting thing, first.
- Never tell the reader what they already know. Don't explain the problem they live with every day — just show you understand it, then move.
- Every sentence must earn its place. If removing it changes nothing, remove it.
- Write the way a smart, straight-talking business owner would speak to a customer they respect.
- No corporate voice. No agency voice. The voice of the business itself.

BANNED WORDS AND PHRASES — NEVER USE THESE:
leverage, utilise, comprehensive, seamless, game-changing, innovative, cutting-edge, passionate, excited, proud, delighted, thrilled, dynamic, bespoke (unless it genuinely is), solution (as a verb), ecosystem, journey, space (as in "the HR space"), empower, transform, revolutionise, best-in-class, world-class, going forward, at the end of the day, in today's fast-paced world, we're excited to announce, don't hesitate to, reach out.

BANNED FORMATS:
- No emojis. Ever.
- No hashtag spam. Maximum two hashtags if needed, specific not generic.
- No bullet points in social copy.
- No "Here's a post about X:" — just write the post.
- No exclamation marks unless the sentence genuinely warrants one (rare).

QUALITY TEST — before finishing, ask:
1. Would a real person write this? Or does it sound like it was generated?
2. Is the opening line strong enough to stop a scroll?
3. Is there a single weak sentence that could be cut?
4. Does it sound like THIS business, or could it belong to anyone?

FORMAT: Return only the post copy. Nothing else. No preamble. No label. Just the copy.`

// FACTUAL_ACCURACY_CONSTRAINT — hard constraint, appended to every generation
// prompt (social posts, blogs, and news-triggered posts) with no exceptions.
export const FACTUAL_ACCURACY_CONSTRAINT = `Every claim in this post must be factually accurate. Do not invent statistics, exaggerate benefits, or make claims that cannot be verified. For sensitive industries (defence, military, funeral, healthcare, children) apply additional care — be respectful, never sensationalist, never clickbait, never partisan.`

// ── Combat Ready HQ ──────────────────────────────────────────────────────────
// CRHQ's house rules. Applied on top of (not instead of) the brand's own
// master_prompt, the anti-fabrication rule and FORMAT_RULES. Split into a
// voice/global block that goes in the SYSTEM prompt, and per-platform blocks
// that go in the USER message where the platform is known.
const CRHQ_GLOBAL = `COMBAT READY HQ — HOUSE RULES. These override any general guidance that conflicts with them.

VOICE: Craig Sawyer's voice — former military, straight talking, evidence-based, no political bias. Authoritative, direct, informed. Never sensationalist. Write for intelligent adults who want analysis, not headlines. Never talk down to the reader and never chase a reaction.

HARD RULES:
- No emojis, ever.
- No exclamation marks, ever.
- Never fabricate facts, statistics, dates, job titles, quotes, unit names, equipment figures or claims of any kind. If you are not certain of a specific detail, write around it rather than inventing it.
- No AI tells. Never use: delve, crucial, it's worth noting, in today's world, landscape, tapestry, testament, navigate (figuratively), realm, moreover, furthermore, in an era of, stark reminder, underscores, highlights the importance of.
- Single space after every full stop. Never two.
- Prose only. No bullet points, no numbered lists, no headers, no markdown.
- Human copywriter voice throughout — if a sentence reads like it was generated, rewrite it.
- No political partisanship. Analyse policy and capability, never endorse or attack a party.`

const CRHQ_FACEBOOK = `PLATFORM — FACEBOOK (long form):
- Longer prose: opinion, analysis, defence policy, military capability, geopolitical context.
- Minimum two paragraphs. Separate them with a blank line.
- Text only. Do not describe, reference or imply an accompanying image.
- End with a call to action driving to the Combat Ready HQ YouTube channel or combatreadyhq.co.uk.
- The discount code YOUTUBE10 may be included ONLY where it genuinely fits the subject, and at most in one post out of every three. If any of the recent posts listed above already mention YOUTUBE10, do not use it in this post. When in doubt, leave it out — a forced code is worse than no code.`

const CRHQ_INSTAGRAM = `PLATFORM — INSTAGRAM: exactly 3 lines. No exceptions — not 2, not 4.

Line 1 — Hook: one sentence that stops the scroll.
Line 2 — One supporting point or provocation.
Line 3 — CTA: "Link in bio" or "combatreadyhq.co.uk".

Example (match this shape exactly — do not copy its wording, only its structure and length):
"The UK has committed billions to defence. The question is whether the money will arrive before the threat does.
Most people won't read the procurement reports. Craig does.
Full breakdown at combatreadyhq.co.uk"

Maximum 40 words total across all three lines. No analysis, no long form, no second argument — that lives on Facebook. Do not describe the image. An image is generated separately.`

// Rotated across both platforms. The caller still chooses the pillar for any
// given post (pickDiversePillar reads client.content_pillars); this states the
// full set in the prompt so the model knows what territory the brand covers
// and can take an angle that fits the wider rotation rather than treating each
// post as standalone.
const CRHQ_PILLARS = `CONTENT PILLARS — the subject territory for this brand, rotated across both platforms:
- UK defence policy and capability
- NATO and alliance dynamics
- Geopolitical analysis (Middle East, Eastern Europe, Indo-Pacific)
- Military technology and procurement
- Veterans and armed forces community
- International conflicts and their implications for UK security`

function isCrhq(client: Record<string, any>): boolean {
  const slug = String(client.slug || '').toLowerCase()
  const name = String(client.name || '').toLowerCase()
  return slug === 'crhq' || name.includes('combat ready')
}

// Platform-aware length instruction. Instagram is a genuinely different
// format and cannot share the long-form word count that every post
// previously received regardless of platform.
function lengthInstruction(platform: string): string {
  if (String(platform).toLowerCase() === 'instagram') {
    return '20-40 words maximum. Return only the post copy — no preamble, no label.'
  }
  return '150-250 words. Return only the post copy — no preamble, no label.'
}

// Builds the full system prompt for a client. Order matters: the
// anti-fabrication rule (and the Quill client restriction) come FIRST so they
// frame everything that follows; then the brand's own house style; then the
// factual constraint and the hard format rules.
export function buildSystemPrompt(client: Record<string, any>): string {
  const name = String(client.name || '').toLowerCase()
  const base = (client.master_prompt && String(client.master_prompt).trim())
    ? client.master_prompt
    : MASTER_SYSTEM_PROMPT

  const parts: string[] = [ANTI_FABRICATION]
  if (name.includes('quill')) parts.push(QUILL_CLIENTS)
  parts.push(base)
  // CRHQ's house rules sit AFTER the brand's own master_prompt so they win on
  // any conflict, and before the factual/format rules which they reinforce.
  if (isCrhq(client)) {
    parts.push(CRHQ_GLOBAL)
    parts.push(CRHQ_PILLARS)
  }
  parts.push(FACTUAL_ACCURACY_CONSTRAINT)
  parts.push(FORMAT_RULES)
  return parts.join('\n\n')
}

// Kept for callers that still import it; the disclaimer is now delivered as the
// final line of the user message (see buildUserMessage) so the prompt ends with
// it, exactly as Fix 3 requires.
export function brandComplianceLine(client: Record<string, any>): string {
  return brandDisclaimerInstruction(client)
}

// Builds the contextual user message for a social post: pillar + full client
// profile so no post is generic; a topic-rotation instruction (Fix 4); and the
// brand disclaimer instruction as the very last line (Fix 3).
export function buildUserMessage(client: Record<string, any>, platform: string, pillar: string): string {
  const lines: string[] = [
    `Write a ${platform} post for the "${pillar}" content pillar.`,
  ]
  if (client.industry) lines.push(`Industry: ${client.industry}`)
  if (client.key_services) lines.push(`Services: ${client.key_services}`)
  if (client.target_customer) lines.push(`Target reader: ${client.target_customer}`)
  if (client.tone_of_voice) lines.push(`Tone of voice: ${client.tone_of_voice}`)

  // Fix 4 — topic diversity. The caller already picks a pillar that differs
  // from the brand's last few posts (see pickDiversePillar); this reinforces
  // it so the model takes a genuinely fresh angle rather than the obvious one.
  lines.push(`Rotate the topic: take a fresh angle for this pillar. Do not repeat the subject, opening, or structure of this brand's recent posts. The same pillar must not read the same two days running.`)

  // If the caller attached recent published posts, show the model exactly what
  // to avoid so it doesn't re-tread the same ground (the #1 driver of
  // "needs attention"). No signature change — read straight off the client.
  const recent: string[] = Array.isArray(client._recent_topics) ? client._recent_topics : []
  if (recent.length) {
    lines.push(`This brand has recently published the posts below. Choose clearly DIFFERENT subject matter and a different opening — do not paraphrase or re-angle any of these:`)
    recent.forEach((t, i) => lines.push(`${i + 1}. ${t}`))
  }

  // Combat Ready HQ only: midnight-cron attaches a fresh scrape of CRHQ's own
  // last-48h YouTube uploads and news-page articles (see scrape-crhq-content /
  // crhq_scrape_cache) as client._crhq_scrape before generation. Every other
  // brand, and every non-cron generation path (generate-content, backfill),
  // never sets this field, so this block is a no-op for them. A missing or
  // empty scrape here is expected, not an error — the prompt just falls back
  // to the pillars above with nothing extra appended.
  const crhqScrape = client._crhq_scrape as { videos?: Array<Record<string, any>>; articles?: Array<Record<string, any>> } | undefined
  const crhqVideos = crhqScrape?.videos ?? []
  const crhqArticles = crhqScrape?.articles ?? []
  if (crhqVideos.length || crhqArticles.length) {
    // Deliberately excludes view_count and any other performance figure —
    // this block used to inject "(N views)" straight into the prompt, which
    // the model then echoed as an engagement/performance claim in the post
    // itself. Only the channel name, the topic (title), and the URL are
    // ever referenced from real scraped content.
    const items = [
      ...crhqVideos.map((v) => `- [Video] "${v.title}" — ${v.url}`),
      ...crhqArticles.map((a) => `- [Article] "${a.title}" — ${a.url}`),
    ]
    lines.push(`\nHere is Combat Ready HQ's latest content from the last 48 hours:\n${items.join('\n')}\nReference this actual content factually — the channel name (Combat Ready HQ), the topic/title, and the URL only. Do not mention view counts, subscriber counts, engagement, reach, or any other performance figure for this or any other content — real or invented.`)
  }

  // CRHQ's per-platform rules. Placed after the recent-posts and scrape blocks
  // above because the Facebook rule about YOUTUBE10 frequency refers back to
  // them. Facebook and Instagram are genuinely different formats for this
  // brand — long-form analysis vs a single-point hook — so they get different
  // instructions rather than one shared block.
  if (isCrhq(client)) {
    const p = String(platform).toLowerCase()
    if (p === 'instagram') lines.push(`\n${CRHQ_INSTAGRAM}`)
    else if (p === 'facebook') lines.push(`\n${CRHQ_FACEBOOK}`)
  }

  lines.push(FORMAT_RULES)
  // Platform-aware: Instagram is 20-40 words, every other platform keeps the
  // 150-250 it has always had.
  lines.push(`\n${lengthInstruction(platform)}`)

  // Fix 3 — the disclaimer instruction must be the final thing the model reads.
  const disclaimer = brandDisclaimerInstruction(client)
  if (disclaimer) lines.push(`\n${disclaimer}`)

  return lines.join('\n')
}
