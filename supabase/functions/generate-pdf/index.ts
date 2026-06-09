// Supabase Edge Function: generate-pdf  (Deno)
// Renders a branded monthly report PDF and stores it.
// Invoke: supabase.functions.invoke('generate-pdf', { body: { report_id } })
//
// Deploy:  supabase functions deploy generate-pdf
// Storage: a private bucket 'mkt-reports' must exist (see 10_reports_storage.sql).
//
// NOTE: Puppeteer/Chromium can't run in the Deno edge runtime (same constraint
// as onboarding-scrape). We build the PDF programmatically with jsPDF — no
// external render service needed, fully edge-compatible. For pixel-perfect
// HTML-to-PDF you'd point this at a headless-browser service instead.
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { jsPDF } from 'https://esm.sh/jspdf@2.5.1'

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
const STEEL: [number, number, number] = [28, 43, 58]
const EMBER: [number, number, number] = [232, 75, 53]
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')

function toBase64(bytes: Uint8Array): string {
  let bin = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) bin += String.fromCharCode(...bytes.subarray(i, i + chunk))
  return btoa(bin)
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

    const { report_id } = await req.json()
    if (!report_id) return json({ error: 'report_id required' }, 400)

    const admin = createClient(SUPABASE_URL, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
    const { data: report, error: rErr } = await admin.from('mkt_reports').select('*').eq('id', report_id).single()
    if (rErr || !report) return json({ error: 'Report not found' }, 404)
    const { data: client } = await admin.from('mkt_clients').select('*').eq('id', report.client_id).single()
    const { data: perf } = await admin.from('mkt_performance').select('*')
      .eq('client_id', report.client_id).order('week_start', { ascending: false }).limit(1).maybeSingle()

    const pdf = new jsPDF({ unit: 'pt', format: 'a4' })
    const W = pdf.internal.pageSize.getWidth()
    const H = pdf.internal.pageSize.getHeight()
    const M = 48

    // Header band
    pdf.setFillColor(...STEEL); pdf.rect(0, 0, W, 92, 'F')
    // Logo top-left (best-effort; jsPDF supports PNG/JPEG only)
    try {
      if (client?.logo_url) {
        const img = await fetch(client.logo_url)
        const ct = img.headers.get('content-type') || ''
        if (img.ok && (ct.includes('png') || ct.includes('jpeg') || ct.includes('jpg'))) {
          const data = `data:${ct};base64,${toBase64(new Uint8Array(await img.arrayBuffer()))}`
          pdf.addImage(data, ct.includes('png') ? 'PNG' : 'JPEG', M, 26, 40, 40)
        }
      }
    } catch { /* skip logo */ }
    pdf.setTextColor(255, 255, 255)
    pdf.setFont('helvetica', 'bold').setFontSize(18).text(client?.name ?? 'Client', M + 52, 44)
    pdf.setFont('helvetica', 'normal').setFontSize(12).setTextColor(232, 75, 53).text(`${report.month} marketing report`, M + 52, 64)

    // Key stats row
    let y = 132
    const stats = [
      ['Reach', (perf?.reach ?? 0).toLocaleString('en-GB')],
      ['New reviews', String(perf?.new_reviews ?? 0)],
      ['Posts published', String(perf?.posts_published ?? 0)],
      ['Rating', `${perf?.avg_rating ?? client?.google_rating ?? '—'}`],
    ]
    const colW = (W - 2 * M) / 4
    stats.forEach((s, i) => {
      const x = M + i * colW
      pdf.setTextColor(...EMBER).setFont('helvetica', 'bold').setFontSize(22).text(String(s[1]), x, y)
      pdf.setTextColor(120, 120, 130).setFont('helvetica', 'normal').setFontSize(10).text(String(s[0]), x, y + 16)
    })
    pdf.setDrawColor(232, 75, 53); pdf.setLineWidth(2); pdf.line(M, y + 30, W - M, y + 30)

    // Narrative
    y += 58
    pdf.setTextColor(40, 40, 55).setFont('helvetica', 'normal').setFontSize(11)
    const paras = String(report.narrative || '').split(/\n\s*\n/)
    for (const p of paras) {
      const lines = pdf.splitTextToSize(p.trim(), W - 2 * M)
      if (y + lines.length * 16 > H - 80) { pdf.addPage(); y = M }
      pdf.text(lines, M, y); y += lines.length * 16 + 12
    }

    // Footer
    pdf.setDrawColor(225, 225, 230).setLineWidth(1).line(M, H - 56, W - M, H - 56)
    pdf.setTextColor(140, 140, 150).setFontSize(9).text('Marketing by Your Company AI · yourcompanyai.co.uk', M, H - 38)

    const bytes = new Uint8Array(pdf.output('arraybuffer'))
    const path = `${report.client_id}/${slug(report.month)}.pdf`
    const up = await admin.storage.from('mkt-reports').upload(path, bytes, { contentType: 'application/pdf', upsert: true })
    if (up.error) return json({ error: up.error.message }, 500)

    const { data: signed } = await admin.storage.from('mkt-reports').createSignedUrl(path, 60 * 60 * 24 * 365)
    const url = signed?.signedUrl ?? null
    await admin.from('mkt_reports').update({ pdf_url: url }).eq('id', report_id)

    return json({ url, path })
  } catch (e) {
    return json({ error: String((e as Error)?.message ?? e) }, 500)
  }
})
