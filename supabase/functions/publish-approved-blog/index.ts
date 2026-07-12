// Supabase Edge Function: publish-approved-blog  (Deno)
// Publishes an approved row from mkt_blog_posts (the Sunday-cron AI blog
// queue, Blogs tab in ContentQueue) live, replacing the old "Copy HTML"
// manual-paste step.
//
// Invoke (agency, authenticated): supabase.functions.invoke('publish-approved-blog',
//   { body: { blog_id, client_id } })  — client_id is informational only;
//   the authoritative brand is always the DB join, never trusted from the caller.
//
// Deploy:  supabase functions deploy publish-approved-blog
// Secrets (Supabase vault — set via `supabase secrets set`):
//   GITHUB_TOKEN                     — commits to Hormonely/Neuro Decoded
//   STEADY_SUPABASE_URL              — Steady's OWN project, NOT this one
//   STEADY_SUPABASE_SERVICE_ROLE_KEY — see below, not yet set
//
// NAMING — this is deliberately NOT called "publish-blog-post". That name is
// already taken by an earlier function (supabase/functions/publish-blog-post)
// which publishes a different table (mkt_website_posts — Adrian's own
// hand-written/pasted posts from the Blog admin section) to the same brand
// sites. Reusing the name would have silently overwritten that working
// function. The two are separate features over separate tables; this one
// exists purely for the Sunday-cron AI blog approval queue.
//
// STEADY — the task instructions said to insert into a `blog_posts` table in
// THIS project (fvyvtdwsomxfkpxwygpk / "the YCA Supabase project"). That is
// incorrect: this project has no bare `blog_posts` table (only mkt_blog_posts
// and mkt_website_posts), and Steady's real blog_posts table lives in
// Steady's OWN, separate Supabase project (mjuctguhtvsywbulktoh.supabase.co
// — confirmed live via `netlify env:get VITE_SUPABASE_URL` on the steady
// site). Inserting into this project would write data nothing reads. Built
// correctly instead: a second Supabase client pointed at Steady's real
// project, gated on STEADY_SUPABASE_URL / STEADY_SUPABASE_SERVICE_ROLE_KEY,
// which are NOT yet configured — Adrian needs to add them (see final report).
//
// GITHUB PATH — both Hormonely and Neuro Decoded's actual deployed blog code
// (src/lib/blog.js resp. src/utils/blog.js) reads posts from `src/blog/*.md`,
// not `content/blog/`. Using `src/blog` here to match what the live sites
// actually read — the older publish-blog-post function used `content/blog`,
// which appears to be the same mismatch and was not corrected here per "do
// not change... any other part of the ops platform".
//
// NETLIFY — no explicit deploy-trigger call here (unlike publish-blog-post).
// Per the task brief, both sites auto-deploy on push via their existing git
// integration, so a GitHub commit alone is sufficient.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { cors, json } from '../_shared/cors.ts'

type GithubBrand = { repo: string; branch: string; siteUrl: string }

// client.slug -> GitHub-committed brands. Steady is handled separately
// (its own Supabase project, not GitHub). Everything else falls through to
// the download-HTML path.
const GITHUB_BRANDS: Record<string, GithubBrand> = {
  hormonely: { repo: 'Redmaine/hormonely', branch: 'main', siteUrl: 'https://hormonely.co.uk' },
  'neuro-decoded': { repo: 'Redmaine/neuro-decoded', branch: 'main', siteUrl: 'https://neurodecoded.co.uk' },
}
const STEADY_SLUG = 'steady'
const STEADY_SITE_URL = 'https://steadyme.co.uk'

