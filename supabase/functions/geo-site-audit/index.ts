// Supabase Edge Function: geo-site-audit  (Deno)
//
// Audits one domain for "generative engine optimisation" (GEO) signals — the
// on-page things that determine whether AI assistants (ChatGPT, Perplexity,
// Google AI Overviews, etc.) can understand, cite, and recommend a site.
// Checks: Schema.org structured data, FAQPage schema specifically, an
// llms.txt file, published pricing, and dated-content freshness. Writes one
// row per run to geo_audit_results (migration 97) and returns the same
// result inline.
//
// Invoke: supabase.functions.invoke('geo-site-audit', { body: { domain, client_id?, source? } })
//   domain     - required, with or without a scheme (https:// assumed)
//   client_id  - optional; set for Redmaine's own brands, omit for prospects
//   source     - 'internal' | 'prospect', defaults to 'prospect' if omitted
//
// Auth: either an admin-authenticated dashboard user (mkt_is_admin), or the
// shared cron/service credential (checkCronAuth — CRON_SECRET header or a
// service_role bearer) for scripted/batch runs. Not on any schedule itself;
// batch runs (e.g. across all active brand sites) are driven externally.
//
// Deploy:  supabase functions deploy geo-site-audit
// No new secrets required beyond what's already in this project's vault.
//
// FAQPage detection mirrors the shape publish-approved-blog/index.ts's
// buildFaqSchema() produces (an "@type":"FAQPage" JSON-LD node) — this
// function detects that shape on a live page rather than generating it.
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { checkCronAuth } from '../_shared/cronAuth.ts'

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const FETCH_TIMEOUT_MS = 10_000
const USER_AGENT = 'Mozilla/5.0 (compatible; GeoSiteAudit/1.0; +https://yourcompanyai.co.uk)'

function normaliseOrigin(domain: string): string {
  let d = domain.trim()
  if (!/^https?:\/\//i.test(d)) d = 'https://' + d
  return d.replace(/\/+$/, '')
}

async function fetchWithTimeout(url: string, init: RequestInit = {}, timeoutMs = FETCH_TIMEOUT_MS): Promise<Response | null> {
  const controller = new AbortController()
  const t = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { ...init, signal: controller.signal, headers: { 'User-Agent': USER_AGENT, ...(init.headers || {}) } })
  } catch {
    return null
  } finally {
    clearTimeout(t)
  }
}

async function fetchHtml(url: string): Promise<string | null> {
  const res = await fetchWithTimeout(url, { method: 'GET' })
  if (!res || !res.ok) return null
  try {
    return await res.text()
  } catch {
    return null
  }
}

