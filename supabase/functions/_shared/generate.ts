// Shared Anthropic call + pillar rotation + weekday helpers for the
// content-generating edge functions.
import { buildSystemPrompt, buildUserMessage } from './prompts.ts'

export const MODEL = 'claude-haiku-4-5-20251001'

// Transient Anthropic failures — rate limits (429) and server/overload errors
// (500/502/503/529) — are the real cause of the "some clients generate, others
// fail silently" symptom: on a busy night one client's call hits a 429 while
// the next succeeds, with no retry. These are safe to retry with backoff.
// A 400 (e.g. "credit balance too low") or 401 is terminal and NOT retried —
// retrying those just wastes time and hides the real, actionable error.
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 529])
const MAX_ATTEMPTS = 4

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms))
}

// Shared, retrying POST to the Anthropic messages API. Returns the parsed JSON
// response. Retries transient failures (and network errors) up to MAX_ATTEMPTS
// with exponential backoff (0.8s, 1.6s, 3.2s), honouring a Retry-After header
// when present. Throws a descriptive error on terminal failures or once
// retries are exhausted, so callers can surface a real reason.
async function anthropicRequest(payload: Record<string, unknown>): Promise<Record<string, any>> {
  let lastErr = ''
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let r: Response
    try {
      r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': Deno.env.get('ANTHROPIC_API_KEY')!,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: JSON.stringify(payload),
      })
    } catch (netErr) {
      // Network-level failure — retryable.
      lastErr = `network error: ${String((netErr as Error)?.message ?? netErr)}`
      if (attempt < MAX_ATTEMPTS) { await sleep(800 * 2 ** (attempt - 1)); continue }
      throw new Error(`Anthropic request failed after ${MAX_ATTEMPTS} attempts — ${lastErr}`)
    }

    if (r.ok) return await r.json()

    const errText = await r.text()
    lastErr = `Anthropic API error ${r.status}: ${errText.slice(0, 400)}`
    if (!RETRYABLE_STATUSES.has(r.status) || attempt === MAX_ATTEMPTS) throw new Error(lastErr)

    // Backoff — respect Retry-After (seconds) if the API gave us one.
    const retryAfter = Number(r.headers.get('retry-after'))
    const waitMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 800 * 2 ** (attempt - 1)
    await sleep(waitMs)
  }
  throw new Error(lastErr || 'Anthropic request failed')
}

export async function callAnthropic(system: string, userMessage: string, maxTokens = 600): Promise<string> {
  const ai = await anthropicRequest({ model: MODEL, max_tokens: maxTokens, system, messages: [{ role: 'user', content: userMessage }] })
  return ai?.content?.[0]?.text?.trim() ?? ''
}

// Calls Anthropic with a forced tool-use call so the response is structured
// JSON validated against `schema`, rather than free text we'd have to parse.
export async function callAnthropicStructured(
  system: string,
  userMessage: string,
  toolName: string,
  schema: Record<string, any>,
  maxTokens = 2000,
): Promise<Record<string, any>> {
  const ai = await anthropicRequest({
    model: MODEL,
    max_tokens: maxTokens,
    system,
    messages: [{ role: 'user', content: userMessage }],
    tools: [{ name: toolName, description: `Return ${toolName} as structured data.`, input_schema: schema }],
    tool_choice: { type: 'tool', name: toolName },
  })
  const toolUse = (ai?.content ?? []).find((b: Record<string, any>) => b.type === 'tool_use')
  if (!toolUse) throw new Error('Anthropic did not return a structured tool_use response')
  return toolUse.input
}

export async function generatePost(client: Record<string, any>, platform: string, pillar: string): Promise<string> {
  const system = buildSystemPrompt(client)
  const userMessage = buildUserMessage(client, platform, pillar)
  return callAnthropic(system, userMessage, 600)
}

// ── Pillar rotation ────────────────────────────────────────────────────────
// Picks the next pillar after client.last_pillar_used, wrapping round. Falls
// back to the first pillar (or 'General') if the client has none set, or if
// last_pillar_used no longer matches any current pillar.
export function nextPillar(client: Record<string, any>): string {
  const pillars: string[] = client.content_pillars ?? []
  if (pillars.length === 0) return 'General'
  if (pillars.length === 1) return pillars[0]
  const last = client.last_pillar_used
  const i = last ? pillars.indexOf(last) : -1
  return pillars[(i + 1) % pillars.length]
}

