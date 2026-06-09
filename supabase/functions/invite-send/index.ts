// Supabase Edge Function: invite-send  (Deno)
// Creates an invite, optionally emails it (Resend), and returns share URLs.
// Invoke (agency): supabase.functions.invoke('invite-send',
//   { body: { recipient_name?, business_name?, recipient_email?, channel } })
//   channel ∈ 'email' | 'whatsapp' | 'both'
//
// Deploy:  supabase functions deploy invite-send
// Secrets (Supabase vault): RESEND_API_KEY
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
const INVITE_BASE = 'https://start.yourcompanyai.co.uk'
const FROM = 'Your Company AI <hello@yourcompanyai.co.uk>'

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

    const { recipient_name, business_name, recipient_email, channel = 'email' } = await req.json()
    if (!['email', 'whatsapp', 'both'].includes(channel)) return json({ error: 'channel must be email, whatsapp or both' }, 400)

    const admin = createClient(SUPABASE_URL, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
    const { data: invite, error } = await admin.from('mkt_invites').insert({
      recipient_name: recipient_name || null,
      business_name: business_name || null,
      recipient_email: recipient_email || null,
      channel, status: 'sent', sent_at: new Date().toISOString(),
    }).select('token').single()
    if (error) return json({ error: error.message }, 500)

    const inviteUrl = `${INVITE_BASE}?invite=${invite.token}`
    const who = recipient_name ? ` ${recipient_name}` : ''
    const biz = business_name || 'your business'

    // ---- WhatsApp share URL ----
    // PLACEHOLDER COPY — Adrian to finalise before go-live.
    const waMessage = `Hey${who} — I've set something up I think would work well for ${biz}. 30 days free, no card. Have a look: ${inviteUrl}`
    const whatsappUrl = `https://wa.me/?text=${encodeURIComponent(waMessage)}`

    // ---- Optional email send via Resend ----
    let emailSent = false
    if ((channel === 'email' || channel === 'both') && recipient_email) {
      const resendKey = Deno.env.get('RESEND_API_KEY')
      if (resendKey) {
        // PLACEHOLDER EMAIL BODY — Adrian to write final copy before go-live.
        const r = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { Authorization: `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            from: FROM,
            to: recipient_email,
            subject: `An invite for ${biz}`,
            text: `Hi${who},\n\n[PLACEHOLDER — final copy to come.] I've set something up I think would suit ${biz}. 30 days free, no card needed.\n\n${inviteUrl}\n\nAdrian, Your Company AI`,
          }),
        })
        emailSent = r.ok
      }
    }

    return json({
      token: invite.token,
      invite_url: inviteUrl,
      whatsapp_url: whatsappUrl,
      email_sent: emailSent,
    })
  } catch (e) {
    return json({ error: String((e as Error)?.message ?? e) }, 500)
  }
})
