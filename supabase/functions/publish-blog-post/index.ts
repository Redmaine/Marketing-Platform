// Supabase Edge Function: publish-blog-post  (Deno)
// Publishes a draft from mkt_website_posts live: commits a markdown file
// (with frontmatter) to the brand's GitHub repo, then triggers a Netlify
// deploy of that site. On success, marks the post published.
//
// Invoke (agency, authenticated): supabase.functions.invoke('publish-blog-post',
//   { body: { post_id } })
//
// Deploy:  supabase functions deploy publish-blog-post
// Secrets (Supabase vault — set via `supabase secrets set`): GITHUB_TOKEN, NETLIFY_API_TOKEN
//
// IMPORTANT — only Hormonely and Neuro Decoded are wired below. This is not
// an oversight:
//   - Quill (byquill.co.uk) has no linked GitHub repo at all — its Netlify
//     site is a direct/manual deploy, not git-connected. There is nothing
//     for a "commit a file" step to target.
//   - Steady (steadyme.co.uk) already has its own complete, independent blog
//     CMS (src/pages/blog + src/pages/admin/BlogAdmin.jsx in the Redmaine/steady
//     repo) reading from a `blog_posts` table in Steady's OWN Supabase
//     project — separate from this ops platform's database. Committing a
//     markdown file into that repo would land nowhere the live site reads
//     from, and would silently do nothing while reporting "published".
// Both are left unmapped on purpose so BRAND_CONFIG lookups fail loudly
// with an explanatory error instead of a false "success".
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { cors, json } from '../_shared/cors.ts'

type BrandConfig = { repo: string; branch: string; dir: string; netlifySiteId: string }

// client.slug -> where to publish. See the header comment for why Quill and
// Steady are deliberately absent.
const BRAND_CONFIG: Record<string, BrandConfig> = {
  hormonely: { repo: 'Redmaine/hormonely', branch: 'main', dir: 'content/blog', netlifySiteId: '61c47e7a-f716-453a-a843-9b9a6883e647' },
  'neuro-decoded': { repo: 'Redmaine/neuro-decoded', branch: 'main', dir: 'content/blog', netlifySiteId: '8ab95da1-2ae8-4cc6-b452-45e9436276b2' },
}

const NOT_WIRED_REASON: Record<string, string> = {
  quill: 'Quill (byquill.co.uk) has no linked GitHub repository — its Netlify site is deployed directly, not from git. Ask Adrian how he wants Quill posts published before wiring this up.',
  steady: 'Steady already has its own blog CMS (steadyme.co.uk/admin/blog) backed by its own Supabase project. Publish there directly — routing through this pipeline would commit a file nothing on the live site reads.',
}

function toBase64(s: string): string {
  return btoa(unescape(encodeURIComponent(s)))
}

