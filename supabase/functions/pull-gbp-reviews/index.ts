// Supabase Edge Function: pull-gbp-reviews  (Deno) — CRON, every 6 hours
// Pulls new Google reviews per active client, files urgent tasks for 1–2★, and
// drafts an AI response for each new review.
// Invoke (cron, no body) or { client_id } for one client.
//
// Deploy:  supabase functions deploy pull-gbp-reviews --no-verify-jwt
// (Deployed with JWT verification off so it can be triggered directly by the
// cron schedule — protected instead by a service-role bearer check below,
// same pattern as backfill-content, since this pulls real client data and
// spends Anthropic credits per invocation with no caller in the frontend.)
// Schedule (every 6h): see Phase 5 / dashboard. e.g.
//   supabase functions schedule create pull-gbp-reviews --cron "0 */6 * * *"
// Secrets (Supabase vault): GOOGLE_MY_BUSINESS_API_KEY, ANTHROPIC_API_KEY
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { checkCronAuth } from '../_shared/cronAuth.ts'

const MODEL = 'claude-haiku-4-5-20251001'
const STAR = { STAR_RATING_UNSPECIFIED: 0, ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5 }

async function draftResponse(client: Record<string, unknown>, rating: number, body: string): Promise<string> {
  const key = Deno.env.get('ANTHROPIC_API_KEY')
  if (!key) return ''
  const prompt =
    `Write a response to this Google review for ${client.name}, a ${client.industry ?? 'local'} business. ` +
    `Tone: ${client.tone_of_voice ?? 'warm and human'}. Review rating: ${rating}/5. Review text: ${body || '(no text)'}. ` +
    `Rules: sound like the business owner wrote it personally. Under 60 words. Acknowledge what they said specifically — never generic. ` +
    `For negative reviews: empathetic, no defensiveness, offer to resolve. No emojis. No "we're sorry for any inconvenience". No corporate language. Return only the response text.`
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: MODEL, max_tokens: 200, messages: [{ role: 'user', content: prompt }] }),
    })
    const j = await r.json()
    return j?.content?.[0]?.text?.trim() ?? ''
  } catch { return '' }
}

serve(async (req) => {
  const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json' } })

  const auth = await checkCronAuth(req, 'pull-gbp-reviews')
  if (!auth.authorised) return auth.response!

  try {
    const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    const admin = createClient(Deno.env.get('SUPABASE_URL')!, SERVICE_ROLE_KEY)
    const gbpKey = Deno.env.get('GOOGLE_MY_BUSINESS_API_KEY')
    if (!gbpKey) return json({ error: 'GOOGLE_MY_BUSINESS_API_KEY not configured' }, 500)

    let clientId: string | null = null
    try { clientId = (await req.json())?.client_id ?? null } catch { /* cron: no body */ }

    let q = admin.from('mkt_clients').select('*').eq('active', true).not('gbp_location_id', 'is', null)
    if (clientId) q = admin.from('mkt_clients').select('*').eq('id', clientId)
    const { data: clients } = await q
    let inserted = 0

    for (const client of clients ?? []) {
      if (!client.gbp_location_id) continue
      // Most recent review we already have, to only take newer ones.
      const { data: last } = await admin.from('mkt_reviews').select('review_date')
        .eq('client_id', client.id).order('review_date', { ascending: false }).limit(1).maybeSingle()
      const since = last?.review_date ? new Date(last.review_date) : null

      const res = await fetch(`https://mybusiness.googleapis.com/v4/${client.gbp_location_id}/reviews`, {
        headers: { Authorization: `Bearer ${gbpKey}` },
      })
      if (!res.ok) continue
      const data = await res.json()

      for (const rv of data?.reviews ?? []) {
        const gbpId = rv.reviewId ?? rv.name
        const created = rv.createTime ? new Date(rv.createTime) : new Date()
        if (since && created <= since) continue
        // Dedup.
        const { data: exists } = await admin.from('mkt_reviews').select('id').eq('gbp_review_id', gbpId).maybeSingle()
        if (exists) continue

        const rating = STAR[rv.starRating as keyof typeof STAR] ?? 0
        const reviewer = rv.reviewer?.displayName ?? 'Google user'
        const text = rv.comment ?? ''
        const response = await draftResponse(client, rating, text)

        await admin.from('mkt_reviews').insert({
          client_id: client.id, platform: 'google', reviewer_name: reviewer, rating,
          body: text, review_date: created.toISOString().split('T')[0],
          response_body: response || null, response_status: response ? 'drafted' : 'pending',
          gbp_review_id: gbpId,
        })
        inserted++

        if (rating <= 2) {
          await admin.from('mkt_tasks').insert({
            client_id: client.id, task: `Reply to ${rating}★ review from ${reviewer}`,
            task_type: 'review_response', priority: 1, overdue: false,
            due_date: new Date().toISOString().split('T')[0], completed: false,
          })
        }
      }
    }
    return json({ ok: true, inserted })
  } catch (e) {
    return json({ error: String((e as Error)?.message ?? e) }, 500)
  }
})
