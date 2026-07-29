// Supabase Edge Function: check-client-news  (Deno) — runs daily at 09:00 via pg_cron
// Lightweight event monitoring. For each active client:
//   1. Fetch one RSS feed relevant to their industry (hardcoded per-industry map).
//   2. Score each headline against the client's content pillars by simple
//      keyword matching — no Anthropic call at this stage.
//   3. Only headlines scoring above 3 keyword matches go to a single Haiku
//      call that both assesses relevance/appropriateness AND (if warranted)
//      drafts the post, in one structured call.
//   4. Draft posts land in mkt_content_queue flagged "News trigger: ..." with
//      the source headline noted. Capped at 2 news-triggered posts/client/day.
//
// Deploy:  supabase functions deploy check-client-news
// Schedule: see 25_check_client_news_cron.sql. Secrets (vault): ANTHROPIC_API_KEY.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { buildSystemPrompt } from '../_shared/prompts.ts'
import { callAnthropicStructured, stripMarkdown } from '../_shared/generate.ts'

// deno-lint-ignore no-explicit-any
type Admin = any

const MAX_NEWS_POSTS_PER_CLIENT_PER_DAY = 2
const KEYWORD_SCORE_THRESHOLD = 3

// Hardcoded per-industry RSS feed. Falls back to BBC Business for anything
// not explicitly listed.
const FEED_BY_INDUSTRY: Record<string, { name: string; url: string }> = {
  'News & Defence Media': { name: 'BBC News (UK)', url: 'http://feeds.bbci.co.uk/news/uk/rss.xml' },
  'Health Information': { name: 'NHS England News', url: 'https://www.england.nhs.uk/feed/' },
}
const DEFAULT_FEED = { name: 'BBC Business', url: 'http://feeds.bbci.co.uk/news/business/rss.xml' }

const STOPWORDS = new Set(['the', 'and', 'for', 'with', 'from', 'that', 'this', 'your', 'you', 'are', 'was', 'were', 'a', 'an', 'of', 'to', 'in', 'on', 'is', 'it', 'as', 'at', 'by', 'or'])

interface Headline { title: string; description: string }

function decodeEntities(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'").replace(/&quot;/g, '"')
    .replace(/<[^>]+>/g, '')
    .trim()
}

// Minimal, dependency-free RSS 2.0 <item> parser. Good enough for BBC/NHS
// feeds — no need to pull in a full XML parser for a headline scan.
function parseRss(xml: string): Headline[] {
  const items: Headline[] = []
  const itemBlocks = xml.match(/<item[\s\S]*?<\/item>/g) ?? []
  for (const block of itemBlocks) {
    const titleMatch = block.match(/<title>([\s\S]*?)<\/title>/)
    const descMatch = block.match(/<description>([\s\S]*?)<\/description>/)
    const title = titleMatch ? decodeEntities(titleMatch[1]) : ''
    const description = descMatch ? decodeEntities(descMatch[1]) : ''
    if (title) items.push({ title, description })
  }
  return items
}

function pillarKeywords(pillars: string[]): string[] {
  const words = new Set<string>()
  for (const pillar of pillars) {
    for (const w of pillar.toLowerCase().split(/[^a-z0-9]+/)) {
      if (w.length >= 4 && !STOPWORDS.has(w)) words.add(w)
    }
  }
  return Array.from(words)
}

function keywordScore(headline: Headline, keywords: string[]): number {
  const text = `${headline.title} ${headline.description}`.toLowerCase()
  return keywords.reduce((n, kw) => (text.includes(kw) ? n + 1 : n), 0)
}

const ASSESS_SCHEMA = {
  type: 'object',
  properties: {
    warrants_post: { type: 'boolean', description: 'True only if this headline is genuinely relevant and appropriate to post about for this brand right now.' },
    reason: { type: 'string', description: 'One sentence — why it does or does not warrant a post.' },
    post_body: { type: 'string', description: 'If warrants_post is true: the full social post, 150-250 words, in the brand voice, referencing the real headline generally without inventing extra facts. Empty string if warrants_post is false.' },
  },
  required: ['warrants_post', 'reason', 'post_body'],
}

