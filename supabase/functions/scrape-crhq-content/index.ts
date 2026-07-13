// Supabase Edge Function: scrape-crhq-content  (Deno) — runs 22:00 daily via
// pg_cron, 2 hours before midnight-cron's 00:00 content generation.
//
// CRHQ-specific pre-generation scrape: pulls Combat Ready HQ's own latest
// YouTube uploads and combatreadyhq.co.uk/news articles from the last 48
// hours, and writes the result to crhq_scrape_cache. midnight-cron reads the
// most recent (< 3h old) row from that table and folds it into that night's
// CRHQ post-generation prompt as real, current context — see
// attachCrhqScrapeIfDue in midnight-cron/index.ts and the CRHQ block in
// _shared/prompts.ts buildUserMessage.
//
// Both the YouTube call and the news-page scrape are best-effort and fully
// independent — either can fail or return nothing without affecting the
// other or failing the run. An empty or failed scrape is NOT an error: it
// just means midnight-cron finds no usable cache row and falls back to the
// standard CRHQ master-prompt pillars, silently, per spec.
//
// Deploy:  supabase functions deploy scrape-crhq-content
// Schedule: see 41_crhq_scrape_cron.sql.
// Secrets (Supabase vault): YOUTUBE_API_KEY (YouTube Data API v3 — no OAuth,
//   API-key only). Until it's set this just skips the video half and still
//   writes whatever news articles it found.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'

const CHANNEL_HANDLE = '@combatreadyhq'
const NEWS_URL = 'https://combatreadyhq.co.uk/news'
const LOOKBACK_HOURS = 48

interface ScrapedVideo {
  title: string
  view_count: number
  published_at: string
  url: string
}

interface ScrapedArticle {
  title: string
  url: string
  published_at: string | null
}

// ── YouTube ──────────────────────────────────────────────────────────────
// Resolves the channel via the forHandle parameter (no OAuth, API key only —
// per the task brief) and returns its uploads-playlist id in the same call,
// so listing recent videos is one cheap playlistItems.list call rather than
// the much more expensive search.list endpoint.
async function resolveChannel(apiKey: string): Promise<{ channelId: string; uploadsPlaylistId: string } | null> {
  const url = `https://www.googleapis.com/youtube/v3/channels?part=contentDetails&forHandle=${encodeURIComponent(CHANNEL_HANDLE)}&key=${apiKey}`
  const r = await fetch(url)
  if (!r.ok) throw new Error(`channels.list failed: ${r.status} ${(await r.text()).slice(0, 300)}`)
  const j = await r.json()
  const item = j?.items?.[0]
  const uploadsPlaylistId = item?.contentDetails?.relatedPlaylists?.uploads
  if (!item?.id || !uploadsPlaylistId) return null
  return { channelId: item.id, uploadsPlaylistId }
}

async function fetchRecentVideos(apiKey: string): Promise<ScrapedVideo[]> {
  const channel = await resolveChannel(apiKey)
  if (!channel) return []

  const plUrl = `https://www.googleapis.com/youtube/v3/playlistItems?part=snippet&playlistId=${channel.uploadsPlaylistId}&maxResults=25&key=${apiKey}`
  const pr = await fetch(plUrl)
  if (!pr.ok) throw new Error(`playlistItems.list failed: ${pr.status} ${(await pr.text()).slice(0, 300)}`)
  const pj = await pr.json()
  const items: Array<Record<string, any>> = pj?.items ?? []

  const cutoff = Date.now() - LOOKBACK_HOURS * 3600_000
  const recent = items.filter((it) => {
    const t = new Date(it?.snippet?.publishedAt ?? 0).getTime()
    return Number.isFinite(t) && t >= cutoff
  })
  if (recent.length === 0) return []

  // Batch view counts in one call rather than one per video.
  const videoIds = recent.map((it) => it?.snippet?.resourceId?.videoId).filter(Boolean)
  const viewsById = new Map<string, number>()
  if (videoIds.length) {
    const statsUrl = `https://www.googleapis.com/youtube/v3/videos?part=statistics&id=${videoIds.join(',')}&key=${apiKey}`
    const vr = await fetch(statsUrl)
    if (vr.ok) {
      const vj = await vr.json()
      for (const v of vj?.items ?? []) viewsById.set(v.id, Number(v?.statistics?.viewCount) || 0)
    }
  }

  return recent
    .filter((it) => it?.snippet?.resourceId?.videoId)
    .map((it) => {
      const id = it.snippet.resourceId.videoId
      return {
        title: it.snippet?.title ?? '',
        view_count: viewsById.get(id) ?? 0,
        published_at: it.snippet?.publishedAt ?? '',
        url: `https://youtube.com/watch?v=${id}`,
      }
    })
}

// ── News page ────────────────────────────────────────────────────────────
function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'").replace(/&quot;/g, '"')
    .trim()
}

// "30 Jun 2026" -> UTC midnight of that day. The news page only gives a date,
// no time of day, so recency is judged at day granularity (see
// isWithinLookback below) rather than a false-precision exact-ms diff.
function parseUkDate(text: string): Date | null {
  const m = text.match(/^(\d{1,2}) ([A-Za-z]{3}) (\d{4})$/)
  if (!m) return null
  const months: Record<string, number> = {
    Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11,
  }
  const mon = months[m[2]]
  if (mon === undefined) return null
  return new Date(Date.UTC(Number(m[3]), mon, Number(m[1])))
}

