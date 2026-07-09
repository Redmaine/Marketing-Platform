// Supabase Edge Function: delete-post  (Deno)
// Fix 3 — deletes a post from the queue and cancels it in Metricool if it has
// already been scheduled there. Invoked from the calendar (and usable from the
// content queue) on any device, including iPhone.
//
// Invoke: supabase.functions.invoke('delete-post', { body: { content_queue_id } })
//
// Deploy:  supabase functions deploy delete-post
// Secrets (Supabase vault): METRICOOL_API_KEY
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const METRICOOL_USER_ID = '4984082'

serve(async (req) => {
  const json = (b: unknown, s = 200) =>
    new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } })
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })

  try {
    const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
    // Admin-gate on the caller's JWT, exactly like schedule-to-metricool.
    const userClient = createClient(SUPABASE_URL, Deno.env.get('SUPABASE_ANON_KEY')!, {
      global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } },
    })
    const { data: isAdmin } = await userClient.rpc('mkt_is_admin')
    if (isAdmin !== true) return json({ error: 'Not authorised' }, 403)

    const { content_queue_id } = await req.json()
    if (!content_queue_id) return json({ error: 'content_queue_id required' }, 400)

    const admin = createClient(SUPABASE_URL, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
    const { data: item } = await admin
      .from('mkt_content_queue')
      .select('*, client:mkt_clients(metricool_brand_id, name)')
      .eq('id', content_queue_id)
      .maybeSingle()

    if (!item) {
      // Already gone. Treat as success so the UI can move on cleanly.
      return json({ ok: true, alreadyDeleted: true })
    }

    // Cancel in Metricool first, if it was scheduled there. If the cancel call
    // genuinely fails (not a 404 "already gone"), stop and report, leaving the
    // DB row intact so the two stay consistent and the user can retry.
    let metricoolCancelled = false
    const metricoolPostId = item.metricool_post_id
    const brandId = item.client?.metricool_brand_id
    if (metricoolPostId && brandId) {
      const apiKey = Deno.env.get('METRICOOL_API_KEY')
      if (!apiKey) return json({ error: 'METRICOOL_API_KEY not configured in Supabase vault' }, 500)
      const url = `https://app.metricool.com/api/v2/scheduler/posts/${metricoolPostId}?userId=${METRICOOL_USER_ID}&blogId=${brandId}`
      try {
        const mRes = await fetch(url, { method: 'DELETE', headers: { 'X-Mc-Auth': apiKey, 'Content-Type': 'application/json' } })
        const mRaw = await mRes.text()
        if (mRes.ok || mRes.status === 404) {
          metricoolCancelled = true
          console.log(`[delete-post] Metricool cancel ${mRes.status} for post ${metricoolPostId}`)
        } else {
          console.error(`[delete-post] Metricool cancel failed ${mRes.status}: ${mRaw.slice(0, 300)}`)
          return json({ error: `Could not cancel the post in Metricool (${mRes.status}). Nothing was deleted — please try again.`, status: mRes.status }, 502)
        }
      } catch (fetchErr) {
        const msg = String((fetchErr as Error)?.message ?? fetchErr)
        console.error('[delete-post] Network error cancelling in Metricool:', msg)
        return json({ error: 'Network error cancelling in Metricool. Nothing was deleted — please try again.' }, 502)
      }
    }

    // Remove the published-log mirror (if any), then the queue row. Deleting
    // the queue row cascades to mkt_scheduled_posts (ON DELETE CASCADE).
    await admin.from('published_posts').delete().eq('content_queue_id', content_queue_id)
    const { error: delErr } = await admin.from('mkt_content_queue').delete().eq('id', content_queue_id)
    if (delErr) return json({ error: `Could not delete the post: ${delErr.message}` }, 500)

    return json({ ok: true, metricoolCancelled })
  } catch (e) {
    console.error('[delete-post] Unhandled error:', String((e as Error)?.message ?? e))
    return json({ error: String((e as Error)?.message ?? e) }, 500)
  }
})
