// Supabase Edge Function: send-report  (Deno)
// Emails a client their monthly report with the PDF attached.
// Invoke: supabase.functions.invoke('send-report', { body: { report_id } })
//
// Deploy:  supabase functions deploy send-report
// Secrets (Supabase vault): RESEND_API_KEY
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
const FROM = 'Adrian, Your Company AI <hello@yourcompanyai.co.uk>'
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
function toBase64(bytes: Uint8Array): string {
  let bin = ''; const chunk = 0x8000
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
    const { data: report } = await admin.from('mkt_reports').select('*').eq('id', report_id).single()
    if (!report) return json({ error: 'Report not found' }, 404)
    const { data: client } = await admin.from('mkt_clients').select('*').eq('id', report.client_id).single()
    if (!client?.contact_email) return json({ error: 'This client has no contact email.' }, 422)

    // Pull the PDF bytes from storage (regenerate via generate-pdf first if missing).
    const path = `${report.client_id}/${slug(report.month)}.pdf`
    const dl = await admin.storage.from('mkt-reports').download(path)
    if (dl.error || !dl.data) return json({ error: 'No PDF yet — generate it first.' }, 422)
    const pdfB64 = toBase64(new Uint8Array(await dl.data.arrayBuffer()))

    // Headline stat sentence from latest performance.
    const { data: perf } = await admin.from('mkt_performance').select('*')
      .eq('client_id', report.client_id).order('week_start', { ascending: false }).limit(1).maybeSingle()
    const bits: string[] = []
    if (perf?.reach) bits.push(`Reach was up to ${Number(perf.reach).toLocaleString('en-GB')} this month`)
    if (perf?.new_reviews) bits.push(`${perf.new_reviews} new review${perf.new_reviews === 1 ? '' : 's'} came in`)
    const headline = bits.length ? bits.join(' and ') + '.' : 'A solid month — the detail is in the report.'

    const contact = client.contact_name || 'there'
    const body =
      `Hi ${contact},\n\n` +
      `Your ${report.month} report is attached.\n\n` +
      `${headline}\n\n` +
      `Anything you want to talk through, just reply to this email.\n\n` +
      `Adrian\nYour Company AI\nyourcompanyai.co.uk`

    const resendKey = Deno.env.get('RESEND_API_KEY')
    if (!resendKey) return json({ error: 'RESEND_API_KEY not configured' }, 500)
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: FROM,
        to: client.contact_email,
        subject: `Your ${report.month} Marketing Report — ${client.name}`,
        text: body,
        attachments: [{ filename: `${slug(report.month)}-report.pdf`, content: pdfB64 }],
      }),
    })
    if (!r.ok) return json({ error: 'Resend rejected the email.', detail: await r.text() }, 502)

    await admin.from('mkt_reports').update({ sent_to_client: true, sent_at: new Date().toISOString(), status: 'sent' }).eq('id', report_id)
    return json({ ok: true, sent_to: client.contact_email })
  } catch (e) {
    return json({ error: String((e as Error)?.message ?? e) }, 500)
  }
})
