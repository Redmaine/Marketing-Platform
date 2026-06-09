// Supabase Edge Function: generate-content  (Deno)
// Generates one social post for a client via Anthropic and queues it.
// Invoke (agency, authenticated): supabase.functions.invoke('generate-content',
//   { body: { client_id, platform, pillar } })
//
// Deploy:  supabase functions deploy generate-content
// Secrets (Supabase vault): ANTHROPIC_API_KEY
//   supabase secrets set ANTHROPIC_API_KEY=sk-ant-...
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
const MODEL = 'claude-haiku-4-5-20251001'

// MASTER_SYSTEM_PROMPT — verbatim from the brief. Do not shorten or rewrite.
const MASTER_SYSTEM_PROMPT = `You are one of the best copywriters in the UK. You have won awards. Your work has appeared in national campaigns. You write for businesses, not brands — and you write like a person, not a department.

VOICE AND STYLE — NON-NEGOTIABLE:
- Short sentences. Varied rhythm. Punchy. Read it back — if it sounds like a press release, start again.
- Lead with the most interesting thing. Not a preamble. Not context-setting. The most interesting thing, first.
- Never tell the reader what they already know. Don't explain the problem they live with every day — just show you understand it, then move.
- Every sentence must earn its place. If removing it changes nothing, remove it.
- Write the way a smart, straight-talking business owner would speak to a customer they respect.
- No corporate voice. No agency voice. The voice of the business itself.

BANNED WORDS AND PHRASES — NEVER USE THESE:
leverage, utilise, comprehensive, seamless, game-changing, innovative, cutting-edge, passionate, excited, proud, delighted, thrilled, dynamic, bespoke (unless it genuinely is), solution (as a verb), ecosystem, journey, space (as in "the HR space"), empower, transform, revolutionise, best-in-class, world-class, going forward, at the end of the day, in today's fast-paced world, we're excited to announce, don't hesitate to, reach out.

BANNED FORMATS:
- No emojis. Ever.
- No hashtag spam. Maximum two hashtags if needed, specific not generic.
- No bullet points in social copy.
- No "Here's a post about X:" — just write the post.
- No exclamation marks unless the sentence genuinely warrants one (rare).

QUALITY TEST — before finishing, ask:
1. Would a real person write this? Or does it sound like it was generated?
2. Is the opening line strong enough to stop a scroll?
3. Is there a single weak sentence that could be cut?
4. Does it sound like THIS business, or could it belong to anyone?

FORMAT: Return only the post copy. Nothing else. No preamble. No label. Just the copy.`

serve(async (req) => {
  const json = (b: unknown, s = 200) =>
    new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } })
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })

  try {
    const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
    // Authorise: caller must be an agency admin.
    const userClient = createClient(SUPABASE_URL, Deno.env.get('SUPABASE_ANON_KEY')!, {
      global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } },
    })
    const { data: isAdmin } = await userClient.rpc('mkt_is_admin')
    if (isAdmin !== true) return json({ error: 'Not authorised' }, 403)

    const { client_id, platform, pillar } = await req.json()
    if (!client_id || !platform || !pillar) return json({ error: 'client_id, platform and pillar are required' }, 400)

    const admin = createClient(SUPABASE_URL, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
    const { data: client, error: cErr } = await admin.from('mkt_clients').select('*').eq('id', client_id).single()
    if (cErr || !client) return json({ error: 'Client not found' }, 404)

    const userMessage =
      `Write a ${platform} post for ${client.name}.\n` +
      `Business: ${client.name}\n` +
      `What they do: ${client.key_services ?? ''}\n` +
      `Tone of voice: ${client.tone_of_voice ?? ''}\n` +
      `Target customer: ${client.target_customer ?? ''}\n` +
      `Content pillar for this post: ${pillar}\n` +
      `Write one post. Under 150 words.`

    const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': Deno.env.get('ANTHROPIC_API_KEY')!,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 500,
        system: MASTER_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userMessage }],
      }),
    })
    const ai = await aiRes.json()
    const body = ai?.content?.[0]?.text?.trim()
    if (!body) return json({ error: 'No copy came back — try again.', detail: ai?.error?.message }, 502)

    const { data: item, error: iErr } = await admin.from('mkt_content_queue').insert({
      client_id, platform, content_type: 'post', pillar, body,
      status: 'pending', generated_by: 'ai',
    }).select('*, client:mkt_clients(short_name,name)').single()
    if (iErr) return json({ error: iErr.message }, 500)

    return json({ item })
  } catch (e) {
    return json({ error: String((e as Error)?.message ?? e) }, 500)
  }
})
