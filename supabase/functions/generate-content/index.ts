// Supabase Edge Function: generate-content  (Deno)
// Generates one social post for a client via Anthropic and queues it.
// Invoke (agency, authenticated): supabase.functions.invoke('generate-content',
//   { body: { client_id, platform, pillar } })
//
// Deploy:  supabase functions deploy generate-content
// Secrets (Supabase vault): ANTHROPIC_API_KEY
//   supabase secrets set ANTHROPIC_API_KEY=sk-ant-...
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { cors, json } from '../_shared/cors.ts'
import { isPlatformConnected, recentPublishedSummaries, stripMarkdown } from '../_shared/generate.ts'
import { generateReviewedPost } from '../_shared/review.ts'

serve(async (req) => {
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

    // Hard block — never generate for a platform the client hasn't connected.
    if (!isPlatformConnected(client, platform)) {
      const connected: string[] = client.connected_platforms || ['facebook']
      return json({
        error: `Platform "${platform}" is not connected for ${client.name}. Connected platforms: ${connected.join(', ')}.`,
      }, 422)
    }

    // Item 3: generate → automated review → (on fail) one regenerate → review.
    // A pass is queued with the "passed" review badge; two failures queue a
    // "needs_attention" draft with the reason, and the modal shows the warning
    // so Adrian knows why (rather than silently queueing a rule-breaking post).
    // Fix 4: show the generator recent topics so it avoids repeats at source.
    const recentTopics = await recentPublishedSummaries(admin, client_id, 6)
    const review = await generateReviewedPost(admin, { ...client, _recent_topics: recentTopics }, platform, pillar)
    if (!review.body) {
      console.error(`[generate-content] No copy produced for "${client.name}": ${review.reason}`)
      return json({ error: review.reason || 'No copy came back — try again.' }, 502)
    }
    // Hard backstop — strip any markdown the model still produced despite
    // FORMAT_RULES and the review step's retry (see stripMarkdown in generate.ts).
    review.body = stripMarkdown(review.body)

    const { data: item, error: iErr } = await admin.from('mkt_content_queue').insert({
      client_id, platform, content_type: 'post', pillar, body: review.body,
      status: 'draft', generated_by: 'ai',
      review_status: review.ok ? 'passed' : 'needs_attention',
      reviewed_at: review.reviewedAt,
      review_reason: review.ok ? null : review.reason,
      generation_attempts: review.attempts,
    }).select('*, client:mkt_clients(short_name,name)').single()
    if (iErr) return json({ error: iErr.message }, 500)

    // Keep the rotation pointer in sync even for manually-picked pillars, so
    // the cron's automatic rotation doesn't immediately repeat this one.
    await admin.from('mkt_clients').update({ last_pillar_used: pillar }).eq('id', client_id)

    return json({ item })
  } catch (e) {
    return json({ error: String((e as Error)?.message ?? e) }, 500)
  }
})
