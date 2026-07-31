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
//   GITHUB_TOKEN                     — commits to every GITHUB_BRANDS repo
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
// TWO PUBLISH FORMATS — the React/Vite sites (Hormonely, Neuro Decoded, OUAY)
// build their blog from `src/blog/*.md` at build time, so they get a markdown
// file with YAML frontmatter. The three static HTML sites (YCA, PS, Quill)
// have no build step, so a markdown file would never be rendered; they get a
// finished `blog/<slug>.html` page instead.
//
// Rather than embed three sites' worth of markup in this function, each HTML
// site keeps its own `blog/_template.html` (full page, {{TOKEN}} placeholders)
// and a `blog/index.html` listing carrying a `CARD:TEMPLATE` block plus a
// `POSTS:START` marker. This function fetches the template, substitutes, and
// commits the post; then, best-effort, inserts a card into the listing. Each
// site therefore owns its own styling — restyling a blog needs a commit in
// that site's repo, not a redeploy of this function.
//
// NETLIFY — no explicit deploy-trigger call here (unlike publish-blog-post).
// Per the task brief, both sites auto-deploy on push via their existing git
// integration, so a GitHub commit alone is sufficient.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { cors, json } from '../_shared/cors.ts'

type GithubBrand = {
  repo: string
  branch: string
  siteUrl: string
  // 'markdown' -> src/blog/<slug>.md consumed by the site's build step.
  // 'html'     -> a finished blog/<slug>.html page, rendered from the site's
  //               own blog/_template.html (see templatePath/listingPath).
  format: 'markdown' | 'html'
  postPath: string          // '{slug}' is substituted
  templatePath?: string     // html only — page template in the site's repo
  listingPath?: string      // html only — listing page to insert a card into
}

// client.slug -> GitHub-committed brands. Steady is handled separately
// (its own Supabase project, not GitHub). Everything else falls through to
// the download-HTML path.
//
// Repo names confirmed against the Redmaine GitHub account — not guessed.
// onceuponayou-v2 is OUAY's current Netlify source (the older
// onceuponayou-website repo is retired).
//
// yca-website / ps-website / quill-website are the three static marketing
// sites. Note yca-website is the public marketing site — deliberately NOT
// Redmaine/yca-platform, which is the authenticated SaaS app and would be the
// wrong target. All three were previously Netlify Drop deploys with no repo;
// each is now deployed from the repo named here.
const GITHUB_BRANDS: Record<string, GithubBrand> = {
  hormonely: {
    repo: 'Redmaine/hormonely', branch: 'main', siteUrl: 'https://hormonely.co.uk',
    format: 'markdown', postPath: 'src/blog/{slug}.md',
  },
  'neuro-decoded': {
    repo: 'Redmaine/neuro-decoded', branch: 'main', siteUrl: 'https://neurodecoded.co.uk',
    format: 'markdown', postPath: 'src/blog/{slug}.md',
  },
  ouay: {
    repo: 'Redmaine/onceuponayou-v2', branch: 'main', siteUrl: 'https://onceuponayou.co.uk',
    format: 'markdown', postPath: 'src/blog/{slug}.md',
  },
  yca: {
    repo: 'Redmaine/yca-website', branch: 'main', siteUrl: 'https://yourcompanyai.co.uk',
    format: 'html', postPath: 'blog/{slug}.html',
    templatePath: 'blog/_template.html', listingPath: 'blog/index.html',
  },
  ps: {
    repo: 'Redmaine/ps-website', branch: 'main', siteUrl: 'https://problemsolution.co.uk',
    format: 'html', postPath: 'blog/{slug}.html',
    templatePath: 'blog/_template.html', listingPath: 'blog/index.html',
  },
  quill: {
    repo: 'Redmaine/quill-website', branch: 'main', siteUrl: 'https://byquill.co.uk',
    format: 'html', postPath: 'blog/{slug}.html',
    templatePath: 'blog/_template.html', listingPath: 'blog/index.html',
  },
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
// Attribute-safe escape. Template tokens land in both text nodes (<h1>, <title>)
// and attribute values (meta description), so everything substituted into a
// template is escaped this way — safe in both contexts. The one exception is
// {{BODY}}, which is the post's stored content_html and is inserted as-is by
// design.
function escAttr(s: string): string {
  return esc(s).replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

// GitHub's contents API returns base64 with embedded newlines. atob gives
// bytes, not UTF-8 text, so decode through TextDecoder — otherwise every
// non-ASCII character in a template (— · £ →) is corrupted on the round trip.
function fromBase64(b64: string): string {
  const bin = atob(String(b64 ?? '').replace(/\s/g, ''))
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)))
}

