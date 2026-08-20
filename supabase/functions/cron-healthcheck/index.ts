// Supabase Edge Function: cron-healthcheck  (Deno) — runs daily via pg_cron
//
// Built 13 Aug 2026, same incident as the crhq-nightly-content imagescript
// fix (see _shared/vendor/imagescript/README.md) — that crash happened
// before the function's own code (including its own mkt_cron_log write)
// ever ran, so the missed 12 Aug 22:00 run left zero trace anywhere until a
// human noticed missing content days later. This function is that missing
// trace: for every job below, it checks whether mkt_cron_log has a recent
// enough row, and writes a clear, durable alert to edge_function_errors if
// not — the one channel every function here already treats as "durable
// enough to survive a crash," see e.g. image.ts's disableImageGenForPlatform.
//
// Deliberately checks table freshness, not the cron.job schedule itself —
// this can't (and shouldn't try to) tell the difference between "the cron
// trigger never fired" and "it fired but the function crashed before
// logging" (exactly what happened on 12 Aug). Either way, the actual
// business signal — did this job's real work get logged — is what matters,
// and it's the same check either way.
//
// EXPECTED_JOBS' hourUtc/dayOfWeek/dayOfMonth values are for humans reading
// this file, not used in the staleness math (which just checks "how long
// since the last row" against a per-cadence threshold) — deliberately
// simple rather than a full cron-occurrence calculator, since every real
// job here runs on a fixed daily/weekly/monthly cadence with no exotic
// scheduling. Update the threshold, not the schedule fields, if a job's
// actual cron.job entry changes cadence.
//
// Deploy:  supabase functions deploy cron-healthcheck
// Schedule: daily, well clear of every monitored job's own grace window —
//   see the migration that schedules this (cron.schedule call, run once).
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { checkCronAuth } from '../_shared/cronAuth.ts'

// deno-lint-ignore no-explicit-any
type Admin = any

interface ExpectedJob {
  jobName: string
  cadence: 'daily' | 'weekly' | 'monthly'
  // For humans only — see file header.
  hourUtc: number
  dayOfWeek?: number // 0=Sun..6=Sat
  dayOfMonth?: number
  // How stale mkt_cron_log's most recent row for this job is allowed to get
  // before this counts as missing. Daily jobs get ~2 extra hours of grace
  // past their next expected run (catches "missed last night" without
  // false-alarming on ordinary schedule jitter); weekly/monthly get a
  // proportionally similar cushion.
  staleAfterHours: number
}

// Only jobs that are (a) genuinely independent cron.job entries and (b) log
// to mkt_cron_log under their own name. Deliberately excludes:
//   - backfill-content: not scheduled at all (manually triggered, one
//     historical row total) — nothing to check freshness against.
//   - crhq-content-scrape, midnight-cron-dispatch: sub-steps logged by
//     crhq-nightly-content's and midnight-content-generation's own cron
//     jobs respectively, not independent schedules — covered by those.
const EXPECTED_JOBS: ExpectedJob[] = [
  { jobName: 'crhq-nightly-content', cadence: 'daily', hourUtc: 22, staleAfterHours: 26 },
  { jobName: 'midnight-content-generation', cadence: 'daily', hourUtc: 0, staleAfterHours: 26 },
  { jobName: 'check-client-news', cadence: 'daily', hourUtc: 9, staleAfterHours: 26 },
  { jobName: 'metricool-weekly-pull', cadence: 'weekly', hourUtc: 6, dayOfWeek: 1, staleAfterHours: 8 * 24 },
  { jobName: 'weekly-competitor-search', cadence: 'weekly', hourUtc: 6, dayOfWeek: 1, staleAfterHours: 8 * 24 },
  { jobName: 'weekly-content-prompt', cadence: 'weekly', hourUtc: 8, dayOfWeek: 1, staleAfterHours: 8 * 24 },
  { jobName: 'monthly-performance-pull', cadence: 'monthly', hourUtc: 6, dayOfMonth: 1, staleAfterHours: 33 * 24 },
]

interface JobStatus {
  jobName: string
  cadence: string
  mostRecent: string | null
  hoursSinceLastRun: number | null
  staleAfterHours: number
  stale: boolean
}

serve(async (req) => {
  const auth = await checkCronAuth(req, 'cron-healthcheck')
  if (!auth.authorised) return auth.response!

  const admin: Admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
  const now = Date.now()

  const results: JobStatus[] = []
  for (const job of EXPECTED_JOBS) {
    const { data, error } = await admin
      .from('mkt_cron_log')
      .select('created_at')
      .eq('job_name', job.jobName)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (error) {
      // A lookup failure isn't the same as a missing run — don't claim a
      // job is stale when the real problem is this query itself. Logged,
      // not alerted as a missing-job incident.
      console.error(`[cron-healthcheck] lookup failed for ${job.jobName}: ${error.message}`)
      results.push({ jobName: job.jobName, cadence: job.cadence, mostRecent: null, hoursSinceLastRun: null, staleAfterHours: job.staleAfterHours, stale: false })
      continue
    }

    const mostRecent = data?.created_at ?? null
    const hoursSince = mostRecent ? (now - new Date(mostRecent).getTime()) / 3600000 : null
    // No row at all, ever, counts as stale (a job that's never once logged
    // is exactly as invisible as one that silently stopped).
    const stale = hoursSince === null || hoursSince > job.staleAfterHours
    results.push({ jobName: job.jobName, cadence: job.cadence, mostRecent, hoursSinceLastRun: hoursSince === null ? null : Math.round(hoursSince * 10) / 10, staleAfterHours: job.staleAfterHours, stale })
  }

  const staleJobs = results.filter((r) => r.stale)

  for (const job of staleJobs) {
    const message = job.mostRecent
      ? `[cron-healthcheck] "${job.jobName}" (expected ${job.cadence}) has no mkt_cron_log entry in ${job.hoursSinceLastRun}h — last seen ${job.mostRecent}. Its cron.job may have stopped firing, or the function is crashing before it can log (the exact failure mode that hid the 12 Aug crhq-nightly-content outage).`
      : `[cron-healthcheck] "${job.jobName}" (expected ${job.cadence}) has NEVER logged a single mkt_cron_log row. Check whether its cron.job is scheduled and active at all.`
    console.error(message)
    try {
      await admin.from('edge_function_errors').insert({ function_name: 'cron-healthcheck', error_message: message })
    } catch (e) {
      console.error(`[cron-healthcheck] failed to write edge_function_errors for ${job.jobName}: ${(e as Error)?.message ?? e}`)
    }
  }

  // Logs its own run the same way every other cron job here does — so this
  // healthcheck's own liveness is visible in the same table admins already
  // look at, not a special case. posts_generated has no real meaning here;
  // 0 always, kept only because the column is NOT NULL elsewhere in this
  // table's usage.
  try {
    await admin.from('mkt_cron_log').insert({
      job_name: 'cron-healthcheck',
      clients_processed: EXPECTED_JOBS.length,
      posts_generated: 0,
      errors: staleJobs.length ? staleJobs.map((j) => j.jobName) : null,
      notes: [`checked ${EXPECTED_JOBS.length} jobs, ${staleJobs.length} stale`],
    })
  } catch (e) {
    console.error(`[cron-healthcheck] failed to write its own mkt_cron_log row: ${(e as Error)?.message ?? e}`)
  }

  return new Response(JSON.stringify({ ok: true, checked: results.length, stale: staleJobs.length, results }), {
    headers: { 'Content-Type': 'application/json' },
  })
})
