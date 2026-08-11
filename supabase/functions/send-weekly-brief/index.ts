// Supabase Edge Function: send-weekly-brief  (Deno)
// Item 5 — every Friday 09:00 Europe/London (pg_cron), email each ACTIVE
// client the three-question weekly content brief. Plain text, no HTML, from
// hello@yourcompanyai.co.uk.
//
// Body params (all optional):
//   { test: true }              -> sends ONE email to the agency address only,
//                                  using the first active client's name, so the
//                                  send path can be verified without emailing
//                                  real clients.
//   { test_email: 'x@y.com' }   -> override the test recipient.
//
// Auth: service_role only (called by pg_cron; guarded here too).
// Deploy: supabase functions deploy send-weekly-brief
// Secrets (vault): RESEND_API_KEY.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { checkCronAuth } from '../_shared/cronAuth.ts'

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
const FROM = 'Your Company AI <hello@yourcompanyai.co.uk>'
const AGENCY_EMAIL = 'hello@yourcompanyai.co.uk'

// The exact three questions, plain text. Kept verbatim per the brief.
function briefText(clientName: string): string {
  return [
    `Hi ${clientName},`,
    '',
    `It's time for your weekly content brief. Just reply to this email with a quick answer to each — even one line each helps us make this week's content sharper.`,
    '',
    `1. What is happening in your business next week that we should know about?`,
    '',
    `2. Any news, wins, milestones, or announcements coming up?`,
    '',
    `3. Anything specific you want us to focus content on this week?`,
    '',
    `Thanks,`,
    `Your Company AI`,
  ].join('\n')
}

serve(async (req) => {
  const json = (b: unknown, s = 200) =>
    new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } })
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })

  const auth = await checkCronAuth(req, 'send-weekly-brief')
  if (!auth.authorised) return auth.response!

  let body: Record<string, unknown> = {}
  try { body = await req.json() } catch { /* no body */ }
  const isTest = body?.test === true
  const testEmail = (body?.test_email as string) || AGENCY_EMAIL

  // DST-safe 09:00 Europe/London. pg_cron is UTC-only, so this is scheduled at
  // BOTH 08:00 and 09:00 UTC on Fridays; only the invocation where London
  // local time is 09:00 actually sends (08:00 UTC in BST, 09:00 UTC in GMT).
  // The other invocation no-ops. `force` bypasses this for manual runs.
  if (!isTest && body?.force !== true) {
    const londonHour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour: 'numeric', hour12: false }).format(new Date()))
    if (londonHour !== 9) return json({ ok: true, skipped: `not 09:00 in London (currently ${londonHour}:00)` })
  }

  const resendKey = Deno.env.get('RESEND_API_KEY')
  if (!resendKey) return json({ error: 'email not configured' }, 500)

  const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
  const { data: clients } = await admin.from('mkt_clients')
    .select('name, contact_email, contact_name').eq('active', true).order('name')

  const send = (to: string, subject: string, text: string) =>
    fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: FROM, to, subject, text }),
    })

  const results: Record<string, unknown>[] = []

  if (isTest) {
    const c = (clients ?? [])[0]
    const name = c?.contact_name || c?.name || 'there'
    const res = await send(testEmail, `Your weekly content brief — ${c?.name || 'Test'} (TEST)`, briefText(name))
    return json({ ok: res.ok, test: true, sent_to: testEmail, status: res.status, detail: res.ok ? undefined : await res.text() })
  }

  for (const c of clients ?? []) {
    if (!c.contact_email) { results.push({ brand: c.name, skipped: 'no contact_email' }); continue }
    const name = c.contact_name || c.name
    try {
      const res = await send(c.contact_email, `Your weekly content brief — ${c.name}`, briefText(name))
      results.push({ brand: c.name, to: c.contact_email, ok: res.ok, status: res.status, detail: res.ok ? undefined : (await res.text()).slice(0, 200) })
    } catch (e) {
      results.push({ brand: c.name, to: c.contact_email, ok: false, error: String((e as Error)?.message ?? e).slice(0, 200) })
    }
  }

  return json({ ok: true, sent: results.filter((r) => r.ok).length, total: results.length, results })
})