// deno-lint-ignore no-explicit-any
type AdminClient = any

// Fix 4 — topic diversity. Returns the content pillars of this brand's last
// `n` published posts, most recent first, for the diversity check.
export async function recentPublishedPillars(admin: AdminClient, clientId: string, n = 3): Promise<string[]> {
  const { data } = await admin
    .from('published_posts')
    .select('content_pillar, date_sent')
    .eq('client_id', clientId)
    .order('date_sent', { ascending: false })
    .limit(n)
  return (data ?? []).map((r: Record<string, any>) => r.content_pillar).filter(Boolean)
}

// Fix 4 — short "[pillar] opening…" summaries of this brand's most recent
// published posts, so the generator can be shown what to steer away from
// (buildUserMessage lists them). This attacks repeat-topic at the source
// rather than leaving it all to the review step to catch.
export async function recentPublishedSummaries(admin: AdminClient, clientId: string, n = 6): Promise<string[]> {
  const { data } = await admin
    .from('published_posts')
    .select('content_pillar, post_copy, date_sent')
    .eq('client_id', clientId)
    .order('date_sent', { ascending: false })
    .limit(n)
  return (data ?? []).map((r: Record<string, any>) =>
    `[${r.content_pillar || 'n/a'}] ${String(r.post_copy || '').replace(/\s+/g, ' ').trim().slice(0, 140)}`)
}

// Picks a pillar that differs from the brand's last three published posts (and
// from `alsoAvoid`, used to prevent repeats within a single fill run). Falls
// back to the plain rotation if every pillar is in the avoid set (i.e. the
// brand has <= 3 pillars), so a post is always produced.
export async function pickDiversePillar(
  admin: AdminClient,
  client: Record<string, any>,
  alsoAvoid: string[] = [],
): Promise<string> {
  const pillars: string[] = client.content_pillars ?? []
  if (pillars.length === 0) return 'General'
  if (pillars.length === 1) return pillars[0]

  const recent = await recentPublishedPillars(admin, client.id, 3)
  const avoid = new Set([...recent, ...alsoAvoid])
  const fresh = pillars.find((p) => !avoid.has(p))
  return fresh ?? nextPillar(client)
}

// ── Weekday helpers (UK time) ─────────────────────────────────────────────
// 0=Sun .. 6=Sat, computed in UK local time (not UTC) so a post scheduled
// near midnight always lands on the day a UK reader would call "today".
export function dayOfWeekUK(d: Date): number {
  return Number(
    new Intl.DateTimeFormat('en-GB', { weekday: 'short', timeZone: 'Europe/London' })
      .format(d)
      .replace(/Sun/, '0').replace(/Mon/, '1').replace(/Tue/, '2').replace(/Wed/, '3')
      .replace(/Thu/, '4').replace(/Fri/, '5').replace(/Sat/, '6')
  )
}

export function isWeekday(d: Date): boolean {
  const dow = dayOfWeekUK(d)
  return dow >= 1 && dow <= 5
}

export function addDays(d: Date, n: number): Date {
  const x = new Date(d)
  x.setDate(x.getDate() + n)
  return x
}

export function dateOnly(d: Date): string {
  return d.toISOString().slice(0, 10)
}

// ISO week number — used to deterministically rotate the blog pillar without
// touching the social-post rotation pointer (last_pillar_used).
export function weekNumber(d: Date): number {
  const thu = new Date(d.getTime())
  thu.setDate(d.getDate() + 3 - (d.getDay() + 6) % 7)
  const jan4 = new Date(thu.getFullYear(), 0, 4)
  return 1 + Math.round(((thu.getTime() - jan4.getTime()) / 86400000 - 3 + (jan4.getDay() + 6) % 7) / 7)
}

// The Sunday (UK time) of the week containing `d`, at local midnight.
export function sundayOfWeek(d: Date): Date {
  const dow = dayOfWeekUK(d)
  return addDays(d, (7 - dow) % 7)
}

// Instagram (and any platform) hard block — never generate for a platform the
// client hasn't connected. Used by every generation path, no exceptions.
export function isPlatformConnected(client: Record<string, any>, platform: string): boolean {
  const connected: string[] = client.connected_platforms || ['facebook']
  return connected.includes(platform)
}
