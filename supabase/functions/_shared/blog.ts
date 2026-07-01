// Shared weekly blog generation — used by midnight-cron (current week only)
// and backfill-content (next 4 Sundays).
import { buildSystemPrompt } from './prompts.ts'
import { callAnthropicStructured, dateOnly, weekNumber } from './generate.ts'

const BLOG_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string', description: 'Blog post title' },
    slug: { type: 'string', description: 'URL-safe slug — lowercase, hyphenated, no special characters' },
    meta_title: { type: 'string', description: 'SEO meta title, under 60 characters' },
    meta_description: { type: 'string', description: 'SEO meta description, under 155 characters' },
    content_html: {
      type: 'string',
      description: 'Clean HTML content only — no doctype, no html/head/body tags. Headings and paragraphs that slot directly into a page template. Minimum 600 words.',
    },
  },
  required: ['title', 'slug', 'meta_title', 'meta_description', 'content_html'],
}

// deno-lint-ignore no-explicit-any
type Admin = any

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
  const userMessage = [
    `Write a full blog post for the "${pillar}" content pillar.`,
    client.industry ? `Industry: ${client.industry}` : '',
    client.key_services ? `Services: ${client.key_services}` : '',
    client.target_customer ? `Target reader: ${client.target_customer}` : '',
    client.tone_of_voice ? `Tone of voice: ${client.tone_of_voice}` : '',
    '\nMinimum 600 words. Return via the write_blog_post tool.',
  ].filter(Boolean).join('\n')

  const result = await callAnthropicStructured(system, userMessage, 'write_blog_post', BLOG_SCHEMA, 3000)
  if (!result?.content_html || !result?.title || !result?.slug) {
    throw new Error(`blog generation returned incomplete data for ${client.name}`)
  }

  const { error } = await admin.from('mkt_blog_posts').insert({
    client_id: client.id,
    title: result.title,
    slug: result.slug,
    meta_title: result.meta_title,
    meta_description: result.meta_description,
    content_html: result.content_html,
    status: 'draft',
    publish_date: publishDate,
  })
  if (error) throw new Error(`blog insert failed for ${client.name}: ${error.message}`)

  return result.title
}
