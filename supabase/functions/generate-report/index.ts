// Supabase Edge Function: generate-report  (Deno)
// Writes a three-paragraph monthly report narrative and saves it as a draft.
// Invoke (agency): supabase.functions.invoke('generate-report', { body: { client_id, month } })
//
// Deploy:  supabase functions deploy generate-report
// Secrets (Supabase vault): ANTHROPIC_API_KEY
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
const MODEL = 'claude-haiku-4-5-20251001'

const REPORT_SYSTEM_PROMPT = `You are one of the best copywriters in the UK. You are writing a monthly marketing report for a client. Write three paragraphs. Plain English. Short sentences. Confident, clear, direct. You are reporting results and recommending next steps. Never use: leverage, utilise, comprehensive, seamless, game-changing, passionate, excited, proud, going forward. No bullet points. No headers. No sign-off. Just three paragraphs. First paragraph: what happened this month — the results, plainly stated. Second paragraph: what worked and what the numbers mean for their business. Third paragraph: what you are focusing on next month and why.`

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

    const { client_id, month } = await req.json()
    if (!client_id || !month) return json({ error: 'client_id and month are required' }, 400)

    const admin = createClient(SUPABASE_URL, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
    const { data: client, error: cErr } = await admin.from('mkt_clients').select('*').eq('id', client_id).single()
    if (cErr || !client) return json({ error: 'Client not found' }, 404)

    const { data: perf } = await admin
      .from('mkt_performance').select('*')
      .eq('client_id', client_id).order('week_start', { ascending: false }).limit(1).maybeSingle()

    const userMessage =
      `Client: ${client.name}\n` +
      `Tier: ${client.tier ?? 'n/a'}\n` +
      `Month: ${month}\n` +
      `Reach: ${perf?.reach ?? 0}\n` +
      `New reviews: ${perf?.new_reviews ?? 0}\n` +
      `Posts published: ${perf?.posts_published ?? 0}\n` +
      `Average rating: ${perf?.avg_rating ?? client.google_rating ?? 'n/a'}\n` +
      `Write the three-paragraph report.`

    const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': Deno.env.get('ANTHROPIC_API_KEY')!,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 700,
        system: REPORT_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userMessage }],
      }),
    })
    const ai = await aiRes.json()
    const narrative = ai?.content?.[0]?.text?.trim()
    if (!narrative) return json({ error: 'No narrative came back — try again.', detail: ai?.error?.message }, 502)

    const { data: report, error: rErr } = await admin.from('mkt_reports')
      .insert({ client_id, month, narrative, status: 'draft' })
      .select('*').single()
    if (rErr) return json({ error: rErr.message }, 500)

    return json({ narrative, report_id: report.id })
  } catch (e) {
    return json({ error: String((e as Error)?.message ?? e) }, 500)
  }
})
