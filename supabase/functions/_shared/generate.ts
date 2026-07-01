// Shared Anthropic call + pillar rotation + weekday helpers for the
// content-generating edge functions.
import { buildSystemPrompt, buildUserMessage } from './prompts.ts'

export const MODEL = 'claude-haiku-4-5-20251001'

export async function callAnthropic(system: string, userMessage: string, maxTokens = 600): Promise<string> {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': Deno.env.get('ANTHROPIC_API_KEY')!,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ model: MODEL, max_tokens: maxTokens, system, messages: [{ role: 'user', content: userMessage }] }),
  })
  if (!r.ok) {
    const errText = await r.text()
    throw new Error(`Anthropic API error ${r.status}: ${errText.slice(0, 400)}`)
  }
  const ai = await r.json()
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
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': Deno.env.get('ANTHROPIC_API_KEY')!,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: maxTokens,
      system,
      messages: [{ role: 'user', content: userMessage }],
      tools: [{ name: toolName, description: `Return ${toolName} as structured data.`, input_schema: schema }],
      tool_choice: { type: 'tool', name: toolName },
    }),
  })
  if (!r.ok) {
    const errText = await r.text()
    throw new Error(`Anthropic API error ${r.status}: ${errText.slice(0, 400)}`)
  }
  const ai = await r.json()
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

// ── Weekday helpers (UK time) ─────────────────────────────────────────────
export function isWeekday(d: Date): boolean {
  const dow = Number(
    new Intl.DateTimeFormat('en-GB', { weekday: 'short', timeZone: 'Europe/London' })
      .format(d)
      .replace(/Sun/, '0').replace(/Mon/, '1').replace(/Tue/, '2').replace(/Wed/, '3')
      .replace(/Thu/, '4').replace(/Fri/, '5').replace(/Sat/, '6')
  )
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
  const dow = Number(
    new Intl.DateTimeFormat('en-GB', { weekday: 'short', timeZone: 'Europe/London' })
      .format(d)
      .replace(/Sun/, '0').replace(/Mon/, '1').replace(/Tue/, '2').replace(/Wed/, '3')
      .replace(/Thu/, '4').replace(/Fri/, '5').replace(/Sat/, '6')
  )
  return addDays(d, (7 - dow) % 7)
}

// Instagram (and any platform) hard block — never generate for a platform the
// client hasn't connected. Used by every generation path, no exceptions.
export function isPlatformConnected(client: Record<string, any>, platform: string): boolean {
  const connected: string[] = client.connected_platforms || ['facebook']
  return connected.includes(platform)
}
