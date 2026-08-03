// Supabase Edge Function: create-manual-post  (Deno)
// Content cadence control — the "Write a post" form on the ops platform's
// content queue screen calls this to insert a manually-written post.
//
// Two modes, driven by `is_reactive`:
//   - off:  the post is simply queued into the brand's next empty posting
//           slot (per that platform's mkt_content_schedule) — nothing else
//           is touched.
//   - on:   the earliest not-yet-approved post for this brand+platform is
//           found and rescheduled to the brand's next empty slot; the new
//           manual post takes over the ORIGINAL slot that post vacated.
//           "Not yet approved or sent" = status in ('draft', 'pending') —
//           this schema's two awaiting-approval states (see migration 12's
//           own comment on the status CHECK constraint).
//
// Every inserted row gets is_manual = true (migration 77) and
// generated_by = 'human' (already a valid value in the original schema's
// generated_by CHECK, migration 03 — this is simply the first place that
// ever writes it). is_manual is what midnight-cron's hasAutoPostOnDate now
// respects (see _shared/fill.ts) and what send-digest labels "manual".
//
// Invoke (agency, authenticated): supabase.functions.invoke('create-manual-post',
//   { body: { client_id, platform, body, image_base64?, image_content_type?, is_reactive } })
//
// Deploy:  supabase functions deploy create-manual-post
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { cors, json } from '../_shared/cors.ts'
import { stripMarkdown } from '../_shared/generate.ts'
import { nextEmptySlot } from '../_shared/fill.ts'

const VALID_PLATFORMS = ['facebook', 'instagram', 'linkedin', 'google_business', 'blog']
const AWAITING_APPROVAL_STATUSES = ['draft', 'pending']

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })

  try {
    const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
    const userClient = createClient(SUPABASE_URL, Deno.env.get('SUPABASE_ANON_KEY')!, {
      global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } },
    })
    const { data: isAdmin } = await userClient.rpc('mkt_is_admin')
    if (isAdmin !== true) return json({ error: 'Not authorised' }, 403)

    const { client_id, platform, body, image_base64, image_content_type, is_reactive } = await req.json()
    if (!client_id || !platform || !body) return json({ error: 'client_id, platform and body are required' }, 400)
    if (!VALID_PLATFORMS.includes(platform)) return json({ error: `Unknown platform "${platform}"` }, 400)

    const admin = createClient(SUPABASE_URL, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
    const { data: client, error: cErr } = await admin.from('mkt_clients').select('*').eq('id', client_id).single()
    if (cErr || !client) return json({ error: 'Client not found' }, 404)

    const cleanBody = stripMarkdown(String(body))

    let scheduledFor: Date | null = null
    let displacedId: string | null = null
    let displacedNewSlot: string | null = null

    if (is_reactive) {
      // Earliest not-yet-approved post for this brand+platform — the one
      // this manual post is reacting to and taking the slot of.
      const { data: displaced, error: dErr } = await admin
        .from('mkt_content_queue')
        .select('id, scheduled_for')
        .eq('client_id', client_id).eq('platform', platform).eq('content_type', 'post')
        .in('status', AWAITING_APPROVAL_STATUSES)
        .order('scheduled_for', { ascending: true, nullsFirst: false })
        .limit(1)
        .maybeSingle()
      if (dErr) return json({ error: `Looking up the post to displace failed: ${dErr.message}` }, 500)

      if (displaced) {
        // Reschedule it to the brand's next empty slot, walking forward from
        // its OWN current slot (not "now") so it never lands back where it
        // started and always moves strictly forward in the schedule.
        const afterDate = displaced.scheduled_for ? new Date(displaced.scheduled_for) : new Date()
        const newSlot = await nextEmptySlot(admin, client, platform, afterDate)
        if (!newSlot) {
          return json({ error: `Could not find an empty slot to move the displaced post to for ${client.name}/${platform} — schedule may be misconfigured.` }, 500)
        }
        const { error: moveErr } = await admin.from('mkt_content_queue').update({ scheduled_for: newSlot.toISOString() }).eq('id', displaced.id)
        if (moveErr) return json({ error: `Rescheduling the displaced post failed: ${moveErr.message}` }, 500)

        // The manual post takes over the slot the displaced post vacated.
        scheduledFor = displaced.scheduled_for ? new Date(displaced.scheduled_for) : newSlot
        displacedId = displaced.id
        displacedNewSlot = newSlot.toISOString()
      }
      // No post currently awaiting approval for this brand+platform — falls
      // through to the "no displacement" path below, same as the toggle
      // being off, since there is nothing to react to.
    }

    if (!scheduledFor) {
      scheduledFor = await nextEmptySlot(admin, client, platform)
      if (!scheduledFor) {
        return json({ error: `Could not find an empty posting slot for ${client.name}/${platform} — check mkt_content_schedule.` }, 500)
      }
    }

    let imageUrl: string | null = null
    if (image_base64) {
      try {
        const bytes = Uint8Array.from(atob(image_base64), (c) => c.charCodeAt(0))
        const ext = String(image_content_type || 'image/png').split('/')[1] || 'png'
        const path = `${client.slug || 'unknown-brand'}/manual-${crypto.randomUUID()}.${ext}`
        const { error: upErr } = await admin.storage.from('mkt-assets').upload(path, bytes, {
          contentType: image_content_type || 'image/png',
          upsert: true,
        })
        if (upErr) throw new Error(upErr.message)
        const { data: pub } = admin.storage.from('mkt-assets').getPublicUrl(path)
        imageUrl = pub?.publicUrl ?? null
      } catch (e) {
        // Best-effort, same policy as the auto-generated image path
        // (_shared/image.ts) — a bad upload must never block the post itself.
        console.error(`[create-manual-post] image upload failed for ${client.name}: ${String((e as Error)?.message ?? e)}`)
      }
    }

    // review_status/reviewed_at are left null — a manually-written post never
    // goes through generateReviewedPost, so marking it "passed" would claim a
    // review that never happened. Left null, the queue UI shows the same
    // "read it carefully before approving" flag it already shows for any
    // unreviewed post — the honest state here.
    const { data: inserted, error: iErr } = await admin.from('mkt_content_queue').insert({
      client_id, platform, content_type: 'post', body: cleanBody,
      status: 'draft', generated_by: 'human', is_manual: true,
      scheduled_for: scheduledFor.toISOString(), image_url: imageUrl,
    }).select('*, client:mkt_clients(short_name,name)').single()
    if (iErr) return json({ error: iErr.message }, 500)

    return json({ item: inserted, displaced: displacedId ? { id: displacedId, new_scheduled_for: displacedNewSlot } : null })
  } catch (e) {
    return json({ error: String((e as Error)?.message ?? e) }, 500)
  }
})