async function todaysNewsPostCount(admin: Admin, clientId: string): Promise<number> {
  const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0)
  const { count } = await admin
    .from('mkt_content_queue')
    .select('id', { count: 'exact', head: true })
    .eq('client_id', clientId)
    .like('pillar', 'News trigger:%')
    .gte('created_at', dayStart.toISOString())
  return count ?? 0
}

serve(async () => {
  const started = Date.now()
  const errors: string[] = []
  let clientsProcessed = 0
  let postsGenerated = 0

  const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)

  try {
    const { data: clients } = await admin.from('mkt_clients').select('*').eq('active', true).order('name')

    for (const client of clients ?? []) {
      clientsProcessed++
      try {
        const feed = FEED_BY_INDUSTRY[client.industry] ?? DEFAULT_FEED
        const pillars: string[] = client.content_pillars ?? []
        if (pillars.length === 0) continue

        const rssRes = await fetch(feed.url)
        if (!rssRes.ok) { errors.push(`${client.name}: feed fetch failed (${rssRes.status})`); continue }
        const headlines = parseRss(await rssRes.text())
        if (headlines.length === 0) continue

        const keywords = pillarKeywords(pillars)
        const scored = headlines
          .map((h) => ({ h, score: keywordScore(h, keywords) }))
          .filter((s) => s.score > KEYWORD_SCORE_THRESHOLD)
          .sort((a, b) => b.score - a.score)

        if (scored.length === 0) continue

        let dailyCount = await todaysNewsPostCount(admin, client.id)
        const connected: string[] = client.connected_platforms?.length ? client.connected_platforms : ['facebook']
        const platform = connected[0]

        for (const { h } of scored) {
          if (dailyCount >= MAX_NEWS_POSTS_PER_CLIENT_PER_DAY) break

          const system = buildSystemPrompt(client)
          const userMessage = [
            `A news headline just came in from ${feed.name} that keyword-matched this brand's content pillars.`,
            `Headline: ${h.title}`,
            h.description ? `Summary: ${h.description}` : '',
            client.industry ? `Industry: ${client.industry}` : '',
            client.tone_of_voice ? `Tone of voice: ${client.tone_of_voice}` : '',
            `Content pillars: ${pillars.join(', ')}`,
            '\nAssess whether this genuinely warrants a social post for this brand — do not force it if it is a weak or inappropriate fit. Respond via the assess_headline tool.',
          ].filter(Boolean).join('\n')

          let result: Record<string, any>
          try {
            result = await callAnthropicStructured(system, userMessage, 'assess_headline', ASSESS_SCHEMA, 700)
          } catch (e) {
            errors.push(`${client.name} (news assess): ${String((e as Error)?.message ?? e)}`)
            continue
          }

          if (!result?.warrants_post || !result?.post_body) continue

          // Same hard backstop every other insert path applies (fill.ts,
          // crhq-nightly-content) — this was the one path into
          // mkt_content_queue that skipped it, so a news-triggered post could
          // ship with raw markdown untouched.
          const body = stripMarkdown(result.post_body)

          const { error } = await admin.from('mkt_content_queue').insert({
            client_id: client.id, platform, content_type: 'post',
            pillar: `News trigger: ${h.title.slice(0, 120)}`,
            body, status: 'draft', generated_by: 'ai',
          })
          if (error) { errors.push(`${client.name}: insert failed — ${error.message}`); continue }

          dailyCount++
          postsGenerated++
        }
      } catch (e) {
        errors.push(`${client.name}: ${String((e as Error)?.message ?? e)}`)
      }
    }
  } catch (e) {
    errors.push(`fatal: ${String((e as Error)?.message ?? e)}`)
  }

  await admin.from('mkt_cron_log').insert({
    job_name: 'check-client-news',
    clients_processed: clientsProcessed,
    posts_generated: postsGenerated,
    errors: errors.length ? errors : null,
    duration_ms: Date.now() - started,
  })

  return new Response(JSON.stringify({ ok: true, clientsProcessed, postsGenerated, errors }), {
    headers: { 'Content-Type': 'application/json' },
  })
})
