// Supabase Edge Function: approve-blog  (Deno)
// Approves a draft blog post AND, in the same call, generates 3 social posts
// from it via a single structured Anthropic call — one per connected
// platform (round-robin), scheduled for Mon/Wed/Fri of the week after the
// blog's publish_date. Those posts land in the normal mkt_content_queue
// approval flow (status: draft).
//
// Invoke (agency, authenticated): supabase.functions.invoke('approve-blog',
//   { body: { blog_id } })
//
// Deploy:  supabase functions deploy approve-blog
// Secrets (vault): ANTHROPIC_API_KEY. (RESEND_API_KEY no longer used here —
// see the mkt_website_posts insert below, which replaced the email step.)
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { cors, json } from '../_shared/cors.ts'
import { buildSystemPrompt } from '../_shared/prompts.ts'
import { callAnthropicStructured, addDays } from '../_shared/generate.ts'

const POSTS_SCHEMA = {
  type: 'object',
  properties: {
    posts: {
      type: 'array',
      items: { type: 'string' },
      minItems: 3,
      maxItems: 3,
      description: '3 distinct social posts teasing this blog post, each 80-150 words, each taking a different angle/hook on the same blog, each ending with a clear call to action to read the full post.',
    },
  },
  required: ['posts'],
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })

  try {
    const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
    const userClient = createClient(SUPABASE_URL, Deno.env.get('SUPABASE_ANON_KEY')!, {
      global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } },
    })
    const { data: isAdmin } = await userClient.rpc('mkt_is_admin')
    if (isAdmin !== true) return json({ error: 'Not authorised' }, 403)

    const { blog_id } = await req.json()
    if (!blog_id) return json({ error: 'blog_id is required' }, 400)

    const admin = createClient(SUPABASE_URL, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)

    const { data: blog, error: bErr } = await admin.from('mkt_blog_posts').select('*').eq('id', blog_id).single()
    if (bErr || !blog) return json({ error: 'Blog post not found' }, 404)

    const { data: client, error: cErr } = await admin.from('mkt_clients').select('*').eq('id', blog.client_id).single()
    if (cErr || !client) return json({ error: 'Client not found' }, 404)

    const { error: approveErr } = await admin.from('mkt_blog_posts').update({ status: 'approved' }).eq('id', blog_id)
    if (approveErr) return json({ error: approveErr.message }, 500)

    // Item 6 — on approval, the blog needs to actually get published. This
    // used to email the HTML to the agency inbox for someone to manually
    // paste onto the site ("No brand has an automated CMS publish path wired
    // yet"). Now there is one (see publish-blog-post): drop a matching draft
    // into mkt_website_posts so it shows up in the ops platform's Blog
    // section, one tap from being live. Best-effort — a failure here must
    // not roll back the approval or block the social repurposing below.
    let websitePostId: string | null = null
    let websitePostError: string | null = null
    try {
      const baseSlug = String(blog.slug || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
      const { data: existingSlugs } = await admin
        .from('mkt_website_posts')
        .select('slug')
        .eq('client_id', client.id)
        .ilike('slug', `${baseSlug}%`)
      const taken = new Set((existingSlugs || []).map((r: { slug: string }) => r.slug))
      let slug = baseSlug
      for (let n = 2; taken.has(slug); n++) slug = `${baseSlug}-${n}`

      const { data: inserted, error: insErr } = await admin.from('mkt_website_posts').insert({
        client_id: client.id,
        title: blog.title,
        slug,
        body: blog.content_html || '',
        excerpt: blog.meta_description || null,
        seo_keyword: blog.target_keyword || null,
        status: 'draft',
      }).select('id').single()
      if (insErr) websitePostError = insErr.message
      else websitePostId = inserted?.id ?? null
    } catch (e) {
      websitePostError = String((e as Error)?.message ?? e)
    }
    if (websitePostError) console.error('[approve-blog] mkt_website_posts insert failed:', websitePostError)

    const connected: string[] = client.connected_platforms?.length ? client.connected_platforms : ['facebook']
    const blogUrl = client.website ? `${client.website.replace(/\/$/, '')}/blog/${blog.slug}` : `/blog/${blog.slug}`

    const system = buildSystemPrompt(client)
    const userMessage = [
      `We just published a blog post titled "${blog.title}" and need 3 social posts that tease it and drive readers to read the full thing.`,
      client.industry ? `Industry: ${client.industry}` : '',
      client.tone_of_voice ? `Tone of voice: ${client.tone_of_voice}` : '',
      `Blog summary/content for reference:\n${stripHtml(blog.content_html).slice(0, 1500)}`,
      `\nLink to include (as-is, don't invent a different URL): ${blogUrl}`,
      '\nReturn exactly 3 posts via the write_social_posts tool. Each must stand alone, take a different angle, and drive to the link.',
    ].filter(Boolean).join('\n')

    let posts: string[]
    try {
      const result = await callAnthropicStructured(system, userMessage, 'write_social_posts', POSTS_SCHEMA, 1500)
      posts = result?.posts ?? []
      if (posts.length !== 3) throw new Error(`expected 3 posts, got ${posts.length}`)
    } catch (e) {
      // The blog is already approved — repurposing failure shouldn't roll that back,
      // just surface it so it can be generated manually.
      return json({ ok: true, blog_approved: true, repurposed: false, error: String((e as Error)?.message ?? e) })
    }

    // Mon/Wed/Fri of the week after the blog's publish_date (always a Sunday).
    const base = blog.publish_date ? new Date(`${blog.publish_date}T00:00:00`) : new Date()
    const monday = addDays(base, 1)
    const targets = [monday, addDays(monday, 2), addDays(monday, 4)] // Mon, Wed, Fri

    const [hh, mm] = String(client.post_time ?? '09:00').split(':')
    const rows = posts.map((body, i) => {
      const platform = connected[i % connected.length]
      const slot = new Date(targets[i]); slot.setHours(Number(hh) || 9, Number(mm) || 0, 0, 0)
      return {
        client_id: client.id, platform, content_type: 'post',
        pillar: `Blog: ${blog.title}`, body, status: 'draft', generated_by: 'ai',
        scheduled_for: slot.toISOString(),
      }
    })

    const { error: insErr } = await admin.from('mkt_content_queue').insert(rows)
    if (insErr) return json({ ok: true, blog_approved: true, repurposed: false, website_post_id: websitePostId, website_post_error: websitePostError, error: insErr.message })

    return json({ ok: true, blog_approved: true, repurposed: true, posts_created: rows.length, website_post_id: websitePostId, website_post_error: websitePostError })
  } catch (e) {
    return json({ error: String((e as Error)?.message ?? e) }, 500)
  }
})

function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
}
