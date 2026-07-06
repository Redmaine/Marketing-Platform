// Supabase Edge Function: schedule-to-metricool  (Deno)
// Fired when a post is approved. Schedules it to Metricool at the client's next slot.
// Invoke: supabase.functions.invoke('schedule-to-metricool', { body: { content_queue_id } })
//
// Deploy:  supabase functions deploy schedule-to-metricool
// Secrets (Supabase vault): METRICOOL_API_KEY
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
const DOW = { Sunday: 0, Monday: 1, Tuesday: 2, Wednesday: 3, Thursday: 4, Friday: 5, Saturday: 6 }

const METRICOOL_USER_ID = '4984082'

const PLATFORM_MAP: Record<string, string> = {
  facebook:  'facebook',
  instagram: 'instagram',
  linkedin:  'linkedin',
  twitter:   'twitter',
}

// Best-effort — persists why a post failed so the dashboard's "Failed to
// schedule" view can show a reason. Never throws; a write failure here must
// not mask the original error being returned to the caller.
async function markFailed(admin: ReturnType<typeof createClient>, id: string, message: string) {
  const { error } = await admin.from('mkt_content_queue').update({ error_message: message }).eq('id', id)
  if (error) console.error('[schedule-to-metricool] Failed to persist error_message:', error.message)
}

