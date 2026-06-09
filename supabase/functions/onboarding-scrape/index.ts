// Supabase Edge Function: onboarding-scrape  (Deno)
// On new client: scrape brand colour + logo, score the website /100, store it.
// Invoke: supabase.functions.invoke('onboarding-scrape', { body: { client_id, website_url } })
//
// Deploy:  supabase functions deploy onboarding-scrape
// Secrets (Supabase vault): ANTHROPIC_API_KEY (for the copy-quality score)
// Storage: a public bucket 'mkt-assets' must exist (logos saved at clients/<id>/logo.<ext>).
//
// NOTE: the Deno edge runtime can't run Puppeteer/Chromium. This uses a fetch +
// HTML parse + an AI copy score, which covers colours, logo, meta and on-page
// signals. For JS-rendered sites / true page-speed metrics, point this at an
// external headless-browser service (e.g. Browserless) — flagged for later.
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
const MODEL = 'claude-haiku-4-5-20251001'
const abs = (base: string, href: string | null) => { if (!href) return null; try { return new URL(href, base).toString() } catch { return null } }
const clamp = (n: number) => Math.max(0, Math.min(100, Math.round(n)))

async function copyScore(text: string): Promise<number> {
  const key = Deno.env.get('ANTHROPIC_API_KEY')
  const snippet = text.replace(/\s+/g, ' ').slice(0, 1500)
  if (!key || !snippet) return 60
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: MODEL, max_tokens: 10,
        system: 'You rate website homepage copy quality from 0 to 100 for a small UK business. Reply with ONLY the integer.',
        messages: [{ role: 'user', content: snippet }],
      }),
    })
    const j = await r.json()
    const n = parseInt((j?.content?.[0]?.text || '').replace(/\D/g, ''), 10)
    return Number.isFinite(n) ? clamp(n) : 60
  } catch { return 60 }
}

serve(async (req) => {
  const json = (b: unknown, s = 200) =>
    new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } })
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })

  try {
    const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
    const userClient = createClient(SUPABASE_URL, Deno.env.get('SUPABASE_ANON_KEY')!, {
      global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } },
    })
    const { data: isAdmin } = await userClient.rpc('mkt_is_admin')
    if (isAdmin !== true) return json({ error: 'Not authorised' }, 403)

    const { client_id, website_url } = await req.json()
    if (!client_id || !website_url) return json({ error: 'client_id and website_url required' }, 400)
    let target = String(website_url).trim()
    if (!/^https?:\/\//i.test(target)) target = 'https://' + target

    const admin = createClient(SUPABASE_URL, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)

    const started = Date.now()
    const res = await fetch(target, { headers: { 'User-Agent': 'Mozilla/5.0 (YCA-Scrape/1.0)' }, redirect: 'follow' })
    const ms = Date.now() - started
    const html = await res.text()
    const lower = html.toLowerCase()
    const pick = (re: RegExp) => { const m = html.match(re); return m ? m[1].trim() : null }

    // Brand colour + logo
    const themeColor = pick(/<meta[^>]+name=["']theme-color["'][^>]+content=["']([^"']+)["']/i)
    const hexes = (html.match(/#[0-9a-fA-F]{6}\b/g) || [])
    const primary = themeColor || hexes[0] || '#1C2B3A'
    const secondary = (hexes.find((h) => h.toLowerCase() !== primary.toLowerCase())) || '#253545'
    const ogImage = pick(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)
    const apple = pick(/<link[^>]+rel=["']apple-touch-icon[^"']*["'][^>]+href=["']([^"']+)["']/i)
    const logoSrc = abs(target, ogImage) || abs(target, apple) || abs(target, '/favicon.ico')

    // Scores
    const text = html.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ')
    const mobile = /<meta[^>]+name=["']viewport["']/i.test(html) ? 90 : 40
    const ctaWords = ['book', 'call', 'contact', 'get a quote', 'quote', 'buy', 'sign up', 'enquire', 'get started', 'request']
    const ctaHits = ctaWords.filter((w) => lower.includes(w)).length
    const cta = clamp(40 + ctaHits * 12)
    const trustWords = ['review', 'testimonial', 'trustpilot', 'rated', 'guarantee', 'accredited', 'insured', 'certified', 'gas safe', 'years']
    const trustHits = trustWords.filter((w) => lower.includes(w)).length
    const trust = clamp(35 + trustHits * 10)
    const copy = await copyScore(text)
    const speed = clamp(ms < 600 ? 95 : ms < 1500 ? 80 : ms < 3000 ? 60 : 40)

    const breakdown = { mobile, copy, cta, trust }
    const website_score = clamp(mobile * 0.30 + copy * 0.25 + cta * 0.20 + trust * 0.15 + speed * 0.10)

    // Upload logo to Storage (best-effort); fall back to the source URL.
    let logo_url = logoSrc
    try {
      if (logoSrc) {
        const img = await fetch(logoSrc)
        if (img.ok) {
          const ct = img.headers.get('content-type') || 'image/png'
          const ext = ct.includes('svg') ? 'svg' : ct.includes('jpeg') ? 'jpg' : ct.includes('webp') ? 'webp' : 'png'
          const bytes = new Uint8Array(await img.arrayBuffer())
          const path = `clients/${client_id}/logo.${ext}`
          const up = await admin.storage.from('mkt-assets').upload(path, bytes, { contentType: ct, upsert: true })
          if (!up.error) logo_url = admin.storage.from('mkt-assets').getPublicUrl(path).data.publicUrl
        }
      }
    } catch { /* keep source URL */ }

    await admin.from('mkt_clients').update({
      brand_primary_color: primary, brand_secondary_color: secondary, logo_url,
      website_score, website_score_breakdown: breakdown,
    }).eq('id', client_id)

    return json({ ok: true, brand_primary_color: primary, brand_secondary_color: secondary, logo_url, website_score, website_score_breakdown: breakdown })
  } catch (e) {
    return json({ error: String((e as Error)?.message ?? e) }, 500)
  }
})