// "2026-07-25" -> "25 July 2026". Falls back to today when publish_date is
// null, and to the raw string if it isn't a date we can parse.
function formatDate(dateStr: string | null | undefined): string {
  const raw = dateStr || new Date().toISOString().slice(0, 10)
  const d = new Date(`${raw}T00:00:00Z`)
  if (isNaN(d.getTime())) return String(raw)
  return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(d)
}

function renderTemplate(template: string, tokens: Record<string, string>): string {
  let out = template
  for (const [key, value] of Object.entries(tokens)) {
    out = out.replaceAll(`{{${key}}}`, value)
  }
  return out
}

const CARD_TEMPLATE_RE = /<!--\s*CARD:TEMPLATE([\s\S]*?)CARD:TEMPLATE\s*-->/
const POSTS_START = '<!-- POSTS:START -->'

// Inserts a card for the new post at the top of the listing page, using the
// CARD:TEMPLATE block the listing itself carries. Returns null when there is
// nothing to do (markers missing, or this slug is already listed — which is
// what makes republishing the same post idempotent rather than duplicating).
function insertCard(listing: string, tokens: Record<string, string>, slug: string): string | null {
  const match = CARD_TEMPLATE_RE.exec(listing)
  if (!match || !listing.includes(POSTS_START)) return null
  if (listing.includes(`/blog/${slug}"`)) return null

  const card = renderTemplate(match[1].trim(), tokens)
  return listing
    // Drop the "no posts yet" placeholder now that there is one.
    .replace(/\s*<p class="empty">[\s\S]*?<\/p>/, '')
    .replace(POSTS_START, `${POSTS_START}\n${card}`)
}

// schemaArticleB64/schemaFaqB64: the JSON-LD payloads, base64-encoded.
// These three sites' own frontmatter parsers are small hand-rolled
// key:-per-line readers with no support for multi-line or quote-escaped
// values — raw JSON (colons, quotes, braces) would corrupt on the round
// trip, and worse, each site's markdown-to-HTML step either HTML-escapes or
// (being React) auto-escapes any literal <script> tag placed in the post
// body, so it can never reach the page as a real element that way either.
// Base64 in frontmatter survives their parser intact; each site's blog
// loader decodes it and renders a real <script type="application/ld+json">
// itself (react-helmet-async where already used, e.g. Hormonely, or a
// small effect that appends the element directly, e.g. Neuro Decoded).
function buildMarkdown(post: Record<string, any>, slug: string, brand: string, schemaArticleB64: string, schemaFaqB64: string): string {
  const date = (post.publish_date || new Date().toISOString().slice(0, 10))
  const excerpt = post.meta_description || stripHtml(post.content_html).slice(0, 200)
  const lines = [
    '---',
    `title: "${frontmatterEscape(post.title)}"`,
    `date: "${date}"`,
    `slug: "${frontmatterEscape(slug)}"`,
    `excerpt: "${frontmatterEscape(excerpt)}"`,
    `brand: "${frontmatterEscape(brand)}"`,
    `schema_article: "${schemaArticleB64}"`,
    ...(schemaFaqB64 ? [`schema_faq: "${schemaFaqB64}"`] : []),
    '---',
    '',
    post.content_html || '',
  ]
  return lines.join('\n')
}

// On a publish failure, mark the blog row publish_failed (visibly distinct
// from an un-approved draft) and log the reason to edge_function_errors so it
// shows up in the daily status digest. Both writes are best-effort — a failure
// to record the failure must not mask the original error.
async function markFailed(
  admin: ReturnType<typeof createClient>,
  blogId: string,
  message: string,
): Promise<void> {
  try {
    await admin.from('mkt_blog_posts').update({ status: 'publish_failed' }).eq('id', blogId)
  } catch (e) {
    console.error('[publish-approved-blog] could not set publish_failed:', String((e as Error)?.message ?? e))
  }
  try {
    await admin.from('edge_function_errors').insert({ function_name: 'publish-approved-blog', error_message: message })
  } catch (e) {
    console.error('[publish-approved-blog] could not write edge_function_errors:', String((e as Error)?.message ?? e))
  }
}