function frontmatterEscape(s: string): string {
  // Double-quoted YAML scalar — escape backslashes and quotes.
  return String(s ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

function buildMarkdown(post: Record<string, any>): string {
  const date = (post.published_at ? new Date(post.published_at) : new Date()).toISOString().slice(0, 10)
  const lines = [
    '---',
    `title: "${frontmatterEscape(post.title)}"`,
    `date: "${date}"`,
    `slug: "${frontmatterEscape(post.slug)}"`,
    `excerpt: "${frontmatterEscape(post.excerpt || '')}"`,
    `seo_keyword: "${frontmatterEscape(post.seo_keyword || '')}"`,
  ]
  if (post.featured_image_url) lines.push(`featured_image: "${frontmatterEscape(post.featured_image_url)}"`)
  lines.push('---', '', post.body || '')
  return lines.join('\n')
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })

  try {
    const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
    // Admin-gate on the caller's JWT, exactly like delete-post / schedule-to-metricool.
    const userClient = createClient(SUPABASE_URL, Deno.env.get('SUPABASE_ANON_KEY')!, {
      global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } },
    })
    const { data: isAdmin } = await userClient.rpc('mkt_is_admin')
    if (isAdmin !== true) return json({ error: 'Not authorised' }, 403)

    const { post_id } = await req.json()
    if (!post_id) return json({ error: 'post_id is required' }, 400)

    const admin = createClient(SUPABASE_URL, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)

    const { data: post, error: postErr } = await admin.from('mkt_website_posts').select('*, client:mkt_clients(name, slug)').eq('id', post_id).maybeSingle()
    if (postErr || !post) return json({ error: 'Post not found' }, 404)
    if (post.status === 'published') return json({ error: 'This post is already published.' }, 400)

    const slug: string | undefined = post.client?.slug
    const config = slug ? BRAND_CONFIG[slug] : undefined
    if (!config) {
      const reason = (slug && NOT_WIRED_REASON[slug]) || `${post.client?.name || 'This brand'} is not yet wired for automatic publishing.`
      return json({ error: reason }, 400)
    }

    const githubToken = Deno.env.get('GITHUB_TOKEN')
    if (!githubToken) return json({ error: 'GITHUB_TOKEN not configured in Supabase vault' }, 500)
    const netlifyToken = Deno.env.get('NETLIFY_API_TOKEN')
    if (!netlifyToken) return json({ error: 'NETLIFY_API_TOKEN not configured in Supabase vault' }, 500)

    const path = `${config.dir}/${post.slug}.md`
    const content = buildMarkdown(post)

    // 1. GitHub — look up the existing file's sha (if any) so this is an
    // update rather than a duplicate-create rejection, then commit.
    const ghHeaders = {
      Authorization: `Bearer ${githubToken}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
    }
    const contentsUrl = `https://api.github.com/repos/${config.repo}/contents/${path}`

    let sha: string | undefined
    const getRes = await fetch(`${contentsUrl}?ref=${config.branch}`, { headers: ghHeaders })
    if (getRes.ok) {
      const existing = await getRes.json()
      sha = existing.sha
    } else if (getRes.status !== 404) {
      const raw = await getRes.text()
      return json({ error: `GitHub lookup failed (${getRes.status}): ${raw.slice(0, 300)}` }, 502)
    }

    const putRes = await fetch(contentsUrl, {
      method: 'PUT',
      headers: ghHeaders,
      body: JSON.stringify({
        message: `${sha ? 'Update' : 'Add'} blog post: ${post.title}`,
        content: toBase64(content),
        branch: config.branch,
        ...(sha ? { sha } : {}),
      }),
    })
    if (!putRes.ok) {
      const raw = await putRes.text()
      return json({ error: `GitHub commit failed (${putRes.status}): ${raw.slice(0, 300)}` }, 502)
    }
    const commit = await putRes.json()

    // 2. Netlify — trigger a fresh deploy so the new file is live. Sites here
    // are git-linked and normally auto-deploy on push, but this call makes
    // the deploy explicit rather than relying on that being enabled.
    const deployRes = await fetch(`https://api.netlify.com/api/v1/sites/${config.netlifySiteId}/builds`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${netlifyToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    if (!deployRes.ok) {
      const raw = await deployRes.text()
      // The commit already landed — don't leave the post stuck in draft over
      // a deploy-trigger hiccup, but surface it so it can be checked.
      return json({
        ok: true,
        committed: true,
        deployTriggered: false,
        warning: `File committed to GitHub, but triggering the Netlify deploy failed (${deployRes.status}): ${raw.slice(0, 300)}. The site's auto-deploy-on-push should still pick it up if enabled.`,
      })
    }
    const deploy = await deployRes.json()

    const now = new Date().toISOString()
    const { error: updateErr } = await admin.from('mkt_website_posts')
      .update({ status: 'published', published_at: now, updated_at: now })
      .eq('id', post_id)
    if (updateErr) {
      return json({
        ok: true,
        committed: true,
        deployTriggered: true,
        warning: `Published live, but could not update the post's status in the database: ${updateErr.message}`,
      })
    }

    return json({
      ok: true,
      committed: true,
      deployTriggered: true,
      commitUrl: commit?.content?.html_url ?? null,
      deployId: deploy?.id ?? null,
      published_at: now,
    })
  } catch (e) {
    console.error('[publish-blog-post] Unhandled error:', String((e as Error)?.message ?? e))
    return json({ error: String((e as Error)?.message ?? e) }, 500)
  }
})
