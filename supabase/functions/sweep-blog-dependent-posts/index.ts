// Supabase Edge Function: sweep-blog-dependent-posts  (Deno) — runs every
// 30 minutes via pg_cron.
//
// Backstop for the real-time release that now happens inside
// publish-approved-blog (see _shared/blogDependentRelease.ts). Catches a
// blog published through any path that doesn't go through that function —
// or anything the real-time hook missed for any other reason — the same
// role sweep-stuck-metricool-posts plays for Metricool scheduling failures.
//
// Confirmed real incident (21 Aug 2026): approve-blog stamps a blog's 3
// AI-repurposed social posts review_status='blog_dependent' at creation
// time. The only release path used to be entirely client-side, inside
// ContentQueue.jsx's load() — it only ran if a human happened to have that
// admin page open. 4 real posts (Hormonely, Once Upon A You) sat blocked for
// weeks pointing at blogs that had already published, with nothing anywhere
// surfacing that the wait condition was already met. Manually rejected as a
// one-off cleanup before this fix landed.
//
// Deliberately does NOT duplicate the release condition — imports the same
// releaseAll() the real-time hook's releaseForClient() shares a helper with,
// so there is exactly one place that logic lives and the two callers can't
// drift apart.
//
// Auth: cronAuth-gated, same pattern as every other scheduled function here
// (cron-healthcheck, sweep-stuck-metricool-posts, daily-ops-check).
//
// Deploy: supabase functions deploy sweep-blog-dependent-posts
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { checkCronAuth } from '../_shared/cronAuth.ts'
import { releaseAll } from '../_shared/blogDependentRelease.ts'

// deno-lint-ignore no-explicit-any
type Admin = any

async function logEdgeError(admin: Admin, message: string) {
  const { error } = await admin.from('edge_function_errors').insert({ function_name: 'sweep-blog-dependent-posts', error_message: message })
  if (error) console.error('[sweep-blog-dependent-posts] Failed to write edge_function_errors:', error.message)
}

serve(async (req) => {
  const auth = await checkCronAuth(req, 'sweep-blog-dependent-posts')
  if (!auth.authorised) return auth.response!

  const admin: Admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)

  try {
    const { released, byClient } = await releaseAll(admin)
    if (released) {
      console.log(`[sweep-blog-dependent-posts] released ${released} post(s):`, JSON.stringify(byClient))
    } else {
      console.log('[sweep-blog-dependent-posts] nothing to release — clean sweep')
    }
    return new Response(JSON.stringify({ ok: true, released, byClient }), { headers: { 'Content-Type': 'application/json' } })
  } catch (e) {
    const msg = `Sweep failed: ${String((e as Error)?.message ?? e)}`
    console.error(`[sweep-blog-dependent-posts] ${msg}`)
    await logEdgeError(admin, msg)
    return new Response(JSON.stringify({ ok: false, error: msg }), { status: 500, headers: { 'Content-Type': 'application/json' } })
  }
})
