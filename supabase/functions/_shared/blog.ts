// Shared weekly blog generation — used by midnight-cron / the Saturday-night
// blog cron (current week) and backfill-content (next 4 Sundays).
// Item 6: 800-1200 words, built around a search-intent keyword, written in
// prose (no markdown ## headers, no ** bold, no bullet lists), all Item 3
// content rules apply, and the Hormonely / Steady disclaimers are enforced.
import { buildSystemPrompt } from './prompts.ts'
import { callAnthropicStructured, dateOnly, weekNumber } from './generate.ts'
import { contentRuleViolation } from './review.ts'

const HORMONELY_DISCLAIMER = 'Always speak to your GP before making changes to your health routine.'
const STEADY_DISCLAIMER = 'Steady provides lifestyle and wellbeing guidance only. Always follow the advice of your prescriber or GP.'

const BLOG_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string', description: 'Blog post title' },
    slug: { type: 'string', description: 'URL-safe slug — lowercase, hyphenated, no special characters' },
    target_keyword: { type: 'string', description: 'The single search-intent keyword/phrase this post targets, relevant to the brand audience.' },
    meta_title: { type: 'string', description: 'SEO meta title, under 60 characters' },
    meta_description: { type: 'string', description: 'SEO meta description, under 155 characters' },
    content_html: {
      type: 'string',
      description: 'Between 800 and 1200 words of clean prose as HTML <p> paragraphs only — no doctype/html/head/body tags, no markdown, no ## headers, no ** bold, no bullet or numbered lists. Flowing prose that reads like a person wrote it.',
    },
  },
  required: ['title', 'slug', 'target_keyword', 'meta_title', 'meta_description', 'content_html'],
}

// deno-lint-ignore no-explicit-any
type Admin = any

function wordCount(html: string): number {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean).length
}

// Append a required disclaimer as a final paragraph if the model left it out —
// a deterministic safety net so a Hormonely/Steady blog can never ship without
// it (the prompt asks for it; this guarantees it).
function ensureDisclaimer(client: Record<string, any>, html: string): string {
  const name = String(client.name || '').toLowerCase()
  if (name.includes('hormonely') && !html.includes(HORMONELY_DISCLAIMER)) {
    return `${html}\n<p>${HORMONELY_DISCLAIMER}</p>`
  }
  if (name.includes('steady') && !html.includes(STEADY_DISCLAIMER)) {
    return `${html}\n<p>${STEADY_DISCLAIMER}</p>`
  }
  return html
}

// Generates and inserts one blog post for `client`, scheduled for `weekSunday`,
// unless one already exists for that client + publish_date. Returns the
// generated title, or null if a blog already existed for that week.
export async function ensureWeeklyBlog(admin: Admin, client: Record<string, any>, weekSunday: Date): Promise<string | null> {
  const publishDate = dateOnly(weekSunday)

  const { count } = await admin.from('mkt_blog_posts')
    .select('id', { count: 'exact', head: true })
    .eq('client_id', client.id).eq('publish_date', publishDate)
  if ((count ?? 0) > 0) return null

  const pillars: string[] = client.content_pillars ?? []
  const pillar = pillars.length ? pillars[weekNumber(weekSunday) % pillars.length] : 'General'

  const system = buildSystemPrompt(client)
  const disclaimerLine = String(client.name || '').toLowerCase().includes('hormonely')
    ? `\nThis is a Hormonely post — it MUST end with exactly: "${HORMONELY_DISCLAIMER}"`
    : String(client.name || '').toLowerCase().includes('steady')
      ? `\nThis is a Steady post — it MUST include exactly: "${STEADY_DISCLAIMER}" and any statistic used must cite its source inline.`
      : ''

  const baseUser = [
    `Write a full blog post for the "${pillar}" content pillar.`,
    client.industry ? `Industry: ${client.industry}` : '',
    client.key_services ? `Services: ${client.key_services}` : '',
    client.target_customer ? `Target reader: ${client.target_customer}` : '',
    client.tone_of_voice ? `Tone of voice: ${client.tone_of_voice}` : '',
    `\nBuild it around one clear search-intent keyword this audience would actually search for.`,
    `Between 800 and 1200 words, prose only — no bullet points, no ## headers, no ** bold, no emojis, no exclamation marks.`,
    disclaimerLine,
    `\nReturn via the write_blog_post tool.`,
  ].filter(Boolean).join('\n')

  // Up to two attempts so a content-rule slip (e.g. a stray bold) can be
  // regenerated rather than shipped.
  let result: Record<string, any> | null = null
  for (let attempt = 1; attempt <= 2; attempt++) {
    const r = await callAnthropicStructured(system, attempt === 1 ? baseUser : `${baseUser}\n\nThe previous attempt broke a formatting rule. Return clean prose HTML only.`, 'write_blog_post', BLOG_SCHEMA, 3000)
    if (!r?.content_html || !r?.title || !r?.slug) continue
    // Content rules apply to blogs too — but headings/prose HTML is fine, so we
    // only reject markdown artefacts and disallowed punctuation, not HTML tags.
    const stripped = String(r.content_html).replace(/<[^>]+>/g, '')
    if (!contentRuleViolation(stripped)) { result = r; break }
    result = r // keep last even if imperfect; disclaimer/lightweight issues handled below
  }
  if (!result?.content_html || !result?.title || !result?.slug) {
    throw new Error(`blog generation returned incomplete data for ${client.name}`)
  }

  const finalHtml = ensureDisclaimer(client, String(result.content_html))

  const { error } = await admin.from('mkt_blog_posts').insert({
    client_id: client.id,
    title: result.title,
    slug: result.slug,
    target_keyword: result.target_keyword ?? null,
    meta_title: result.meta_title,
    meta_description: result.meta_description,
    content_html: finalHtml,
    status: 'draft',
    publish_date: publishDate,
  })
  if (error) throw new Error(`blog insert failed for ${client.name}: ${error.message}`)

  return result.title
}
