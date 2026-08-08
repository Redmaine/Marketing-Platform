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
//   (optional — image generation).
//
// Images: Instagram gets one on every post. Facebook alternates — one post
//   with an image, the next without (see facebookWantsImage). Both use the
//   same Stability pipeline and the same mkt_clients.visual_style.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { scrapeCrhqContent, type ScrapedVideo, type ScrapedArticle } from '../_shared/crhqScrape.ts'
import { platformSchedule, hasAutoPostOnDate } from '../_shared/fill.ts'
import { dayOfWeekUK, addDays, recentPublishedSummaries, stripMarkdown } from '../_shared/generate.ts'
import { generateReviewedPost } from '../_shared/review.ts'
import { generatePostImage } from '../_shared/image.ts'
import { latestOptimisationNotes } from '../_shared/optimisation.ts'
import { recentRejectionFeedback } from '../_shared/rejectionFeedback.ts'

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

// Incident fix — nextAvailableSlot's walk was bounded only by
// SAFETY_MAX_DAYS_WALKED (21 days) and MAX_QUEUED_PER_PLATFORM (3 posts).
// With CRHQ's real cadence (facebook Tue/Thu/Sat, instagram Mon/Tue/Thu/Fri
// — see 55_crhq_content_config.sql), "3 queued" can legitimately span most
// of a week, which is exactly how posts ended up scheduled for 6 and 8
// August 2026 while the run date was 1 August — CRHQ content is
// time-sensitive (geopolitics/defence) and must never be queued that far
// ahead. Bounding the actual returned slot (not just the day-walk) to this
// window is what fixes that at the source: if no free slot exists within
// the window, nextAvailableSlot now returns null and this platform is
// simply skipped for the night, rather than reaching further into the
// future.
//
// Second incident fix — 48h was too tight for CRHQ's own cadence and
// started causing the opposite failure ("no available slot found"). Both
// platforms' schedules have a genuine 3-day gap between consecutive
// posting days (facebook Sat->Tue, instagram Fri->Mon) — confirmed live:
// on 5 August 22:00 (a Wednesday-night run), facebook's very next posting
// day (Thursday 6 August) was already filled by a real, already-scheduled
// post (metricool_post_id set, not stale/orphaned — mkt_content_schedule
// itself has no per-slot reservation state to audit, it's just a
// recurring weekly template), so the walk correctly moved on to Saturday
// 8 August — a legitimate 3-day-out slot that a 48h window can never
// reach. 96h covers that worst-case single-skip gap with margin for both
// platforms while staying well short of the 5-7-day-out incident this
// constant exists to prevent.
const MAX_LOOKAHEAD_MS = 96 * 60 * 60 * 1000

// Facebook images alternate: one post with an image, the next without, and so
// on. Instagram is unaffected — every Instagram post still gets one.
//
// This run generates at most ONE Facebook post, so the alternation state can't
// live in memory — it has to be derived from what's already queued. Rather
// than counting posts (parity breaks the moment one is rejected or deleted),
// this looks at the most recently scheduled Facebook post and does the
// opposite of it, which self-corrects after any gap.
//
// MUST be called before the new row is inserted. The new post is scheduled
// further into the future than every existing one, so after insertion it would
// be its own "most recent" row — with a null image_url — and the answer would
// be true every single time.
async function facebookWantsImage(admin: Admin, clientId: string): Promise<boolean> {
  const { data, error } = await admin
    .from('mkt_content_queue')
    .select('image_url')
    .eq('client_id', clientId).eq('platform', 'facebook').eq('content_type', 'post')
    .order('scheduled_for', { ascending: false })
    .limit(1)
  if (error) {
    // Fail closed — a lookup failure must not turn into an image on every
    // Facebook post. Text-only is the safe side of this decision.
    console.error(`[crhq-nightly-content] facebook image alternation lookup failed (${error.message}) — defaulting to no image`)
    return false
  }
  const previous = data?.[0]
  if (!previous) return true // no Facebook history yet — start the cycle with an image
  return !previous.image_url
}

