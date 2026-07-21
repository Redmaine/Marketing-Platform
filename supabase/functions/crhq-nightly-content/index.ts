// Supabase Edge Function: crhq-nightly-content  (Deno) — runs 22:00 daily via
// pg_cron.
//
// Owns the entire CRHQ content pipeline end to end: scrape -> generate ->
// queue. Replaces the previous split (scrape-crhq-content at 22:00 writing a
// cache; midnight-cron at 00:00 reading it and generating CRHQ content
// alongside every other client's bulk 4-week fill) with one dedicated run,
// because CRHQ content — geopolitics, defence policy — goes stale within
// hours. The whole point is to reference what Craig actually posted, not
// generic pillar copy generated weeks ahead. See midnight-cron/index.ts for
// where CRHQ is now excluded from the general loop.
//
// Step 1 — scrape youtube.com/@combatreadyhq and combatreadyhq.co.uk/news for
//   anything published in the last 48h (_shared/crhqScrape.ts). Always runs,
//   even if generation ends up skipped below — the cache row is also what
//   generate-daily-status reads to report last night's outcome to Quill.
// Step 2 — per platform (facebook, instagram), skip if the queue already has
//   enough upcoming posts (MAX_QUEUED_PER_PLATFORM); otherwise generate ONE
//   post: referencing the scrape if it found anything
//   (content_source='youtube_scrape'), else off CRHQ's pillar rotation
//   (content_source='pillar_fallback').
// Step 3 — queue it as a draft on the next available slot for that
//   platform's posting schedule (mkt_content_schedule, see
//   55_crhq_content_config.sql — facebook Tue/Thu/Sat 18:00, instagram
//   Mon/Tue/Thu/Fri 07:30).
//
// Deploy:  supabase functions deploy crhq-nightly-content
// Schedule: see 56_crhq_nightly_pipeline.sql (also unschedules the old
//   scrape-crhq-content 22:00 job — this function now owns that scrape).
// Secrets (Supabase vault): ANTHROPIC_API_KEY, YOUTUBE_API_KEY (optional —
//   scrape just skips the video half without it), STABILITY_AI_API_KEY
//   (optional — Instagram image generation).
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { scrapeCrhqContent } from '../_shared/crhqScrape.ts'
import { platformSchedule, hasAutoPostOnDate } from '../_shared/fill.ts'
import { dayOfWeekUK, addDays, pickDiversePillar, recentPublishedSummaries, stripMarkdown } from '../_shared/generate.ts'
import { generateReviewedPost } from '../_shared/review.ts'
import { generatePostImage } from '../_shared/image.ts'
import { latestOptimisationNotes } from '../_shared/optimisation.ts'

// deno-lint-ignore no-explicit-any
type Admin = any

const CRHQ_SLUG = 'crhq'
const PLATFORMS = ['facebook', 'instagram']

// Hard ceiling — CRHQ must never have more than this many posts sitting
// upcoming (not yet published or rejected) in the queue per platform. Content
// this time-sensitive goes stale within hours, so bulk-generating weeks ahead
// is exactly the failure mode this exists to prevent. Counted per platform,
// not combined, because facebook (3/week) and instagram (4/week) run
// different cadences — a shared counter would let one platform's backlog
// block the other's generation for no reason.
const MAX_QUEUED_PER_PLATFORM = 3
const QUEUED_STATUSES = ['draft', 'pending', 'approved', 'scheduled']

const SAFETY_MAX_DAYS_WALKED = 21

async function countQueued(admin: Admin, clientId: string, platform: string): Promise<number> {
  const { count } = await admin
    .from('mkt_content_queue')
    .select('id', { count: 'exact', head: true })
    .eq('client_id', clientId).eq('platform', platform).eq('content_type', 'post')
    .in('status', QUEUED_STATUSES)
    .gte('scheduled_for', new Date().toISOString())
  return count ?? 0
}