// ── Schema.org JSON-LD (SEO task, Parts 2 & 3) ──────────────────────────────
// Built once per publish from data this function already has — never typed
// by hand — so it applies identically across every publish path (GitHub
// markdown, GitHub HTML, Steady, and the manual-handoff fallback).
//
// No per-post author exists (mkt_blog_posts has no author column) and these
// are AI-generated, brand-voice posts with no named human byline, so the
// brand itself is both author and publisher — a legitimate, common pattern
// for corporate/branded blogs, not a fabricated person.
function buildArticleSchema(title: string, description: string, brandName: string, publishedIso: string): Record<string, unknown> {
  return {
    '@context': 'https://schema.org',
    '@type': 'Article',
    headline: title,
    datePublished: publishedIso,
    dateModified: publishedIso,
    author: { '@type': 'Organization', name: brandName },
    publisher: { '@type': 'Organization', name: brandName },
    description,
  }
}

// A title reads as a question even without a trailing "?" — both examples in
// the brief ("How much does a private ADHD assessment cost", "Does HRT cause
// weight gain") lack one, so a leading question-word is checked as well as
// the trailing mark.
const QUESTION_WORDS_RE = /^(how|what|why|when|where|does|do|is|are|can|could|should|will|would)\b/i
function isQuestionTitle(title: string): boolean {
  const t = String(title || '').trim()
  return t.endsWith('?') || QUESTION_WORDS_RE.test(t)
}

// FAQPage schema for question-titled posts only (Part 3) — the answer is the
// post's own opening, capped at 200 words per the brief, not a separately
// hand-written summary.
function buildFaqSchema(title: string, bodyHtml: string): Record<string, unknown> | null {
  if (!isQuestionTitle(title)) return null
  const answer = stripHtml(bodyHtml).split(/\s+/).filter(Boolean).slice(0, 200).join(' ')
  if (!answer) return null
  return {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: [{
      '@type': 'Question',
      name: title,
      acceptedAnswer: { '@type': 'Answer', text: answer },
    }],
  }
}

function schemaScriptTag(data: Record<string, unknown>): string {
  return `<script type="application/ld+json">${JSON.stringify(data)}</script>`
}

