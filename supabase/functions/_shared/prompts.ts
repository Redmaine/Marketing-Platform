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
    const items = [
      ...crhqVideos.map((v) => `- [Video] "${v.title}" (${v.view_count ?? 0} views, published ${v.published_at ?? 'recently'}) — ${v.url}`),
      ...crhqArticles.map((a) => `- [Article] "${a.title}" — ${a.url}`),
    ]
    lines.push(`\nHere is Combat Ready HQ's latest content from the last 48 hours:\n${items.join('\n')}\nReference this actual content in the generated post.`)
  }

  lines.push(FORMAT_RULES)
  lines.push('\n150-250 words. Return only the post copy — no preamble, no label.')

  // Fix 3 — the disclaimer instruction must be the final thing the model reads.
  const disclaimer = brandDisclaimerInstruction(client)
  if (disclaimer) lines.push(`\n${disclaimer}`)

  return lines.join('\n')
}