function isWithinLookback(iso: string | null): boolean {
  if (!iso) return false
  const published = new Date(iso).getTime()
  if (!Number.isFinite(published)) return false
  // Date-only precision means the true publish time could be anywhere in that
  // UTC day, so "today or yesterday" (up to ~48h, plus up to a day of slack
  // either side of the boundary) is the honest equivalent of "last 48 hours"
  // for data this coarse — not an exact 48*3600000ms cutoff.
  const oneDayMs = 86400_000
  const now = Date.now()
  return now - published <= 2 * oneDayMs && published <= now + oneDayMs
}

// Best-effort regex scrape of the Next.js-rendered /news listing page. The
// article grid ships as an inline React Server Component payload
// (self.__next_f.push(...)) rather than plain <a href> markup, so this reads
// that payload's escaped JSON-like text directly instead of trying to parse
// real HTML (no DOM parser is available in the Deno edge runtime — same
// constraint as onboarding-scrape). A handful of cards stream their title in
// a later, separately-referenced chunk this can't resolve; those are
// silently skipped rather than mismatched to the wrong article. That's fine —
// per the file header, a partial or empty result here is a supported, silent
// fallback for midnight-cron, not a failure.
function parseNewsArticles(html: string): ScrapedArticle[] {
  const hrefRe = /\\"href\\":\\"(\/news\/[a-z0-9-]+)\\"/g
  const dateRe = /\\"text-xs text-subtle\\",\\"children\\":\\"(\d{1,2} [A-Za-z]{3} \d{4})\\"/g
  const titleRe = /\\"h3\\",null,\{\\"className\\":\\"font-display[^"]*?\\",\\"children\\":\\"(.*?)\\"\}/g

  const hrefs: Array<{ pos: number; href: string }> = []
  for (const m of html.matchAll(hrefRe)) hrefs.push({ pos: m.index ?? 0, href: m[1] })
  const dates: Array<{ pos: number; date: string }> = []
  for (const m of html.matchAll(dateRe)) dates.push({ pos: m.index ?? 0, date: m[1] })
  const titles: Array<{ pos: number; title: string }> = []
  for (const m of html.matchAll(titleRe)) titles.push({ pos: m.index ?? 0, title: m[1] })

  // The date span for a given card sits inside the same href-wrapped object,
  // shortly after the href assignment — the nearest href BEFORE the date is
  // reliably that card's own link.
  function nearestPrecedingHref(pos: number, maxDist = 2000): string | null {
    let best: { pos: number; href: string } | null = null
    for (const h of hrefs) {
      if (h.pos < pos && pos - h.pos <= maxDist && (!best || h.pos > best.pos)) best = h
    }
    return best?.href ?? null
  }

  const seen = new Set<string>()
  const out: ScrapedArticle[] = []
  for (const d of dates) {
    // The h3 title immediately follows its date span within the same card.
    const title = titles.find((t) => t.pos > d.pos && t.pos - d.pos < 300)?.title
    const href = nearestPrecedingHref(d.pos)
    if (!title || !href || seen.has(href)) continue
    seen.add(href)
    const published = parseUkDate(d.date)
    out.push({
      title: decodeEntities(title),
      url: new URL(href, NEWS_URL).toString(),
      published_at: published ? published.toISOString() : null,
    })
  }
  return out
}

async function fetchRecentArticles(): Promise<ScrapedArticle[]> {
  const res = await fetch(NEWS_URL, { headers: { 'User-Agent': 'Mozilla/5.0 (YCA-Scrape/1.0)' } })
  if (!res.ok) throw new Error(`news fetch failed: ${res.status}`)
  const html = await res.text()
  return parseNewsArticles(html).filter((a) => isWithinLookback(a.published_at))
}

// ── Handler ──────────────────────────────────────────────────────────────
serve(async () => {
  const started = Date.now()
  const scraped_at = new Date().toISOString()
  const errors: string[] = []
  let videos: ScrapedVideo[] = []
  let articles: ScrapedArticle[] = []

  const apiKey = Deno.env.get('YOUTUBE_API_KEY')
  if (apiKey) {
    try {
      videos = await fetchRecentVideos(apiKey)
    } catch (e) {
      const msg = `youtube: ${String((e as Error)?.message ?? e)}`
      errors.push(msg)
      console.error(`[scrape-crhq-content] ${msg}`)
    }
  } else {
    console.warn('[scrape-crhq-content] YOUTUBE_API_KEY not set — skipping video scrape')
  }

  try {
    articles = await fetchRecentArticles()
  } catch (e) {
    const msg = `news: ${String((e as Error)?.message ?? e)}`
    errors.push(msg)
    console.error(`[scrape-crhq-content] ${msg}`)
  }

  const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
  const { error: insertError } = await admin.from('crhq_scrape_cache').insert({ scraped_at, videos, articles })
  if (insertError) {
    errors.push(`cache insert: ${insertError.message}`)
    console.error(`[scrape-crhq-content] cache insert failed: ${insertError.message}`)
  }

  const { error: logError } = await admin.from('mkt_cron_log').insert({
    job_name: 'crhq-content-scrape',
    clients_processed: 1,
    posts_generated: 0,
    errors: errors.length ? errors : null,
    duration_ms: Date.now() - started,
  })
  if (logError) console.error(`[scrape-crhq-content] failed to write mkt_cron_log: ${logError.message}`)

  console.log(`[scrape-crhq-content] ${videos.length} video(s), ${articles.length} article(s), ${errors.length} error(s)`)

  return new Response(JSON.stringify({ videos, articles, scraped_at, errors }), {
    headers: { 'Content-Type': 'application/json' },
  })
})