function buildStandaloneHtml(post: Record<string, any>, schemaScripts: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>${esc(post.title)}</title>
<meta name="description" content="${esc(post.meta_description || '')}" />
${schemaScripts}
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

  // Captured so the top-level catch can mark the row publish_failed even when
  // the throw happens deep inside a publish branch. Undefined until we've
  // parsed a valid blog_id, so early client errors (bad auth, missing id)
  // never touch a blog row.
  let blogId: string | undefined
  let adminForCatch: ReturnType<typeof createClient> | undefined
  try {
    const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
    const userClient = createClient(SUPABASE_URL, Deno.env.get('SUPABASE_ANON_KEY')!, {
      global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } },
    })
    const { data: isAdmin } = await userClient.rpc('mkt_is_admin')
    if (isAdmin !== true) return json({ error: 'Not authorised' }, 403)

    const { blog_id } = await req.json()
    if (!blog_id) return json({ error: 'blog_id is required' }, 400)
    blogId = blog_id

    const admin = createClient(SUPABASE_URL, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
    adminForCatch = admin

    const { data: blog, error: blogErr } = await admin.from('mkt_blog_posts').select('*').eq('id', blog_id).maybeSingle()
    if (blogErr || !blog) return json({ error: 'Blog post not found' }, 404)
    if (blog.status === 'published') return json({ error: 'This post is already published.' }, 400)

    const { data: client, error: clientErr } = await admin.from('mkt_clients').select('id, name, short_name, slug').eq('id', blog.client_id).maybeSingle()
    if (clientErr || !client) return json({ error: 'Client not found' }, 404)

    const slug = blog.slug || slugify(blog.title)
    const now = new Date().toISOString()

    // Schema.org JSON-LD (SEO task, Parts 2 & 3) — computed once, shared by
    // every branch below, so it's identical regardless of publish path.
    const brandName = client.name || client.short_name || client.slug || ''
    const description = blog.meta_description || stripHtml(blog.content_html).slice(0, 200)
    const articleSchema = buildArticleSchema(blog.title, description, brandName, now)
    const faqSchema = buildFaqSchema(blog.title, blog.content_html || '')
    const schemaScripts = [articleSchema, faqSchema].filter(Boolean).map((s) => schemaScriptTag(s as Record<string, unknown>)).join('\n')
    const schemaArticleB64 = toBase64(JSON.stringify(articleSchema))
    const schemaFaqB64 = faqSchema ? toBase64(JSON.stringify(faqSchema)) : ''

    // ── Branch 1: GitHub-committed brands ─────────────────────────────────────
    // Markdown sites (Hormonely, Neuro Decoded, OUAY) and static HTML sites
    // (YCA, PS, Quill) — see the GITHUB_BRANDS table and the TWO PUBLISH
    // FORMATS note at the top.
    const ghBrand = client.slug ? GITHUB_BRANDS[client.slug] : undefined
    if (ghBrand) {
      const githubToken = Deno.env.get('GITHUB_TOKEN')
      if (!githubToken) {
        await markFailed(admin, blog_id, 'GITHUB_TOKEN not configured in Supabase vault')
        return json({ error: 'GITHUB_TOKEN not configured in Supabase vault', status: 'publish_failed' }, 500)
      }

      const ghHeaders = {
        Authorization: `Bearer ${githubToken}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
      }
      const contentsUrl = (p: string) => `https://api.github.com/repos/${ghBrand.repo}/contents/${p}`

      // Returns null on 404 (file absent), throws on any other failure so a
      // real API problem is never mistaken for "file not there yet".
      const ghGet = async (p: string): Promise<{ text: string; sha: string } | null> => {
        const res = await fetch(`${contentsUrl(p)}?ref=${ghBrand.branch}`, { headers: ghHeaders })
        if (res.status === 404) return null
        if (!res.ok) throw new Error(`GitHub lookup failed (${res.status}) for ${ghBrand.repo}/${p}: ${(await res.text()).slice(0, 300)}`)
        const body = await res.json()
        return { text: fromBase64(body.content), sha: body.sha }
      }
      const ghPut = async (p: string, content: string, message: string, sha?: string): Promise<void> => {
        const res = await fetch(contentsUrl(p), {
          method: 'PUT',
          headers: ghHeaders,
          body: JSON.stringify({ message, content: toBase64(content), branch: ghBrand.branch, ...(sha ? { sha } : {}) }),
        })
        if (!res.ok) throw new Error(`GitHub commit failed (${res.status}) for ${ghBrand.repo}/${p}: ${(await res.text()).slice(0, 300)}`)
      }

      const postPath = ghBrand.postPath.replace('{slug}', slug)

      // Only the listing update below is best-effort; everything here is
      // required, so a failure marks the row publish_failed as before.
      let listingUpdated = false
      try {
        let content: string
        if (ghBrand.format === 'markdown') {
          // Markdown sites (Hormonely, Neuro Decoded, OUAY) — schema travels
          // as base64 frontmatter fields, not inline in the body; see
          // buildMarkdown's own comment for why.
          content = buildMarkdown(blog, slug, brandName, schemaArticleB64, schemaFaqB64)
        } else {
          const tplPath = ghBrand.templatePath!
          const tpl = await ghGet(tplPath)
          if (!tpl) throw new Error(`Blog template ${ghBrand.repo}/${tplPath} not found — cannot render an HTML post without it.`)
          content = renderTemplate(tpl.text, {
            TITLE: escAttr(blog.title),
            DESCRIPTION: escAttr(description),
            DATE: escAttr(formatDate(blog.publish_date)),
            SLUG: escAttr(slug),
            BRAND: escAttr(brandName),
            // Static HTML sites (YCA, PS, Quill) — plain string templating,
            // no markdown/React escaping pass, so the schema scripts survive
            // as real elements prepended straight into the body.
            BODY: schemaScripts + (blog.content_html || ''), // stored HTML, inserted as-is by design
          })
        }

        const existing = await ghGet(postPath)
        await ghPut(postPath, content, `${existing ? 'Update' : 'Add'} blog post: ${blog.title}`, existing?.sha)

        // Listing card — best-effort. The post itself is already committed and
        // live at this point, so a listing failure must not fail the publish;
        // it is logged and surfaced in the response instead.
        if (ghBrand.format === 'html' && ghBrand.listingPath) {
          try {
            const listing = await ghGet(ghBrand.listingPath)
            if (listing) {
              const updated = insertCard(listing.text, {
                TITLE: escAttr(blog.title),
                EXCERPT: escAttr(description),
                DATE: escAttr(formatDate(blog.publish_date)),
                SLUG: escAttr(slug),
                BRAND: escAttr(brandName),
              }, slug)
              if (updated) {
                await ghPut(ghBrand.listingPath, updated, `Add "${blog.title}" to blog index`, listing.sha)
                listingUpdated = true
              }
            }
          } catch (e) {
            const msg = `Post published, but updating ${ghBrand.repo}/${ghBrand.listingPath} failed: ${String((e as Error)?.message ?? e)}`
            console.error(`[publish-approved-blog] ${msg}`)
            try {
              await admin.from('edge_function_errors').insert({ function_name: 'publish-approved-blog', error_message: msg })
            } catch { /* logging the log failure helps nobody */ }
          }
        }
      } catch (e) {
        const msg = String((e as Error)?.message ?? e)
        await markFailed(admin, blog_id, msg)
        return json({ error: msg, status: 'publish_failed' }, 502)
      }

      const liveUrl = `${ghBrand.siteUrl}/blog/${slug}`
      const { error: updErr } = await admin.from('mkt_blog_posts').update({ status: 'published', published_at: now, live_url: liveUrl }).eq('id', blog_id)
      if (updErr) return json({ error: `Committed to GitHub, but could not update status: ${updErr.message}` }, 500)

      return json({ ok: true, method: 'github', format: ghBrand.format, liveUrl, listing_updated: listingUpdated, published_at: now })
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
      const { error: insErr } = await steadyAdmin.from('blog_posts').upsert({
        slug,
        title: blog.title,
        excerpt: description,
        content: schemaScripts + (blog.content_html || ''),
        published: true,
        published_at: now,
        updated_at: now,
      }, { onConflict: 'slug' })
      if (insErr) {
        const msg = `Steady insert failed: ${insErr.message}`
        await markFailed(admin, blog_id, msg)
        return json({ error: msg, status: 'publish_failed' }, 502)
      }

      // Steady's public posts live at /articles, not /blog. Verified against
      // the live site: /articles renders the published post list, /blog renders
      // an empty "No articles published yet" page — a stale legacy route. A
      // live_url built on /blog therefore pointed every published Steady post
      // at a page that would never show it.
      //
      // SEPARATE PRE-EXISTING BUG found while adding schema markup here (not
      // fixed — out of scope for this task, flagging for its own fix): the
      // steady repo's own /articles/:slug route (ArticleDetail.jsx) reads
      // from local src/blog/*.md files via src/blog/index.js, NOT from this
      // upsert into Steady's blog_posts table. A post published through this
      // function is correctly saved to the database but the live page at
      // liveUrl will 404 ("This article doesn't exist") until that
      // mismatch is fixed on Steady's side — ArticlesIndex.jsx (the list
      // page) may or may not share the same issue; not checked.
      const liveUrl = `${STEADY_SITE_URL}/articles/${slug}`
      const { error: updErr } = await admin.from('mkt_blog_posts').update({ status: 'published', published_at: now, live_url: liveUrl }).eq('id', blog_id)
      if (updErr) return json({ error: `Published to Steady, but could not update status here: ${updErr.message}` }, 500)

      return json({ ok: true, method: 'steady', liveUrl, published_at: now })
    }

    // ── Branch 3: everyone else (Riverside, CRHQ, …) ──────────────────────────
    // No deploy target exists yet — mark published (live_url left NULL, since
    // nothing was actually pushed anywhere) and hand back a standalone HTML
    // file for Adrian to paste/upload manually.
    const { error: updErr } = await admin.from('mkt_blog_posts').update({ status: 'published', published_at: now }).eq('id', blog_id)
    if (updErr) return json({ error: updErr.message }, 500)

    return json({
      ok: true,
      method: 'manual',
      published_at: now,
      filename: `${slug}.html`,
      htmlContent: buildStandaloneHtml(blog, schemaScripts),
    })
  } catch (e) {
    const message = String((e as Error)?.message ?? e)
    console.error('[publish-approved-blog] Unhandled error:', message)
    // If we got far enough to identify the blog, record the failure so the row
    // doesn't sit stuck in 'approved' after an unexpected publish crash.
    if (blogId && adminForCatch) await markFailed(adminForCatch, blogId, message)
    return json({ error: message, status: 'publish_failed' }, 500)
  }
})