// Walks forward from tomorrow to the first day matching this platform's
// posting schedule that doesn't already have a post queued for it — one post
// per platform per day, the same rule fillClientGap enforces elsewhere.
// Returns null if CRHQ has no active schedule rows for this platform (a
// misconfiguration — see 55_crhq_content_config.sql) or none free within the
// safety bound.
async function nextAvailableSlot(admin: Admin, client: Record<string, any>, platform: string): Promise<Date | null> {
  const schedule = await platformSchedule(admin, client, platform)
  if (!schedule) return null

  let day = addDays(new Date(), 1)
  for (let walked = 0; walked < SAFETY_MAX_DAYS_WALKED; walked++) {
    if (schedule.days.has(dayOfWeekUK(day)) && !(await hasAutoPostOnDate(admin, client.id, platform, day))) {
      const time = schedule.timeByDay.get(dayOfWeekUK(day)) ?? String(client.post_time ?? '09:00')
      const [hh, mm] = time.split(':')
      const slot = new Date(day); slot.setHours(Number(hh) || 9, Number(mm) || 0, 0, 0)
      return slot
    }
    day = addDays(day, 1)
  }
  return null
}

serve(async () => {
  const started = Date.now()
  const errors: string[] = []
  const notes: string[] = []
  let postsGenerated = 0

  const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)

  try {
    const { data: client, error: clientError } = await admin
      .from('mkt_clients').select('*').eq('slug', CRHQ_SLUG).eq('active', true).maybeSingle()
    if (clientError) throw new Error(`could not load CRHQ client: ${clientError.message}`)
    if (!client) throw new Error('CRHQ client not found or not active — skipping run')

    // Step 1 — scrape, always, regardless of whether generation ends up
    // happening this run (see Step 2's per-platform cap check below).
    const scraped_at = new Date().toISOString()
    const { videos, articles, errors: scrapeErrors } = await scrapeCrhqContent()
    errors.push(...scrapeErrors)
    const { error: cacheError } = await admin.from('crhq_scrape_cache').insert({ scraped_at, videos, articles })
    if (cacheError) errors.push(`cache insert: ${cacheError.message}`)

    const foundContent = videos.length > 0 || articles.length > 0
    const content_source = foundContent ? 'youtube_scrape' : 'pillar_fallback'
    if (!foundContent) {
      notes.push('No new CRHQ YouTube content detected — used pillar fallback')
      console.log('[crhq-nightly-content] no new content in last 48h — falling back to pillar rotation')
    } else {
      console.log(`[crhq-nightly-content] found ${videos.length} video(s), ${articles.length} article(s) — generating from scrape`)
    }

    const recentTopics = await recentPublishedSummaries(admin, client.id, 6)
    const usedThisRun: string[] = []
    // Content optimisation loop — same lookup fill.ts uses for every other
    // client, applied here too since it's a client-level setting on
    // mkt_clients that shouldn't only apply to brands going through
    // fillClientGap.
    const optimisationNotes = await latestOptimisationNotes(admin, client.id)

    for (const platform of PLATFORMS) {
      // Step 2 (limit check) — never let CRHQ accumulate a backlog.
      const queued = await countQueued(admin, client.id, platform)
      if (queued >= MAX_QUEUED_PER_PLATFORM) {
        notes.push(`CRHQ queue sufficient — skipping generation (${platform}: ${queued} already queued)`)
        console.log(`[crhq-nightly-content] ${platform}: ${queued} already queued (>= ${MAX_QUEUED_PER_PLATFORM}) — skipping`)
        continue
      }

      // Find the slot before spending an LLM call on a post that has nowhere
      // to go (e.g. a misconfigured/missing schedule).
      const slot = await nextAvailableSlot(admin, client, platform)
      if (!slot) {
        errors.push(`${platform}: no available slot found in the next ${SAFETY_MAX_DAYS_WALKED} days — check mkt_content_schedule`)
        continue
      }

      // Step 2 (generate) — pillar drives the prompt's "content pillar"
      // framing; for a scrape-driven post that's the scraped content itself,
      // not one of the rotation topics, so a fixed descriptive label is
      // honest about what actually drove the post rather than forcing an
      // unrelated pillar alongside it.
      const pillar = foundContent ? 'CRHQ latest content' : await pickDiversePillar(admin, client, usedThisRun)
      const clientForGeneration = foundContent
        ? { ...client, _recent_topics: recentTopics, _crhq_scrape: { videos, articles }, _optimisation_notes: optimisationNotes }
        : { ...client, _recent_topics: recentTopics, _optimisation_notes: optimisationNotes }

      try {
        const review = await generateReviewedPost(admin, clientForGeneration, platform, pillar)
        if (review.body) review.body = stripMarkdown(review.body)

        // Auto-approve — see _shared/fill.ts's identical guard for the
        // reasoning: only applies to a post that passed review, never to a
        // needs_attention placeholder.
        const autoApprove = review.ok && client.auto_approve === true
        const row = review.ok
          ? {
              client_id: client.id, platform, content_type: 'post', pillar, body: review.body,
              status: autoApprove ? 'approved' : 'draft', generated_by: 'cron', scheduled_for: slot.toISOString(),
              review_status: 'passed', reviewed_at: review.reviewedAt, generation_attempts: review.attempts,
              content_source,
            }
          : {
              client_id: client.id, platform, content_type: 'post', pillar, body: review.body || '',
              status: 'draft', generated_by: 'cron', scheduled_for: slot.toISOString(),
              review_status: 'needs_attention', reviewed_at: review.reviewedAt,
              review_reason: review.reason, generation_attempts: review.attempts,
              content_source,
            }

        const { data: inserted, error: insertError } = await admin.from('mkt_content_queue').insert(row).select('id').single()
        if (insertError) { errors.push(`${platform}: insert failed — ${insertError.message}`); continue }
        if (!review.ok) errors.push(`${platform}: needs attention — ${review.reason}`)
        if (autoApprove) notes.push(`Auto-approved post for ${client.name}`)

        // Best-effort, Instagram-only (image_gen_platforms allow-list already
        // gates this — see _shared/image.ts) — never blocks or fails the post.
        if (review.body) await generatePostImage(admin, client, inserted.id, review.body, platform)

        // Pillar rotation only advances for genuine pillar-fallback posts —
        // the synthetic "CRHQ latest content" label used for scrape-driven
        // posts is not a member of client.content_pillars, so writing it to
        // last_pillar_used would just reset the real rotation to its start
        // next time a fallback post is generated.
        if (!foundContent) {
          usedThisRun.push(pillar)
          await admin.from('mkt_clients').update({ last_pillar_used: pillar }).eq('id', client.id)
        }
        if (review.body) recentTopics.unshift(`[${pillar}] ${review.body.replace(/\s+/g, ' ').trim().slice(0, 140)}`)
        postsGenerated++
        console.log(`[crhq-nightly-content] ${platform}: queued for ${slot.toISOString()} (${content_source})`)
      } catch (e) {
        errors.push(`${platform}: ${String((e as Error)?.message ?? e)}`)
      }
    }
  } catch (e) {
    const msg = `fatal: ${String((e as Error)?.message ?? e)}`
    errors.push(msg)
    console.error(`[crhq-nightly-content] ${msg}`)
  }

  const { error: logError } = await admin.from('mkt_cron_log').insert({
    job_name: 'crhq-nightly-content',
    clients_processed: 1,
    posts_generated: postsGenerated,
    errors: errors.length ? errors : null,
    notes: notes.length ? notes : null,
    duration_ms: Date.now() - started,
  })
  if (logError) console.error(`[crhq-nightly-content] failed to write mkt_cron_log: ${logError.message}`)

  // Same cross-function error log every other cron job writes to — see
  // generate-daily-status's edge_function_errors_last_24h.
  if (errors.length) {
    const { error: efeError } = await admin.from('edge_function_errors').insert({
      function_name: 'crhq-nightly-content',
      error_message: errors.join(' | ').slice(0, 4000),
    })
    if (efeError) console.error(`[crhq-nightly-content] failed to write edge_function_errors: ${efeError.message}`)
  }

  console.log(`[crhq-nightly-content] run complete — ${postsGenerated} post(s), ${notes.length} note(s), ${errors.length} error(s)`)

  return new Response(JSON.stringify({ ok: true, postsGenerated, notes, errors }), {
    headers: { 'Content-Type': 'application/json' },
  })
})