function nextSlot(postDays: string[], postTime: string | null): Date {
  const now = new Date()
  const [hh, mm] = (postTime || '09:00').split(':').map(Number)
  const targets = (postDays || []).map((d) => DOW[d as keyof typeof DOW]).filter((n) => n != null)
  if (targets.length === 0) {
    const d = new Date(now); d.setDate(d.getDate() + 1); d.setHours(hh, mm || 0, 0, 0); return d
  }
  for (let i = 0; i < 14; i++) {
    const d = new Date(now); d.setDate(now.getDate() + i); d.setHours(hh, mm || 0, 0, 0)
    if (targets.includes(d.getDay()) && d > now) return d
  }
  const d = new Date(now); d.setDate(d.getDate() + 1); d.setHours(hh, mm || 0, 0, 0); return d
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

    const { content_queue_id, scheduled_for } = await req.json()
    if (!content_queue_id) return json({ error: 'content_queue_id required' }, 400)

    const admin = createClient(SUPABASE_URL, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
    const { data: item, error: iErr } = await admin
      .from('mkt_content_queue').select('*, client:mkt_clients(*)').eq('id', content_queue_id).single()
    if (iErr || !item) return json({ error: 'Content item not found' }, 404)

    const client = item.client

    const brandId = client?.metricool_brand_id
    if (!brandId) {
      const msg = `No Metricool brand ID set for client "${client?.name}".`
      await markFailed(admin, item.id, msg)
      return json({ error: msg }, 422)
    }

    const networkKey = PLATFORM_MAP[item.platform]
    if (!networkKey) {
      const msg = `Unsupported platform "${item.platform}" — expected: ${Object.keys(PLATFORM_MAP).join(', ')}`
      await markFailed(admin, item.id, msg)
      return json({ error: msg }, 422)
    }

    const chosen = scheduled_for || item.scheduled_for
    const chosenDate = chosen ? new Date(chosen) : null
    const slot = (chosenDate && !isNaN(chosenDate.getTime()) && chosenDate > new Date())
      ? chosenDate
      : nextSlot(client.post_days, client.post_time)

    // Issue 6: reject if the resolved slot is in the past.
    if (slot <= new Date()) {
      const msg = 'Scheduled time has passed — please reschedule before retrying.'
      await markFailed(admin, item.id, msg)
      return json({ error: msg }, 422)
    }

    const apiKey = Deno.env.get('METRICOOL_API_KEY')
    if (!apiKey) {
      const msg = 'METRICOOL_API_KEY not configured in Supabase vault'
      await markFailed(admin, item.id, msg)
      return json({ error: msg }, 500)
    }

    const dateTimeStr = slot.toISOString().slice(0, 19)

    const requestBody = {
      text: item.body,
      publicationDate: { dateTime: dateTimeStr, timezone: 'Europe/London' },
      providers: [{ network: networkKey }],
      autoPublish: true,
    }

    // Issue 8: if metricool_post_id already exists, PATCH the existing post
    // rather than creating a duplicate.
    const existingPostId = item.metricool_post_id
    const method = existingPostId ? 'PATCH' : 'POST'
    const url = existingPostId
      ? `https://app.metricool.com/api/v2/scheduler/posts/${existingPostId}?userId=${METRICOOL_USER_ID}&blogId=${brandId}`
      : `https://app.metricool.com/api/v2/scheduler/posts?userId=${METRICOOL_USER_ID}&blogId=${brandId}`

    console.log('[schedule-to-metricool] PRE-REQUEST DIAGNOSTIC:')
    console.log('  method:', method, existingPostId ? `(updating post ${existingPostId})` : '(creating new)')
    console.log('  API key prefix (first 8 chars):', apiKey.slice(0, 8))
    console.log('  URL:', url)
    console.log('  Headers: { X-Mc-Auth: <masked>, Content-Type: application/json }')
    console.log('  Body:', JSON.stringify(requestBody))

    // Issue 2: wrap the fetch in its own try/catch so the response is always
    // logged before the function exits, even on network-level failures.
    let mRes: Response
    let mRaw: string
    let mData: unknown
    try {
      mRes = await fetch(url, {
        method,
        headers: { 'X-Mc-Auth': apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
      })
      mRaw = await mRes.text()
      try { mData = JSON.parse(mRaw) } catch { mData = mRaw }
      console.log(`[schedule-to-metricool] Metricool response ${mRes.status}:`, JSON.stringify(mData))
    } catch (fetchErr) {
      const msg = String((fetchErr as Error)?.message ?? fetchErr)
      console.error('[schedule-to-metricool] Network error calling Metricool:', msg)
      await markFailed(admin, item.id, 'Network error calling Metricool: ' + msg)
      return json({ error: 'Network error calling Metricool: ' + msg }, 502)
    }

    if (!mRes.ok) {
      console.error(`[schedule-to-metricool] Metricool ${mRes.status} rejected post for "${client?.name}" (${item.platform})`)
      const detailStr = typeof mData === 'string' ? mData : JSON.stringify(mData)
      const msg = `Metricool rejected the post (${mRes.status}): ${detailStr}`.slice(0, 500)
      await markFailed(admin, item.id, msg)
      return json({ error: 'Metricool rejected the post.', status: mRes.status, detail: mData }, 502)
    }

    const metricoolPostId = (mData as Record<string, unknown>)?.id
      ?? (mData as Record<string, unknown>)?.postId
      ?? existingPostId
      ?? null

    // Issue 1: log any DB update failures rather than silently ignoring them.
    const { error: updateErr } = await admin.from('mkt_content_queue')
      .update({ status: 'scheduled', scheduled_for: slot.toISOString(), metricool_post_id: metricoolPostId, error_message: null })
      .eq('id', item.id)
    if (updateErr) console.error('[schedule-to-metricool] Failed to update mkt_content_queue:', updateErr.message)

    // Upsert to mkt_scheduled_posts to avoid duplicate-key errors on retry.
    const { error: upsertErr } = await admin.from('mkt_scheduled_posts').upsert({
      client_id: item.client_id, content_queue_id: item.id, platform: item.platform,
      body: item.body, scheduled_for: slot.toISOString(), metricool_post_id: metricoolPostId, status: 'scheduled',
    }, { onConflict: 'content_queue_id' })
    if (upsertErr) console.error('[schedule-to-metricool] Failed to upsert mkt_scheduled_posts:', upsertErr.message)

    return json({ scheduled_for: slot.toISOString(), metricool_post_id: metricoolPostId })
  } catch (e) {
    console.error('[schedule-to-metricool] Unhandled error:', String((e as Error)?.message ?? e))
    return json({ error: String((e as Error)?.message ?? e) }, 500)
  }
})
