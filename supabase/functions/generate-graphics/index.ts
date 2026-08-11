// Supabase Edge Function: generate-graphics  (Deno)
// Item 7 — Monday 07:00 Europe/London (pg_cron). For each ACTIVE client,
// generate one week's graphic copy: a headline (<=6 words), the single word in
// the headline to highlight in the brand accent colour, and a subline
// (<=8 words). Inserted as a draft into mkt_graphic_copy for the current
// Monday, unless one already exists. Copy only — never posts anywhere.
//
// Deploy: supabase functions deploy generate-graphics
// Secrets (vault): ANTHROPIC_API_KEY.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { callAnthropicStructured } from '../_shared/generate.ts'
import { buildSystemPrompt } from '../_shared/prompts.ts'
import { checkCronAuth } from '../_shared/cronAuth.ts'

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type', 'Access-Control-Allow-Methods': 'POST, OPTIONS' }

const SCHEMA = {
  type: 'object',
  properties: {
    headline: { type: 'string', description: 'A punchy headline of NO MORE THAN 6 words. No emoji, no exclamation mark.' },
    highlight_word: { type: 'string', description: 'The single most important word FROM the headline to highlight in the brand accent colour. Must be one word that appears in the headline.' },
    subline: { type: 'string', description: 'A supporting subline of NO MORE THAN 8 words. No emoji, no exclamation mark.' },
  },
  required: ['headline', 'highlight_word', 'subline'],
}

const words = (s: string) => String(s || '').trim().split(/\s+/).filter(Boolean)

serve(async (req) => {
  const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } })
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })

  const auth = await checkCronAuth(req, 'generate-graphics')
  if (!auth.authorised) return auth.response!

  let body: Record<string, unknown> = {}
  try { body = await req.json() } catch { /* */ }
  // DST-safe 07:00 Europe/London (scheduled at 06:00 + 07:00 UTC Monday).
  if (body?.force !== true) {
    const h = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour: 'numeric', hour12: false }).format(new Date()))
    if (h !== 7) return json({ ok: true, skipped: `not 07:00 in London (currently ${h}:00)` })
  }

  const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)

  // This week's Monday (UK), as a date.
  const now = new Date()
  const londonDow = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', weekday: 'short' }).format(now).replace(/Sun/,'0').replace(/Mon/,'1').replace(/Tue/,'2').replace(/Wed/,'3').replace(/Thu/,'4').replace(/Fri/,'5').replace(/Sat/,'6'))
  const monday = new Date(now); monday.setDate(now.getDate() - ((londonDow + 6) % 7))
  const weekOf = monday.toISOString().slice(0, 10)

  const { data: clients } = await admin.from('mkt_clients').select('*').eq('active', true).order('name')
  const results: Record<string, unknown>[] = []

  for (const c of clients ?? []) {
    const { count } = await admin.from('mkt_graphic_copy').select('id', { count: 'exact', head: true }).eq('client_id', c.id).eq('week_of', weekOf)
    if ((count ?? 0) > 0) { results.push({ brand: c.name, skipped: 'already exists' }); continue }

    const system = buildSystemPrompt(c)
    const user = [
      `Write this week's brand graphic copy for ${c.name}.`,
      c.industry ? `Industry: ${c.industry}` : '',
      c.target_customer ? `Audience: ${c.target_customer}` : '',
      c.tone_of_voice ? `Tone: ${c.tone_of_voice}` : '',
      `\nHeadline: max 6 words. Subline: max 8 words. Pick ONE word from the headline to highlight. Return via the write_graphic tool.`,
    ].filter(Boolean).join('\n')

    try {
      let g: Record<string, any> | null = null
      for (let attempt = 1; attempt <= 2; attempt++) {
        const r = await callAnthropicStructured(system, attempt === 1 ? user : `${user}\n\nThe previous attempt was too long — headline must be <=6 words and subline <=8 words.`, 'write_graphic', SCHEMA, 300)
        if (r?.headline && words(r.headline).length <= 6 && words(r.subline).length <= 8) { g = r; break }
        g = r
      }
      if (!g?.headline) { results.push({ brand: c.name, ok: false, error: 'no copy' }); continue }
      // Hard-cap the word limits (<=6 headline, <=8 subline) as a final
      // guarantee even if the model ran over after both attempts.
      const headline = words(g.headline).slice(0, 6).join(' ')
      const subline = words(g.subline).slice(0, 8).join(' ')
      // Ensure highlight word actually appears in the (capped) headline; else
      // fall back to the longest word in it.
      let hl = String(g.highlight_word || '').trim()
      if (!hl || !new RegExp(`\\b${hl.replace(/[^\w]/g,'')}\\b`, 'i').test(headline)) {
        hl = words(headline).sort((a, b) => b.length - a.length)[0] || ''
      }
      const { error } = await admin.from('mkt_graphic_copy').insert({
        client_id: c.id, week_of: weekOf, headline, highlight_word: hl, subline, status: 'draft',
      })
      if (error) { results.push({ brand: c.name, ok: false, error: error.message }); continue }
      results.push({ brand: c.name, ok: true, headline, highlight_word: hl, subline })
    } catch (e) {
      results.push({ brand: c.name, ok: false, error: String((e as Error)?.message ?? e).slice(0, 150) })
    }
  }

  return json({ ok: true, week_of: weekOf, generated: results.filter((r) => r.ok).length, results })
})