function toBase64(s: string): string {
  return btoa(unescape(encodeURIComponent(s)))
}
function frontmatterEscape(s: string): string {
  return String(s ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}
function slugify(s: string): string {
  return String(s ?? '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
}
function stripHtml(html: string): string {
  return String(html ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
}
function esc(s: string): string {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function buildMarkdown(post: Record<string, any>, slug: string): string {
  const date = (post.publish_date || new Date().toISOString().slice(0, 10))
  const excerpt = post.meta_description || stripHtml(post.content_html).slice(0, 200)
  const lines = [
    '---',
    `title: "${frontmatterEscape(post.title)}"`,
    `date: "${date}"`,
    `slug: "${frontmatterEscape(slug)}"`,
    `excerpt: "${frontmatterEscape(excerpt)}"`,
    '---',
    '',
    post.content_html || '',
  ]
  return lines.join('\n')
}

function buildStandaloneHtml(post: Record<string, any>): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>${esc(post.title)}</title>
<meta name="description" content="${esc(post.meta_description || '')}" />
</head>
<body>
<h1>${esc(post.title)}</h1>
${post.content_html || ''}
</body>
</html>
`
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

    const { data: blog, error: blogErr } = await admin.from('mkt_blog_posts').select('*').eq('id', blog_id).maybeSingle()
    if (blogErr || !blog) return json({ error: 'Blog post not found' }, 404)
    if (blog.status === 'published') return json({ error: 'This post is already published.' }, 400)

    const { data: client, error: clientErr } = await admin.from('mkt_clients').select('id, name, short_name, slug').eq('id', blog.client_id).maybeSingle()
    if (clientErr || !client) return json({ error: 'Client not found' }, 404)

    const slug = blog.slug || slugify(blog.title)
    const now = new Date().toISOString()

    // ── Branch 1: GitHub-committed brands (Hormonely, Neuro Decoded) ──────────
    const ghBrand = client.slug ? GITHUB_BRANDS[client.slug] : undefined
    if (ghBrand) {
      const githubToken = Deno.env.get('GITHUB_TOKEN')
      if (!githubToken) return json({ error: 'GITHUB_TOKEN not configured in Supabase vault' }, 500)

      const path = `src/blog/${slug}.md`
      const content = buildMarkdown(blog, slug)
      const ghHeaders = {
        Authorization: `Bearer ${githubToken}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
      }
      const contentsUrl = `https://api.github.com/repos/${ghBrand.repo}/contents/${path}`

      let sha: string | undefined
      const getRes = await fetch(`${contentsUrl}?ref=${ghBrand.branch}`, { headers: ghHeaders })
      if (getRes.ok) {
        sha = (await getRes.json()).sha
      } else if (getRes.status !== 404) {
        const raw = await getRes.text()
        return json({ error: `GitHub lookup failed (${getRes.status}): ${raw.slice(0, 300)}` }, 502)
      }

      const putRes = await fetch(contentsUrl, {
        method: 'PUT',
        headers: ghHeaders,
        body: JSON.stringify({
          message: `${sha ? 'Update' : 'Add'} blog post: ${blog.title}`,
          content: toBase64(content),
          branch: ghBrand.branch,
          ...(sha ? { sha } : {}),
        }),
      })
      if (!putRes.ok) {
        const raw = await putRes.text()
        return json({ error: `GitHub commit failed (${putRes.status}): ${raw.slice(0, 300)}` }, 502)
      }

      const { error: updErr } = await admin.from('mkt_blog_posts').update({ status: 'published', published_at: now }).eq('id', blog_id)
      if (updErr) return json({ error: `Committed to GitHub, but could not update status: ${updErr.message}` }, 500)

      return json({ ok: true, method: 'github', liveUrl: `${ghBrand.siteUrl}/blog/${slug}`, published_at: now })
    }

    // ── Branch 2: Steady (its own, separate Supabase project) ─────────────────
    if (client.slug === STEADY_SLUG) {
      const steadyUrl = Deno.env.get('STEADY_SUPABASE_URL')
      const steadyKey = Deno.env.get('STEADY_SUPABASE_SERVICE_ROLE_KEY')
      if (!steadyUrl || !steadyKey) {
        return json({
          error: 'Steady publishing needs STEADY_SUPABASE_URL and STEADY_SUPABASE_SERVICE_ROLE_KEY in Supabase vault — these are for Steady\'s own separate Supabase project (mjuctguhtvsywbulktoh.supabase.co), not this one, and are not configured yet.',
        }, 500)
      }
      const steadyAdmin = createClient(steadyUrl, steadyKey)
      const excerpt = blog.meta_description || stripHtml(blog.content_html).slice(0, 200)
      const { error: insErr } = await steadyAdmin.from('blog_posts').upsert({
        slug,
        title: blog.title,
        excerpt,
        content: blog.content_html || '',
        published: true,
        published_at: now,
        updated_at: now,
      }, { onConflict: 'slug' })
      if (insErr) return json({ error: `Steady insert failed: ${insErr.message}` }, 502)

      const { error: updErr } = await admin.from('mkt_blog_posts').update({ status: 'published', published_at: now }).eq('id', blog_id)
      if (updErr) return json({ error: `Published to Steady, but could not update status here: ${updErr.message}` }, 500)

      return json({ ok: true, method: 'steady', liveUrl: `${STEADY_SITE_URL}/blog/${slug}`, published_at: now })
    }

    // ── Branch 3: everyone else (YCA, PS, OUAY, Quill, Riverside, …) ──────────
    // No deploy target exists yet — mark published and hand back a
    // standalone HTML file for Adrian to paste/upload manually.
    const { error: updErr } = await admin.from('mkt_blog_posts').update({ status: 'published', published_at: now }).eq('id', blog_id)
    if (updErr) return json({ error: updErr.message }, 500)

    return json({
      ok: true,
      method: 'manual',
      published_at: now,
      filename: `${slug}.html`,
      htmlContent: buildStandaloneHtml(blog),
    })
  } catch (e) {
    console.error('[publish-approved-blog] Unhandled error:', String((e as Error)?.message ?? e))
    return json({ error: String((e as Error)?.message ?? e) }, 500)
  }
})
