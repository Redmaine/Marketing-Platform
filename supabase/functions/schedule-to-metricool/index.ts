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

// Maps our internal platform slugs to Metricool's network keys.
const PLATFORM_MAP: Record<string, string> = {
  facebook:  'facebook',
  instagram: 'instagram',
  linkedin:  'linkedin',
  twitter:   'twitter',
}

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

    // Metricool brand ID — stored on the client row.
    const brandId = client?.metricool_brand_id
    if (!brandId) {
      return json({ error: `No Metricool brand ID set for client "${client?.name}". Run 16_metricool_schema.sql to populate metricool_brand_id.` }, 422)
    }

    // Metricool network key for this platform.
    const networkKey = PLATFORM_MAP[item.platform]
    if (!networkKey) {
      return json({ error: `Unsupported platform "${item.platform}" — expected one of: ${Object.keys(PLATFORM_MAP).join(', ')}` }, 422)
    }

    // Prefer an explicit time chosen at approval (body, then the row), else
    // fall back to the client's next scheduled slot.
    const chosen = scheduled_for || item.scheduled_for
    const chosenDate = chosen ? new Date(chosen) : null
    const slot = (chosenDate && !isNaN(chosenDate.getTime()) && chosenDate > new Date())
      ? chosenDate
      : nextSlot(client.post_days, client.post_time)

    const apiKey = Deno.env.get('METRICOOL_API_KEY')
    if (!apiKey) return json({ error: 'METRICOOL_API_KEY not configured in Supabase vault' }, 500)

    // Metricool expects the date as a local-time string (no Z suffix) — strip the Z.
    // We store/schedule in UTC; Metricool interprets it as UTC when no TZ is given.
    const dateStr = slot.toISOString().replace('Z', '')

    const body = {
      blogId: brandId,
      draft: false,
      date: dateStr,
      networks: {
        [networkKey]: {
          active: true,
          text: item.body,
        },
      },
    }

    const mRes = await fetch(
      `https://app.metricool.com/api/v2/posts?userId=${METRICOOL_USER_ID}`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      }
    )
    const mRaw = await mRes.text()
    let mData: unknown
    try { mData = JSON.parse(mRaw) } catch { mData = mRaw }

    if (!mRes.ok) {
      console.error(
        `[schedule-to-metricool] Metricool ${mRes.status} for client "${client?.name}" (${item.platform}):`,
        JSON.stringify(mData),
        '| request body:', JSON.stringify(body),
      )
      return json({ error: 'Metricool rejected the post.', status: mRes.status, detail: mData }, 502)
    }

    const metricoolPostId = mData?.id ?? mData?.postId ?? null

    await admin.from('mkt_content_queue')
      .update({ status: 'scheduled', scheduled_for: slot.toISOString(), metricool_post_id: metricoolPostId })
      .eq('id', item.id)

    await admin.from('mkt_scheduled_posts').insert({
      client_id: item.client_id, content_queue_id: item.id, platform: item.platform,
      body: item.body, scheduled_for: slot.toISOString(), metricool_post_id: metricoolPostId, status: 'scheduled',
    })

    return json({ scheduled_for: slot.toISOString(), metricool_post_id: metricoolPostId })
  } catch (e) {
    return json({ error: String((e as Error)?.message ?? e) }, 500)
  }
})
