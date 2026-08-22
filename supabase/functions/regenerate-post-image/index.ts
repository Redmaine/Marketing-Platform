// Supabase Edge Function: regenerate-post-image  (Deno)
// Runs the real image-generation pipeline (_shared/image.ts's
// generatePostImage — same Stability/Flux call, same visual-style
// compliance review loop, same 3-attempt cap, same image_review_events
// logging) for one existing mkt_content_queue row. Not a shortcut: this
// calls the exact same function every other generation path calls.
//
// Added 22 Aug 2026 to backfill images for posts whose alternation decision
// was wrong under the pre-fix batching bug (see commit 4a501e4) and have
// since been confirmed, by hand, as posts that SHOULD have gotten one.
// forceWantsImage lets the caller supply that already-made decision instead
// of re-deriving it from Quill's alternating-stream logic (which doesn't
// apply here — these are one-off corrections, not part of a fresh 50/50
// sequence) — everything downstream of that one bypassed check (the actual
// generation attempt, the review gate, the attempt cap) is untouched.
//
// Refuses to run if the row already has an image, so this can never
// silently clobber a real one.
//
// Invoke: supabase.functions.invoke('regenerate-post-image',
//   { body: { content_queue_id, force_wants_image: true } })
//
// Deploy: supabase functions deploy regenerate-post-image
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { checkCronAuth } from '../_shared/cronAuth.ts'
import { generatePostImage } from '../_shared/image.ts'

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

serve(async (req) => {
  const json = (b: unknown, s = 200) =>
    new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } })
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })

  const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
  const admin = createClient(SUPABASE_URL, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)

  // Admin-gate on the caller's JWT (mkt_is_admin), same as delete-post.ts,
  // falling back to cron/service-role auth for internal invocation.
  const userClient = createClient(SUPABASE_URL, Deno.env.get('SUPABASE_ANON_KEY')!, {
    global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } },
  })
  const { data: isAdmin } = await userClient.rpc('mkt_is_admin')
  if (isAdmin !== true) {
    const cronAuth = await checkCronAuth(req, 'regenerate-post-image')
    if (!cronAuth.authorised) return json({ error: 'Not authorised' }, 403)
  }

  const body = await req.json().catch(() => ({}))
  const contentQueueId = body.content_queue_id
  if (!contentQueueId) return json({ error: 'content_queue_id required' }, 400)
  const forceWantsImage = body.force_wants_image !== false // default true — this endpoint exists to force an image attempt

  const { data: item, error: fetchErr } = await admin
    .from('mkt_content_queue')
    .select('*, client:mkt_clients(*)')
    .eq('id', contentQueueId)
    .maybeSingle()
  if (fetchErr) return json({ error: fetchErr.message }, 500)
  if (!item) return json({ error: 'content_queue_id not found' }, 404)
  if (item.image_url) return json({ error: 'row already has an image_url — refusing to overwrite', image_url: item.image_url }, 409)
  if (!item.body) return json({ error: 'row has no post body — nothing to generate an image for' }, 422)

  await generatePostImage(admin, item.client, item.id, item.body, item.platform, undefined, forceWantsImage)

  const { data: after, error: afterErr } = await admin
    .from('mkt_content_queue')
    .select('id, image_url, review_reason')
    .eq('id', contentQueueId)
    .maybeSingle()
  if (afterErr) return json({ error: afterErr.message }, 500)

  const { data: reviewEvents } = await admin
    .from('image_review_events')
    .select('attempt, verdict, reasons, created_at')
    .eq('content_queue_id', contentQueueId)
    .order('attempt', { ascending: true })

  return json({
    contentQueueId,
    imageAttached: !!after?.image_url,
    image_url: after?.image_url ?? null,
    review_reason: after?.review_reason ?? null,
    reviewEvents: reviewEvents ?? [],
  })
})
