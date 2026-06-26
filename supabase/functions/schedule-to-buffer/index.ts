// Supabase Edge Function: schedule-to-buffer  (Deno)
// Fired when a post is approved. Schedules it to Buffer at the client's next slot.
// Invoke: supabase.functions.invoke('schedule-to-buffer', { body: { content_queue_id } })
//
// Deploy:  supabase functions deploy schedule-to-buffer
// Secrets (Supabase vault): BUFFER_ACCESS_TOKEN
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
const DOW = { Sunday: 0, Monday: 1, Tuesday: 2, Wednesday: 3, Thursday: 4, Friday: 5, Saturday: 6 }

// Next datetime matching one of post_days at post_time, after now.
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
    // v3: Buffer profile IDs live in Supabase secrets, keyed by client slug
    // (BUFFER_YCA_PROFILE_ID, BUFFER_PS_PROFILE_ID, BUFFER_OUAY_PROFILE_ID,
    // BUFFER_HORMONELY_PROFILE_ID). Fall back to the per-client jsonb map.
    const slug = String(client?.slug || '').toUpperCase()
    const envProfile = slug ? Deno.env.get(`BUFFER_${slug}_PROFILE_ID`) : null
    const profileId = envProfile || (client?.buffer_profile_ids || {})[item.platform]
    if (!profileId) return json({ error: `No Buffer profile set for ${item.platform} on this client (no BUFFER_${slug}_PROFILE_ID secret and no jsonb entry).` }, 422)

    // Prefer an explicit time chosen at approval (body, then the row), else
    // fall back to the client's next scheduled slot.
    const chosen = scheduled_for || item.scheduled_for
    const chosenDate = chosen ? new Date(chosen) : null
    const slot = (chosenDate && !isNaN(chosenDate.getTime()) && chosenDate > new Date())
      ? chosenDate
      : nextSlot(client.post_days, client.post_time)

    const token = Deno.env.get('BUFFER_ACCESS_TOKEN')
    if (!token) return json({ error: 'BUFFER_ACCESS_TOKEN not configured' }, 500)

    const params = new URLSearchParams()
    params.append('text', item.body)
    params.append('profile_ids[]', profileId)
    params.append('scheduled_at', slot.toISOString())
    params.append('access_token', token)

    const bufRes = await fetch('https://api.bufferapp.com/1/updates/create.json', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: params,
    })
    const buf = await bufRes.json()
    const bufferUpdateId = buf?.updates?.[0]?.id ?? buf?.buffer_update_id ?? null
    if (!bufRes.ok || !buf?.success) {
      return json({ error: 'Buffer rejected the post.', detail: buf?.message ?? buf }, 502)
    }

    await admin.from('mkt_content_queue')
      .update({ status: 'scheduled', scheduled_for: slot.toISOString(), buffer_update_id: bufferUpdateId })
      .eq('id', item.id)

    await admin.from('mkt_scheduled_posts').insert({
      client_id: item.client_id, content_queue_id: item.id, platform: item.platform,
      body: item.body, scheduled_for: slot.toISOString(), buffer_update_id: bufferUpdateId, status: 'scheduled',
    })

    return json({ scheduled_for: slot.toISOString(), buffer_update_id: bufferUpdateId })
  } catch (e) {
    return json({ error: String((e as Error)?.message ?? e) }, 500)
  }
})