function stripHtml(html: string): string {
  return String(html ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
}

// A client-rendered SPA whose initial HTML is just a script-loading shell
// (confirmed live: hormonely.co.uk, neurodecoded.co.uk, onceuponayou.co.uk,
// riversideonline.co.uk, steadyme.co.uk all served under 1.5KB of real HTML
// with no body text at all — everything is filled in by JavaScript after
// load). This edge runtime can't execute JavaScript to see past that (same
// documented limitation as onboarding-scrape/index.ts's own header comment),
// so every other check below is checking a page that most non-JS AI
// crawlers and search bots never actually see rendered — worth its own
// explicit finding since it undermines every other signal at once, not
// just content freshness.
const THIN_SHELL_TEXT_THRESHOLD = 250

function isThinShellHtml(html: string, visibleText: string): boolean {
  if (visibleText.length >= THIN_SHELL_TEXT_THRESHOLD) return false
  return /<div[^>]+id=["'](root|app|__next)["']/i.test(html) || visibleText.length < 100
}

// ── Schema.org / JSON-LD ────────────────────────────────────────────────
const JSON_LD_RE = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi

function extractJsonLdBlocks(html: string): unknown[] {
  const blocks: unknown[] = []
  let m: RegExpExecArray | null
  JSON_LD_RE.lastIndex = 0
  while ((m = JSON_LD_RE.exec(html))) {
    try {
      blocks.push(JSON.parse(m[1].trim()))
    } catch {
      // malformed JSON-LD — skip rather than fail the whole audit
    }
  }
  return blocks
}

function hasSchemaMarkup(html: string, jsonLdBlocks: unknown[]): boolean {
  if (jsonLdBlocks.length > 0) return true
  return /itemtype=["']https?:\/\/schema\.org\//i.test(html)
}

// Same shape as publish-approved-blog's buildFaqSchema() output: a node
// (top-level or nested in @graph) whose @type is "FAQPage".
function hasFaqSchema(html: string, jsonLdBlocks: unknown[]): boolean {
  const isFaqType = (val: unknown): boolean => {
    if (typeof val === 'string') return val === 'FAQPage'
    if (Array.isArray(val)) return val.some(isFaqType)
    return false
  }
  for (const block of jsonLdBlocks) {
    if (!block || typeof block !== 'object') continue
    const obj = block as Record<string, unknown>
    if (isFaqType(obj['@type'])) return true
    const graph = obj['@graph']
    if (Array.isArray(graph)) {
      for (const node of graph) {
        if (node && typeof node === 'object' && isFaqType((node as Record<string, unknown>)['@type'])) return true
      }
    }
  }
  return /itemtype=["']https?:\/\/schema\.org\/FAQPage["']/i.test(html)
}

// ── llms.txt ─────────────────────────────────────────────────────────────
async function hasLlmsTxt(origin: string): Promise<boolean> {
  const head = await fetchWithTimeout(`${origin}/llms.txt`, { method: 'HEAD' })
  if (head?.ok) return true
  // Some hosts don't implement HEAD correctly (405/501) — fall back to GET.
  if (head && (head.status === 405 || head.status === 501)) {
    const get = await fetchWithTimeout(`${origin}/llms.txt`, { method: 'GET' })
    return !!get?.ok
  }
  return false
}

// ── Pricing ──────────────────────────────────────────────────────────────
const CURRENCY_PRICE_RE = /[£$€]\s?\d{1,4}(?:[.,]\d{2})?(?:\s?\/?\s?(?:mo|month|yr|year|pm|pa))?/i
const PRICING_WORD_RE = /\b(pricing|price list|our prices|per month|\/mo\b|\/month\b|per year|\/yr\b)\b/i
const PRICING_PATHS = ['/pricing', '/prices', '/plans']

async function detectPricing(origin: string, homeHtml: string, homeText: string): Promise<boolean> {
  if (CURRENCY_PRICE_RE.test(homeText) || PRICING_WORD_RE.test(homeText)) return true
  for (const path of PRICING_PATHS) {
    const res = await fetchWithTimeout(`${origin}${path}`, { method: 'HEAD' })
    if (res?.ok) return true
  }
  return false
}

// ── Content freshness ────────────────────────────────────────────────────
const TIME_DATETIME_RE = /<time[^>]+datetime=["'](\d{4}-\d{2}-\d{2})/gi
const ISO_DATE_IN_TEXT_RE = /\b(20\d{2}-\d{2}-\d{2})\b/g
const FRESHNESS_PATHS = ['/blog', '/news']

// Written-date fallback — many sites (confirmed live: byquill.co.uk/blog's
// "post-date" divs) render dates as plain text like "30 June 2026" or
// "June 30, 2026", with no <time datetime> attribute and no JSON-LD at all.
// Missing this made every one of the 9 brand sites in the first batch run
// score as "no dated content found" despite several having visibly dated
// blog listings — a false negative, not a real gap.
const MONTH_NAMES = 'january|february|march|april|may|june|july|august|september|october|november|december'
const DAY_MONTH_YEAR_RE = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(${MONTH_NAMES})\\s+(20\\d{2})\\b`, 'gi')
const MONTH_DAY_YEAR_RE = new RegExp(`\\b(${MONTH_NAMES})\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(20\\d{2})\\b`, 'gi')
// Month-and-year only, no day (confirmed live: problemsolution.co.uk's
// "First edition · May 2026") — least precise, so it's only ever used as a
// last resort after the day-specific patterns above find nothing.
const MONTH_YEAR_ONLY_RE = new RegExp(`\\b(${MONTH_NAMES})\\s+(20\\d{2})\\b`, 'gi')

function parseWrittenDates(text: string): string[] {
  const dates: string[] = []
  let m: RegExpExecArray | null
  DAY_MONTH_YEAR_RE.lastIndex = 0
  while ((m = DAY_MONTH_YEAR_RE.exec(text))) dates.push(`${m[2]} ${m[1]}, ${m[3]}`)
  MONTH_DAY_YEAR_RE.lastIndex = 0
  while ((m = MONTH_DAY_YEAR_RE.exec(text))) dates.push(`${m[1]} ${m[2]}, ${m[3]}`)
  return dates
}

function parseMonthYearOnlyDates(text: string): string[] {
  const dates: string[] = []
  let m: RegExpExecArray | null
  MONTH_YEAR_ONLY_RE.lastIndex = 0
  while ((m = MONTH_YEAR_ONLY_RE.exec(text))) dates.push(`1 ${m[1]}, ${m[2]}`)
  return dates
}

function extractDatesFromJsonLd(jsonLdBlocks: unknown[]): string[] {
  const dates: string[] = []
  const visit = (val: unknown, depth: number) => {
    if (!val || typeof val !== 'object' || depth > 6) return
    const obj = val as Record<string, unknown>
    for (const key of ['datePublished', 'dateModified']) {
      if (typeof obj[key] === 'string') dates.push(obj[key] as string)
    }
    for (const v of Object.values(obj)) {
      if (Array.isArray(v)) v.forEach((item) => visit(item, depth + 1))
      else if (v && typeof v === 'object') visit(v, depth + 1)
    }
  }
  jsonLdBlocks.forEach((b) => visit(b, 0))
  return dates
}

function mostRecentDate(dateStrings: string[]): string | null {
  const now = Date.now()
  const valid = dateStrings
    .map((s) => new Date(s))
    .filter((d) => !isNaN(d.getTime()) && d.getFullYear() > 2000 && d.getTime() <= now + 86_400_000)
  if (!valid.length) return null
  valid.sort((a, b) => b.getTime() - a.getTime())
  return valid[0].toISOString().slice(0, 10)
}

// Each tier's extractor, strongest signal first (JSON-LD > explicit <time
// datetime> > full written-text dates > bare ISO dates in text >
// month-year-only text, the last two being the least reliable — bare ISO
// could be anything, month-year has no day).
const DATE_TIERS: Array<(html: string) => string[]> = [
  (html) => extractDatesFromJsonLd(extractJsonLdBlocks(html)),
  (html) => [...html.matchAll(TIME_DATETIME_RE)].map((m) => m[1]),
  (html) => parseWrittenDates(html),
  (html) => [...html.matchAll(ISO_DATE_IN_TEXT_RE)].map((m) => m[1]),
  (html) => parseMonthYearOnlyDates(html),
]

// Checks EVERY tier against EVERY page before falling back to a weaker
// tier — not every page against every tier. Confirmed live why this
// matters: byquill.co.uk's homepage mentions "January 2026" in passing
// (a weak, no-day month-year match), while /blog has real, precise,
// far more recent post dates ("1 July 2026"). Resolving page-by-page would
// let the homepage's weak match win just because it was checked first;
// resolving tier-by-tier means the strong /blog date is always found and
// preferred, regardless of which page happens to respond first.
async function detectContentFreshness(origin: string, homeHtml: string): Promise<string | null> {
  const pages = [homeHtml]
  for (const path of FRESHNESS_PATHS) {
    const html = await fetchHtml(`${origin}${path}`)
    if (html) pages.push(html)
  }

  for (const extractTier of DATE_TIERS) {
    const candidates = pages.flatMap(extractTier)
    const best = mostRecentDate(candidates)
    if (best) return best
  }
  return null
}

// ── Scoring + findings ──────────────────────────────────────────────────
interface AuditSignals {
  hasSchemaMarkup: boolean
  hasFaqSchema: boolean
  hasLlmsTxt: boolean
  pricingPublished: boolean
  lastContentUpdateDate: string | null
  isThinShell: boolean
}

function daysSince(dateStr: string | null): number | null {
  if (!dateStr) return null
  return Math.floor((Date.now() - new Date(`${dateStr}T00:00:00Z`).getTime()) / 86_400_000)
}

function computeScore(s: AuditSignals): number {
  let score = 0
  if (s.hasSchemaMarkup) score += 25
  if (s.hasFaqSchema) score += 20
  if (s.hasLlmsTxt) score += 20
  if (s.pricingPublished) score += 15
  const days = daysSince(s.lastContentUpdateDate)
  if (days !== null) {
    if (days <= 30) score += 20
    else if (days <= 90) score += 12
    else score += 5
  }
  return score
}

// Plain-English, gap-only findings — written to drop directly into outreach
// copy with no editing, per spec. Empty array means nothing was found missing.
function buildFindings(s: AuditSignals): string[] {
  const findings: string[] = []
  if (s.isThinShell) {
    findings.push("The homepage's initial HTML is almost empty — the page is built entirely in JavaScript and fills in after load. Most AI crawlers (and a meaningful share of search bots) don't execute JavaScript, so they likely see a blank page instead of the real content. This affects every other signal below, not just one of them.")
  }
  if (!s.hasSchemaMarkup) {
    findings.push('No structured data (Schema.org markup) found on the site — AI assistants like ChatGPT, Perplexity, and Google AI Overviews rely on this to understand and accurately cite your content.')
  }
  if (!s.hasFaqSchema) {
    findings.push("No FAQPage schema found — question-and-answer content isn't marked up for AI-generated answer boxes, a fast-growing source of qualified traffic.")
  }
  if (!s.hasLlmsTxt) {
    findings.push('No llms.txt file at /llms.txt — AI crawlers have no explicit guidance on what content to prioritise or how to reference the site.')
  }
  if (!s.pricingPublished) {
    findings.push("Pricing isn't clearly published anywhere on the site — AI assistants and comparison tools default to competitors when pricing can't be found.")
  }
  const days = daysSince(s.lastContentUpdateDate)
  if (days === null) {
    findings.push('No dated blog or news content found — AI systems favour sites with visible, recently updated content when selecting sources to cite.')
  } else if (days > 90) {
    findings.push(`Most recent dated content is ${days} days old — AI systems favour freshly updated sites when selecting sources to cite.`)
  }
  return findings
}

serve(async (req) => {
  const json = (b: unknown, s = 200) =>
    new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } })
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!

  // Admin dashboard user OR the shared cron/service credential (for
  // scripted/batch runs — see file header).
  let authorised = (await checkCronAuth(req, 'geo-site-audit')).authorised
  if (!authorised) {
    const userClient = createClient(SUPABASE_URL, Deno.env.get('SUPABASE_ANON_KEY') ?? '', {
      global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } },
    })
    const { data: isAdmin } = await userClient.rpc('mkt_is_admin')
    authorised = isAdmin === true
  }
  if (!authorised) return json({ error: 'Not authorised' }, 403)

  const body = await req.json().catch(() => ({} as Record<string, unknown>))
  const domainInput = String(body.domain || '').trim()
  if (!domainInput) return json({ error: 'domain is required' }, 400)
  const clientId = body.client_id ? String(body.client_id) : null
  const source = body.source === 'internal' ? 'internal' : 'prospect'

  const origin = normaliseOrigin(domainInput)
  const domain = origin.replace(/^https?:\/\//i, '')

  const homeHtml = await fetchHtml(origin)
  if (homeHtml === null) return json({ error: `Could not fetch ${origin}` }, 502)

  const jsonLdBlocks = extractJsonLdBlocks(homeHtml)
  const homeText = stripHtml(homeHtml)

  const signals: AuditSignals = {
    hasSchemaMarkup: hasSchemaMarkup(homeHtml, jsonLdBlocks),
    hasFaqSchema: hasFaqSchema(homeHtml, jsonLdBlocks),
    hasLlmsTxt: await hasLlmsTxt(origin),
    pricingPublished: await detectPricing(origin, homeHtml, homeText),
    lastContentUpdateDate: await detectContentFreshness(origin, homeHtml),
    isThinShell: isThinShellHtml(homeHtml, homeText),
  }

  const score = computeScore(signals)
  const findings = buildFindings(signals)

  const admin = createClient(SUPABASE_URL, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
  const { data: inserted, error } = await admin
    .from('geo_audit_results')
    .insert({
      domain,
      client_id: clientId,
      has_schema_markup: signals.hasSchemaMarkup,
      has_faq_schema: signals.hasFaqSchema,
      has_llms_txt: signals.hasLlmsTxt,
      pricing_published: signals.pricingPublished,
      last_content_update_date: signals.lastContentUpdateDate,
      score,
      findings,
      source,
    })
    .select('id')
    .single()

  if (error) return json({ error: `Audit ran but could not be saved: ${error.message}` }, 500)

  return json({
    ok: true,
    id: inserted.id,
    domain,
    score,
    findings,
    has_schema_markup: signals.hasSchemaMarkup,
    has_faq_schema: signals.hasFaqSchema,
    has_llms_txt: signals.hasLlmsTxt,
    pricing_published: signals.pricingPublished,
    last_content_update_date: signals.lastContentUpdateDate,
    is_thin_shell: signals.isThinShell,
  })
})
