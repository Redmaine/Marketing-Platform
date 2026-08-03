// Supabase Edge Function: create-manual-post  (Deno)
// The ops platform's "Write a post" form (Content tab) calls this to create a
// manually-written social post for any brand and platform.
//
// The post is inserted already approved (status 'approved', review_status
// 'passed', is_manual true) — a human wrote it, so there is nothing for the
// automated review or the approval queue to add. is_manual is what
// midnight-cron's hasManualPostOnDate respects (see _shared/fill.ts, which
// skips a day owned by a manual post and logs "manual post exists") and what
// send-digest labels "manual".
//
// DISPLACEMENT: if a cron-generated post already occupies that brand/platform
// on the chosen date, it is MOVED, never deleted — rescheduled to the next
// genuinely empty slot in the brand's own posting schedule (a day with no
// live post of any kind, manual or automatic). The manual post then takes the
// date the user chose.
//
// Two modes:
//   { action: 'next_slot', client_id, platform }
//       -> { next_slot: 'YYYY-MM-DD' | null }  — used to pre-populate the
//          form's date picker with the brand's next available slot.
//   { client_id, platform, body, scheduled_date, image_base64?, image_content_type? }
//       -> { item, displaced: { id, new_date } | null, scheduled_date }
//
// NOTE on scheduling to Metricool: nothing in this project sweeps
// status='approved' rows and pushes them to Metricool — schedule-to-metricool
// is only ever invoked by the caller that approved the post (see
// ContentQueue.jsx's approve()). So the frontend invokes it for the returned
// item, and for the displaced post when its own send time has moved. Handled
// there rather than here for the same reason approve() does it there: that is
// the established, proven path in this codebase, and it keeps the authenticated
// user's JWT on the call.
//
// Deploy:  supabase functions deploy create-manual-post
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { cors, json } from '../_shared/cors.ts'
import { stripMarkdown, dateOnly } from '../_shared/generate.ts'
import { nextEmptySlot, cronPostOnDate, slotDateTime } from '../_shared/fill.ts'

// Parses 'YYYY-MM-DD' as a LOCAL date at midnight. `new Date('YYYY-MM-DD')`
// would parse as UTC midnight, which in a negative-offset timezone lands on
// the previous day — the picked date must mean the picked date.
function parseLocalDate(s: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || '').trim())
  if (!m) return null
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  return Number.isNaN(d.getTime()) ? null : d
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })

  try {
    const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
    const userClient = createClient(SUPABASE_URL, Deno.env.get('SUPABASE_ANON_KEY')!, {
      global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } },
    })
    const { data: isAdmin } = await userClient.rpc('mkt_is_admin')
    if (isAdmin !== true) return json({ error: 'Not authorised' }, 403)

    const { action, client_id, platform, body, scheduled_date, image_base64, image_content_type } = await req.json()
    if (!client_id || !platform) return json({ error: 'client_id and platform are required' }, 400)

    const admin = createClient(SUPABASE_URL, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
    const { data: client, error: cErr } = await admin.from('mkt_clients').select('*').eq('id', client_id).single()
    if (cErr || !client) return json({ error: 'Client not found' }, 404)

    // The form filters the platform dropdown to the brand's connected
    // platforms; enforce the same rule here so the API can't be used to queue
    // a post for a platform the brand has never connected.
    const connected: string[] = Array.isArray(client.connected_platforms) ? client.connected_platforms : []
    if (!connected.includes(platform)) {
      return json({ error: `${client.name} has no "${platform}" connection. Connected platforms: ${connected.join(', ') || 'none'}.` }, 422)
    }

    // ── Probe mode: what date should the picker default to? ──────────────────
    if (action === 'next_slot') {
      const slot = await nextEmptySlot(admin, client, platform)
      return json({ next_slot: slot ? dateOnly(slot) : null })
    }

    if (!body || !String(body).trim()) return json({ error: 'body is required' }, 400)
    if (!scheduled_date) return json({ error: 'scheduled_date is required' }, 400)
    const chosenDay = parseLocalDate(scheduled_date)
    if (!chosenDay) return json({ error: 'scheduled_date must be YYYY-MM-DD' }, 400)

    const cleanBody = stripMarkdown(String(body))
    // The brand's own posting time for that weekday — so a manual post lands
    // in the same slot the cron would have used, not an arbitrary midnight.
    const scheduledFor = await slotDateTime(admin, client, platform, chosenDay)

    // ── Displacement ─────────────────────────────────────────────────────────
    // Resolved BEFORE inserting the manual post, so the "next genuinely empty
    // slot" walk (which excludes any day already holding a live post) isn't
    // looking at the row we are about to add. Walking forward from the chosen
    // day, exclusive, guarantees the displaced post moves strictly forward and
    // never lands back on the date it just gave up.
    let displaced: { id: string; new_date: string; had_metricool_post: boolean } | null = null
    const existing = await cronPostOnDate(admin, client_id, platform, chosenDay)
    if (existing) {
      const newSlot = await nextEmptySlot(admin, client, platform, chosenDay)
      if (!newSlot) {
        return json({
          error: `A post already exists for ${client.name}/${platform} on that date, and no empty slot could be found to move it to — check this brand's posting schedule.`,
        }, 409)
      }
      const { error: moveErr } = await admin.from('mkt_content_queue')
        .update({ scheduled_for: newSlot.toISOString() })
        .eq('id', existing.id)
      if (moveErr) return json({ error: `Could not move the existing post: ${moveErr.message}` }, 500)
      displaced = {
        id: existing.id,
        new_date: dateOnly(newSlot),
        // Already live on Metricool — its send time changed, so the caller
        // must re-push it or Metricool would still fire on the old date.
        had_metricool_post: Boolean(existing.metricool_post_id),
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

    const nowIso = new Date().toISOString()
    const { data: inserted, error: iErr } = await admin.from('mkt_content_queue').insert({
      client_id, platform, content_type: 'post', body: cleanBody,
      status: 'approved', review_status: 'passed', reviewed_at: nowIso,
      approved_at: nowIso, generated_by: 'human', is_manual: true,
      scheduled_for: scheduledFor.toISOString(), image_url: imageUrl,
    }).select('*, client:mkt_clients(short_name,name)').single()
    if (iErr) {
      // The manual post failed but a displaced post may already have been
      // moved — say so explicitly rather than leaving a silent inconsistency.
      const suffix = displaced ? ` NOTE: the existing post was already moved to ${displaced.new_date}.` : ''
      return json({ error: `${iErr.message}${suffix}` }, 500)
    }

    console.log(`[create-manual-post] ${client.name}/${platform}: manual post scheduled for ${dateOnly(scheduledFor)}${displaced ? `, displaced ${displaced.id} to ${displaced.new_date}` : ''}`)

    return json({
      item: inserted,
      scheduled_date: dateOnly(scheduledFor),
      displaced,
    })
  } catch (e) {
    return json({ error: String((e as Error)?.message ?? e) }, 500)
  }
})