// Incident fix — last night's run found 2 videos and 0 articles but
// generated 0 posts. The top-level gate a few lines below this function
// (`foundContent = videos.length > 0 || articles.length > 0`) was already
// an OR, not an AND, so "videos alone" already passed it; the actual
// symptom traced to the per-platform slot/queue gates instead (a near-full
// queue leaving no free slot inside the 48h window — see MAX_LOOKAHEAD_MS
// above). Auditing that gate found a real, separate gap the brief also
// asks to close: neither platform had an EXPLICIT primary source to build
// from — both got the full videos+articles list undifferentiated (see
// prompts.ts's scrape block), leaving it to the model to pick, which is
// exactly how two posts on the same night can end up built around the
// same single item, or Instagram ending up built around an article with
// nothing visual to actually reference.
//
// Picks the most recent item by published_at — scrape ordering isn't
// documented/guaranteed as most-recent-first by either source (YouTube's
// uploads playlist and the news-page regex parser), so this sorts
// explicitly rather than assuming index 0 already is.
function mostRecent<T extends { published_at: string | null }>(items: T[]): T | undefined {
  return [...items].sort((a, b) => new Date(b.published_at ?? 0).getTime() - new Date(a.published_at ?? 0).getTime())[0]
}

interface PrimarySource {
  type: 'video' | 'article'
  title: string
  url: string
}

