// Shared prompt fragments used by every content-generating edge function
// (generate-content, midnight-cron, backfill-content, check-client-news).

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

// Builds the full system prompt for a client: their own master_prompt (or the
// shared house style as a fallback) plus the non-negotiable factual constraint.
export function buildSystemPrompt(client: Record<string, any>): string {
  const base = (client.master_prompt && String(client.master_prompt).trim())
    ? client.master_prompt
    : MASTER_SYSTEM_PROMPT
  return `${base}\n\n${FACTUAL_ACCURACY_CONSTRAINT}`
}

// Brand-specific compliance lines the automated review (Item 3) enforces, so
// the generator is told up front — otherwise every Hormonely/Steady post fails
// review for a missing disclaimer and lands as "needs attention".
const HORMONELY_DISCLAIMER = 'Always speak to your GP before making changes to your health routine.'
const STEADY_DISCLAIMER = 'Steady provides lifestyle and wellbeing guidance only. Always follow the advice of your prescriber or GP.'

export function brandComplianceLine(client: Record<string, any>): string {
  const name = String(client.name || '').toLowerCase()
  if (name.includes('hormonely')) return `\nThis post MUST end with exactly: "${HORMONELY_DISCLAIMER}"`
  if (name.includes('steady')) return `\nThis post MUST include exactly: "${STEADY_DISCLAIMER}" — and if you cite any statistic, cite its source inline.`
  return ''
}

// Builds the contextual user message for a social post: pillar + full client
// profile (key_services, target_customer, industry) so no post is generic.
export function buildUserMessage(client: Record<string, any>, platform: string, pillar: string): string {
  const lines: string[] = [
    `Write a ${platform} post for the "${pillar}" content pillar.`,
  ]
  if (client.industry) lines.push(`Industry: ${client.industry}`)
  if (client.key_services) lines.push(`Services: ${client.key_services}`)
  if (client.target_customer) lines.push(`Target reader: ${client.target_customer}`)
  if (client.tone_of_voice) lines.push(`Tone of voice: ${client.tone_of_voice}`)
  lines.push('No emojis, no exclamation marks, no bullet points, no bold markdown.')
  const compliance = brandComplianceLine(client)
  if (compliance) lines.push(compliance)
  lines.push('\n150-250 words. Return only the post copy — no preamble, no label.')
  return lines.join('\n')
}
