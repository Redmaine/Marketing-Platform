// Supabase Edge Function: send-digest  (Deno) — RETIRED 19 Sep 2026.
//
// Used to email Adrian the day's tasks, overdue items, and every post
// awaiting approval, at 07:30 UTC daily (cron job 'morning-digest').
//
// Merged into notify-daily-ops so Adrian gets ONE morning email instead of
// two — see that function's own header for the full writeup (why 10:35 UTC
// and not this function's old 07:30, what moved over, what didn't, the
// simplified "X posts, Y blogs awaiting approval" replacing the old
// per-post preview-and-Review-button list).
//
// The 'morning-digest' cron trigger is unscheduled (see migration
// 20260919_retire_morning_digest_cron.sql) — this file is left deployed
// as a harmless no-op, rather than deleted, purely as a second line of
// defence: if that unschedule somehow didn't apply, or something else
// still calls this URL directly, it returns 200 and sends nothing, instead
// of a real cron job silently reappearing and putting the second email
// back. Confirmed before retiring: nothing in this codebase calls this
// function directly (its only trigger was ever its own pg_cron schedule).
//
// The real implementation (posts/tasks/overdue/competitor-intelligence
// queries, the direct-Postgres PGRST303 fallback, the fail-loudly-never-
// fabricate-a-zero guard) is preserved in git history on this file, in case
// any of that reasoning is ever needed again.
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { checkCronAuth } from '../_shared/cronAuth.ts'

serve(async (req) => {
  const auth = await checkCronAuth(req, 'send-digest')
  if (!auth.authorised) return auth.response!

  console.log('[send-digest] retired 19 Sep 2026 — merged into notify-daily-ops. Sending nothing.')
  return new Response(JSON.stringify({
    ok: true,
    retired: true,
    note: 'send-digest is retired — merged into notify-daily-ops (10:35 UTC). No email sent from here.',
  }), { headers: { 'Content-Type': 'application/json' } })
})