// Facebook: most recent article if one exists, else most recent video.
// Instagram: most recent video, always — an article has nothing visual to
// build an Instagram post around, so no video found means no eligible
// source for Instagram this run (returns null; the caller skips with a
// note, same pattern as the queue-cap/no-slot skips below).
function primarySourceForPlatform(platform: string, videos: ScrapedVideo[], articles: ScrapedArticle[]): PrimarySource | null {
  if (platform === 'instagram') {
    const v = mostRecent(videos)
    return v ? { type: 'video', title: v.title, url: v.url } : null
  }
  const a = mostRecent(articles)
  if (a) return { type: 'article', title: a.title, url: a.url }
  const v = mostRecent(videos)
  return v ? { type: 'video', title: v.title, url: v.url } : null
}

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

  const cutoff = Date.now() + MAX_LOOKAHEAD_MS
  let day = addDays(new Date(), 1)
  for (let walked = 0; walked < SAFETY_MAX_DAYS_WALKED; walked++) {
    if (schedule.days.has(dayOfWeekUK(day)) && !(await hasAutoPostOnDate(admin, client.id, platform, day))) {
      const time = schedule.timeByDay.get(dayOfWeekUK(day)) ?? String(client.post_time ?? '09:00')
      const [hh, mm] = time.split(':')
      const slot = new Date(day); slot.setHours(Number(hh) || 9, Number(mm) || 0, 0, 0)
      // The walk moves strictly forward in time, so the moment a candidate
      // slot exceeds the 48h window every later candidate would too — no
      // slot available within the window this run, rather than reaching
      // for a date further out (see MAX_LOOKAHEAD_MS above).
      if (slot.getTime() > cutoff) return null
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

  // Typed as Admin (any) — matching the helper signatures above and every
  // other function in this codebase (see fill.ts). Without this the strictly
  // typed client rejects the two-branch `row` union at .insert() below on a
  // review_reason variance that is harmless at runtime.
  const admin: Admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)

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
    // Skip-fix (product decision): CRHQ's entire value is reacting to what
    // Craig actually posted, so it must never invent content off a generic
    // pillar. When the scrape turns up nothing fresh in the window, skip
    // generation for the night rather than falling back to pillar rotation.
    // The scrape cache row was still written above (Step 1), so
    // generate-daily-status can still report the quiet night to Quill.
    if (!foundContent) {
      notes.push('No new CRHQ content in the last 48h — skipping generation (no pillar fallback)')
      console.log('[crhq-nightly-content] no new content in last 48h — skipping generation this run')
    } else {
      console.log(`[crhq-nightly-content] found ${videos.length} video(s), ${articles.length} article(s) — generating from scrape`)

      const content_source = 'youtube_scrape'
      const recentTopics = await recentPublishedSummaries(admin, client.id, 6)
      // Content optimisation loop — same lookup fill.ts uses for every other
      // client, applied here too since it's a client-level setting on
      // mkt_clients that shouldn't only apply to brands going through
      // fillClientGap.
      const optimisationNotes = await latestOptimisationNotes(admin, client.id)
      // Content-quality feedback loop — last 30 days of substantive rejection
      // reasons for CRHQ, folded into the prompt (see rejectionFeedback.ts /
      // prompts.ts) so the model stops repeating them.
      const rejectionFeedback = await recentRejectionFeedback(admin, client.id)

      for (const platform of PLATFORMS) {
        // Per-platform primary source — Facebook: most recent article, else
        // most recent video. Instagram: most recent video, always. See
        // primarySourceForPlatform's own comment. Checked early, same reason
        // as the slot check just below: no point spending an LLM call (or
        // even a queue-cap/slot lookup) on a platform with nothing eligible
        // to build from — this is specifically Instagram with articles but
        // no video found.
        const primarySource = primarySourceForPlatform(platform, videos, articles)
        if (!primarySource) {
          notes.push(`${platform}: no eligible source found (Instagram requires a video; none found this run) — skipping`)
          console.log(`[crhq-nightly-content] ${platform}: no eligible primary source — skipping`)
          continue
        }

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

        // Decided before the insert, deliberately — see facebookWantsImage.
        // Instagram always gets an image; Facebook gets one on alternate posts.
        const wantsImage = platform === 'facebook' ? await facebookWantsImage(admin, client.id) : true

        // Step 2 (generate) — every post here is scrape-driven (the run is
        // skipped entirely above when nothing fresh was found). "CRHQ latest
        // content" is a fixed descriptive label, honest about what drove the
        // post, rather than forcing an unrelated rotation pillar alongside the
        // scraped material.
        const pillar = 'CRHQ latest content'
        const clientForGeneration = {
          ...client,
          _recent_topics: recentTopics,
          _crhq_scrape: { videos, articles },
          // The explicit steer (see prompts.ts) — what THIS post must be
          // built around, on top of the full videos+articles list above
          // (which still gives the model general context/other angles).
          _crhq_primary_source: primarySource,
          _optimisation_notes: optimisationNotes,
          _rejection_feedback: rejectionFeedback,
        }

        try {
          const review = await generateReviewedPost(admin, clientForGeneration, platform, pillar)
          if (review.body) review.body = stripMarkdown(review.body)

          // Auto-approve — see _shared/fill.ts's identical guard for the
          // reasoning: only applies to a post that passed review, never to a
          // needs_attention placeholder.
          const autoApprove = review.ok && client.auto_approve === true
          // rejection_feedback_used: same as fill.ts's identical field — was
          // this post's prompt built with recentRejectionFeedback()'s output
          // for CRHQ, or was there nothing substantive to feed back.
          const row = review.ok
            ? {
                client_id: client.id, platform, content_type: 'post', pillar, body: review.body,
                status: autoApprove ? 'approved' : 'draft', generated_by: 'cron', scheduled_for: slot.toISOString(),
                review_status: 'passed', reviewed_at: review.reviewedAt, generation_attempts: review.attempts,
                content_source, rejection_feedback_used: rejectionFeedback !== null,
              }
            : {
                client_id: client.id, platform, content_type: 'post', pillar, body: review.body || '',
                status: 'draft', generated_by: 'cron', scheduled_for: slot.toISOString(),
                review_status: 'needs_attention', reviewed_at: review.reviewedAt,
                review_reason: review.reason, generation_attempts: review.attempts,
                content_source, rejection_feedback_used: rejectionFeedback !== null,
              }

          const { data: inserted, error: insertError } = await admin.from('mkt_content_queue').insert(row).select('id').single()
          if (insertError) {
            // 23505 = one-auto-post-per-slot (migration 65). Another path
            // claimed this slot after nextAvailableSlot picked it — expected
            // under concurrency, not a failure.
            if ((insertError as { code?: string }).code === '23505') {
              notes.push(`${platform}: slot ${slot.toISOString()} already taken — skipped`)
              continue
            }
            errors.push(`${platform}: insert failed — ${insertError.message}`)
            continue
          }
          if (!review.ok) errors.push(`${platform}: needs attention — ${review.reason}`)
          if (autoApprove) notes.push(`Auto-approved post for ${client.name}`)

          // Best-effort — never blocks or fails the post. Instagram every
          // time; Facebook on alternate posts (wantsImage, decided above).
          // Both platforms run the same Stability pipeline off the same
          // client.visual_style; the image_gen_platforms allow-list still gates
          // the rest (see _shared/image.ts, and migration 61 which adds
          // 'facebook' to CRHQ's allow-list to let this through at all).
          if (review.body && wantsImage) {
            await generatePostImage(admin, client, inserted.id, review.body, platform)
          } else if (review.body && platform === 'facebook') {
            console.log(`[crhq-nightly-content] facebook: skipping image for ${inserted.id} — alternating (previous post had one)`)
          }

          if (review.body) recentTopics.unshift(`[${pillar}] ${review.body.replace(/\s+/g, ' ').trim().slice(0, 140)}`)
          postsGenerated++
          console.log(`[crhq-nightly-content] ${platform}: queued for ${slot.toISOString()} (${content_source})`)
        } catch (e) {
          errors.push(`${platform}: ${String((e as Error)?.message ?? e)}`)
        }
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
