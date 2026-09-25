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
// Also, every run (regardless of scrape outcome) — retry image generation
//   once for any already-queued, still-upcoming post whose image generation
//   exhausted on an earlier night (retryStuckImages, below). Closes the gap
//   where a stuck post just sat blank until someone noticed by hand (14 Sep
//   2026 — see retryStuckImages' header for the full incident and the
//   retry-cap reasoning).
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
import { dayOfWeekUK, addDays, recentPublishedSummaries, stripMarkdown } from '../_shared/generate.ts'
import { recentBrandPosts, recentTopics as recentTopicLabels } from '../_shared/recentSubjects.ts'
import { ukTimeSlotToUtc } from '../_shared/ukTime.ts'
import { generateReviewedPost } from '../_shared/review.ts'
import { generatePostImage } from '../_shared/image.ts'
import { latestOptimisationNotes } from '../_shared/optimisation.ts'
import { recentRejectionFeedback } from '../_shared/rejectionFeedback.ts'
import { checkCronAuth } from '../_shared/cronAuth.ts'
import {
  PLATFORMS, MAX_QUEUED_PER_PLATFORM, QUEUED_STATUSES, SAFETY_MAX_DAYS_WALKED,
  facebookWantsImage, primarySourceForPlatform, countQueued, nextAvailableSlot,
  type AlternationDecision,
} from '../_shared/crhqQueue.ts'
import { recycleMissedSlots } from '../_shared/crhqRecycle.ts'

// deno-lint-ignore no-explicit-any
type Admin = any

const CRHQ_SLUG = 'crhq'

// Did the image actually land? generatePostImage is best-effort and returns
// void: it swallows every failure (provider error, content-policy refusal,
// all review attempts exhausted) into console output and image_review_events
// and tells the caller nothing. That is why the 18 and 20 August runs both
// wrote mkt_content_queue rows with no image, logged 11 'reject'/'exhausted'
// review events between them, and still reported errors=null,
// posts_generated=1 in mkt_cron_log — a clean bill of health on two nights
// the image pipeline failed outright. A silent 100% failure rate reads
// exactly like broken alternation from the queue table, which is what sent
// the last two investigations after the wrong cause.
//
// So: re-read the row and compare against what was asked for. Only a
// requested-but-missing image is surfaced; a deliberate text-only post is
// the feature working.
async function imageLanded(admin: Admin, contentQueueId: string): Promise<boolean> {
  const { data, error } = await admin
    .from('mkt_content_queue').select('image_url').eq('id', contentQueueId).maybeSingle()
  // Unverifiable is not the same as failed — don't invent an error.
  if (error) return true
  return !!data?.image_url
}


// Weekly themed Facebook posts (Craig's confirmed schedule, agreed via
// WhatsApp 6 Sep 2026) — Tuesday shop/coffee, Thursday intelligence
// subscription. Layered ON TOP of the daily scrape-driven post, never
// replacing it: scheduled at a distinct time (12:00 UK) from the regular
// post's slot (18:00), so both can coexist under the one-auto-post-per-slot
// unique index (migration 65), which is keyed on the exact timestamp, not
// the day. See prompts.ts's client._crhq_themed_topic block for the actual
// copy instructions, including why the shop/coffee post deliberately does
// NOT claim the shop is currently open.
const THEMED_WEEKLY: Record<number, { theme: 'shop_coffee' | 'intelligence_subscription'; pillar: string; timeUk: string }> = {
  2: { theme: 'shop_coffee', pillar: 'CRHQ shop & coffee community', timeUk: '12:00' }, // Tuesday
  4: { theme: 'intelligence_subscription', pillar: 'CRHQ intelligence subscription', timeUk: '12:00' }, // Thursday
}

interface ThemedResult {
  generated: boolean
  notes?: string[]
  errors?: string[]
}

// Deliberately independent of Step 1's scrape outcome (foundContent) — these
// posts have nothing to do with what CRHQ posted on YouTube this week, so a
// quiet news night must not also mean a quiet Tuesday/Thursday. Checks only
// tomorrow (matching this cron's existing one-night-ahead philosophy,
// nextAvailableSlot's day-walk is for the scrape-reactive post specifically,
// which does need to search forward for a free day — the themed post's day
// is fixed by the theme itself, so there is nothing to walk toward).
async function generateThemedWeeklyPost(admin: Admin, client: Record<string, any>): Promise<ThemedResult> {
  const tomorrow = addDays(new Date(), 1)
  const config = THEMED_WEEKLY[dayOfWeekUK(tomorrow)]
  if (!config) return { generated: false }

  const slot = ukTimeSlotToUtc(tomorrow, config.timeUk)

  // Idempotency — a themed post already queued for this calendar day (this
  // function ran twice, or a human already placed one manually) means skip,
  // not duplicate.
  const dayStart = new Date(slot)
  dayStart.setUTCHours(0, 0, 0, 0)
  const dayEnd = new Date(dayStart)
  dayEnd.setUTCDate(dayEnd.getUTCDate() + 1)
  const { count } = await admin
    .from('mkt_content_queue')
    .select('id', { count: 'exact', head: true })
    .eq('client_id', client.id).eq('platform', 'facebook').eq('content_type', 'post')
    .eq('content_source', 'themed_weekly')
    .neq('status', 'rejected')
    .gte('scheduled_for', dayStart.toISOString()).lt('scheduled_for', dayEnd.toISOString())
  if ((count ?? 0) > 0) return { generated: false, notes: [`themed weekly (${config.theme}) already queued for this day — skipped`] }

  const clientForGeneration = { ...client, _crhq_themed_topic: { theme: config.theme } }
  const review = await generateReviewedPost(admin, clientForGeneration, 'facebook', config.pillar)
  if (review.body) review.body = stripMarkdown(review.body)

  // Same rule as the nightly scrape post below — never queue an empty body.
  // The 24 Sep 11:00 blank row came from THIS path (content_source
  // 'themed_weekly') on the night the Anthropic usage cap was hit. See the
  // long comment at the nightly post's matching guard for the full story.
  if (!review.body || !review.body.trim()) {
    return {
      generated: false,
      errors: [`themed weekly (${config.theme}): generation produced no text after ${review.attempts} attempt(s) — nothing queued for ${slot.toISOString()}. Last reason: ${review.reason ?? 'unknown'}`],
    }
  }

  // MUST be computed before the insert — see facebookWantsImage's own
  // comment: the new row would otherwise become its own "most recent"
  // Facebook post the instant it exists, with a null image_url, and the
  // answer would be true every single time.
  const decision = await facebookWantsImage(admin, client.id, slot)

  const autoApprove = review.ok && client.auto_approve === true
  const row = review.ok
    ? {
        client_id: client.id, platform: 'facebook', content_type: 'post', pillar: config.pillar, body: review.body,
        status: autoApprove ? 'approved' : 'draft', generated_by: 'cron', scheduled_for: slot.toISOString(),
        review_status: 'passed', reviewed_at: review.reviewedAt, generation_attempts: review.attempts,
        content_source: 'themed_weekly', topic: review.topic,
      }
    : {
        client_id: client.id, platform: 'facebook', content_type: 'post', pillar: config.pillar, body: review.body || '',
        status: 'draft', generated_by: 'cron', scheduled_for: slot.toISOString(),
        review_status: 'needs_attention', reviewed_at: review.reviewedAt, review_reason: review.reason,
        generation_attempts: review.attempts, content_source: 'themed_weekly', topic: review.topic,
      }

  const { data: inserted, error: insertError } = await admin.from('mkt_content_queue').insert(row).select('id').single()
  if (insertError) {
    // 23505 = one-auto-post-per-slot (migration 65) — another path claimed
    // this exact timestamp first. Expected under concurrency, not a failure.
    if ((insertError as { code?: string }).code === '23505') {
      return { generated: false, notes: [`themed weekly (${config.theme}): slot ${slot.toISOString()} already taken — skipped`] }
    }
    return { generated: false, errors: [`themed weekly (${config.theme}): insert failed — ${insertError.message}`] }
  }

  const notes: string[] = []
  const errors: string[] = []
  if (!review.ok) notes.push(`themed weekly (${config.theme}): needs attention — ${review.reason}`)

  // Image generation (fix, 15 Sep 2026). This path never called
  // generatePostImage at all — every themed post sat with image_url null
  // and zero image_review_events forever: not rejected, not exhausted,
  // never attempted. Confirmed on dfb55034-cc2e-442e-aa89-689d09bd192c (the
  // Tuesday shop/coffee post, due 15 Sep 12:00 BST) — its content_source is
  // 'themed_weekly', a fixed weekly slot generated regardless of that
  // night's scrape outcome, not the scrape-reactive 'youtube_scrape' /
  // pillar-fallback path this looked like at first glance. Mirrors the
  // scrape-driven post's own image block (below, ~line 700): gated on
  // review.body and the deny-list only, NOT on review.ok — a needs_attention
  // post (like this one, rejected for a repeat topic) can still be published
  // after a human edits the copy, so its image should be ready too. Checks
  // the same image_gen_disabled_platforms deny-list generatePostImage itself
  // honours, so a deliberate disable is reported as that, not misread as a
  // pipeline failure by imageLanded() below (the exact bug fixed 7 Sep 2026
  // for the scrape path — see that block's comment).
  const imagesDisabledForFacebook = (Array.isArray(client.image_gen_disabled_platforms) ? client.image_gen_disabled_platforms : [])
    .includes('facebook')
  if (imagesDisabledForFacebook) {
    notes.push(`themed weekly (${config.theme}): image generation disabled for this client — skipped (real photos supplied via Drive)`)
  } else if (review.body && decision.wantsImage) {
    await generatePostImage(admin, client, inserted.id, review.body, 'facebook', config.pillar)
    if (!(await imageLanded(admin, inserted.id))) {
      errors.push(`themed weekly (${config.theme}): image requested for ${inserted.id} but none was produced — image pipeline failed (see image_review_events for this post)`)
      console.error(`[crhq-nightly-content] themed weekly (${config.theme}): image requested for ${inserted.id} but none was produced`)
    }
  } else if (review.body) {
    notes.push(`themed weekly (${config.theme}): text-only by design — ${decision.because}`)
  }

  return { generated: true, notes, errors }
}

// Retry step for old, stuck posts (14 Sep 2026) — closes the gap where a
// post that exhausted its image attempts on an earlier night was never
// revisited: this file previously only ever attempted an image once, at
// insert time, for a post it had just generated. Anything that exhausted
// then sat with image_url null forever — nothing here or anywhere else in
// the pipeline ever looked back at already-queued rows — until a human
// noticed and ran regenerate-post-image by hand (as happened for b09c3603
// and 202af081, both exhausted 12 Sep, still stuck 14 Sep with zero further
// attempts in between).
//
// Deliberately narrow. A candidate must have:
//   - no image yet,
//   - a slot still in the future (scheduled_for >= now) — a post whose slot
//     has already passed cannot be rescued by a fresh image, and
//     schedule-to-metricool's exhausted-image guard already blocks it from
//     publishing anyway, so retrying it would just spend a Flux call on a
//     post that can never go out,
//   - at least one real 'exhausted' image_review_events row (distinguishes
//     "genuinely tried and failed" from "never attempted", "disabled for
//     this platform", or a deliberate Facebook text-only alternation choice
//     — none of those should ever be retried), and
//   - fewer than IMAGE_RETRY_CAP exhausted cycles so far.
// IMAGE_RETRY_CAP caps this at ONE automatic retry (two total exhaustions)
// so a genuinely unsolvable topic — see b09c3603's own repeated 0.00-0.20
// SUBJECT relevance scores across 6 attempts on 12 and 14 Sep — does not
// retry every single night forever, burning a real provider call each time.
// Once the cap is hit the post stays flagged needs_attention
// (flagImageNeedsAttention, _shared/image.ts — every exhaustion path calls
// it as of 14 Sep 2026) instead of being retried again: a human supplies a
// real image or approves it text-only from there, same as any other
// needs_attention post.
const IMAGE_RETRY_CAP = 2

async function retryStuckImages(admin: Admin, client: Record<string, any>): Promise<{ retried: number; notes: string[]; errors: string[] }> {
  const notes: string[] = []
  const errors: string[] = []
  let retried = 0

  const { data: stuck, error: stuckError } = await admin
    .from('mkt_content_queue')
    .select('id, platform, body, topic')
    .eq('client_id', client.id)
    .in('platform', PLATFORMS)
    .eq('content_type', 'post')
    .in('status', QUEUED_STATUSES)
    .is('image_url', null)
    .gte('scheduled_for', new Date().toISOString())
  if (stuckError) {
    errors.push(`image retry: lookup for stuck posts failed — ${stuckError.message}`)
    return { retried, notes, errors }
  }
  if (!stuck?.length) return { retried, notes, errors }

  for (const item of stuck) {
    const { data: exhaustedEvents, error: eventsError } = await admin
      .from('image_review_events')
      .select('id')
      .eq('content_queue_id', item.id)
      .eq('verdict', 'exhausted')
    if (eventsError) {
      errors.push(`image retry: exhausted-count lookup failed for ${item.id} — ${eventsError.message}`)
      continue
    }
    const exhaustedCount = exhaustedEvents?.length ?? 0
    // Never actually attempted (e.g. image gen disabled for this platform,
    // or a deliberate Facebook text-only alternation post) — not this gap.
    if (exhaustedCount === 0) continue
    if (exhaustedCount >= IMAGE_RETRY_CAP) {
      notes.push(`${item.platform}: ${item.id} has exhausted image generation ${exhaustedCount}x — retry budget spent, left flagged needs_attention`)
      continue
    }
    if (!item.body) continue

    try {
      await generatePostImage(admin, client, item.id, item.body, item.platform, item.topic ?? undefined)
      const { data: after } = await admin.from('mkt_content_queue').select('image_url').eq('id', item.id).maybeSingle()
      retried++
      notes.push(after?.image_url
        ? `${item.platform}: image retry succeeded for stuck post ${item.id}`
        : `${item.platform}: image retry attempted for stuck post ${item.id} — still no image (see image_review_events)`)
    } catch (e) {
      errors.push(`image retry: ${item.platform} ${item.id} — ${String((e as Error)?.message ?? e)}`)
    }
  }

  return { retried, notes, errors }
}


serve(async (req) => {
  const auth = await checkCronAuth(req, 'crhq-nightly-content')
  if (!auth.authorised) return auth.response!

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

    // Weekly themed post (Tuesday/Thursday) — deliberately BEFORE the
    // foundContent branch below and never gated by it: this is layered on
    // top of the scrape-driven post, not derived from it, so a quiet news
    // night must not also skip Tuesday's shop/coffee post or Thursday's
    // intelligence-subscription post. See generateThemedWeeklyPost's header.
    try {
      const themed = await generateThemedWeeklyPost(admin, client)
      if (themed.generated) postsGenerated++
      if (themed.notes?.length) notes.push(...themed.notes)
      if (themed.errors?.length) errors.push(...themed.errors)
    } catch (e) {
      errors.push(`themed weekly post: ${String((e as Error)?.message ?? e)}`)
    }

    // Retry old stuck images — deliberately independent of Step 1's scrape
    // outcome, same reasoning as the themed post above: a quiet news night
    // must not also mean an already-queued, already-exhausted post from a
    // previous night goes another day untouched. See retryStuckImages'
    // header for the retry budget and eligibility rules.
    try {
      const retry = await retryStuckImages(admin, client)
      notes.push(...retry.notes)
      errors.push(...retry.errors)
      if (retry.retried) console.log(`[crhq-nightly-content] image retry: attempted ${retry.retried} stuck post(s)`)
    } catch (e) {
      errors.push(`image retry: ${String((e as Error)?.message ?? e)}`)
    }

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
      // 30, matching the reviewer's window (was 6, while reviewPost judged
      // against 30 — so this pipeline was rejected for repeating posts it had
      // never been shown; CRHQ's 24 Aug nuclear-strike post sat at position 7).
      const recentTopics = await recentPublishedSummaries(admin, client.id, 30)

      // REPEAT PREVENTION FOR CRHQ AT ALL (5 Sep 2026). This pipeline never
      // attached _repeat_prevention_posts — only fill.ts did — so the block
      // prompts.ts calls NON-NEGOTIABLE was not merely empty here (as it was
      // everywhere, see recentSubjects.ts) but never even offered. CRHQ is the
      // brand that most needs it: its posts are driven by a nightly scrape, so
      // when the news cycle stays on one story the source material itself
      // pushes every post toward the same subject. Pillar rotation cannot help
      // here at all — the pillar below is a fixed label, not a rotation.
      const crhqRecentPosts = await recentBrandPosts(admin, client.id, { days: 60, limit: 30 })
      const repeatPreventionPosts = crhqRecentPosts.map((r) => r.body)
      const avoidTopics = await recentTopicLabels(admin, client.id, { days: 30, limit: 12 })
      console.log(`[crhq-nightly-content] repeat prevention: ${repeatPreventionPosts.length} recent post(s), ${avoidTopics.length} topic label(s) to avoid`)
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
        const slotResult = await nextAvailableSlot(admin, client, platform)
        if (!slotResult.slot) {
          if (slotResult.reason === 'beyond_window') {
            // CRHQ's own cadence (e.g. Facebook's 3-day Sat->Tue gap) — the
            // only free slot exists, it's just further out than content this
            // time-sensitive should ever be queued. Expected, not a fault.
            notes.push(`${platform}: next slot beyond 48h window, skipping until content can stay current`)
          } else {
            errors.push(`${platform}: no available slot found in the next ${SAFETY_MAX_DAYS_WALKED} days — check mkt_content_schedule`)
          }
          continue
        }
        const slot = slotResult.slot

        // Decided before the insert, deliberately — see facebookWantsImage.
        // Instagram always gets an image; Facebook gets one on alternate posts.
        // Scoped to `slot` so the reference is the post that will actually
        // precede this one, not whichever row happens to hold the largest
        // scheduled_for in the queue.
        const decision: AlternationDecision = platform === 'facebook'
          ? await facebookWantsImage(admin, client.id, slot)
          : { wantsImage: true, because: 'instagram — every post gets an image' }
        const wantsImage = decision.wantsImage
        console.log(`[crhq-nightly-content] ${platform}: image decision — wantsImage=${wantsImage} (${decision.because})`)

        // Step 2 (generate) — every post here is scrape-driven (the run is
        // skipped entirely above when nothing fresh was found). "CRHQ latest
        // content" is a fixed descriptive label, honest about what drove the
        // post, rather than forcing an unrelated rotation pillar alongside the
        // scraped material.
        const pillar = 'CRHQ latest content'
        const clientForGeneration = {
          ...client,
          _recent_topics: recentTopics,
          _repeat_prevention_posts: repeatPreventionPosts,
          _topics_to_avoid: avoidTopics,
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

          // NEVER QUEUE AN EMPTY POST (25 Sep 2026). Two blank rows reached
          // the queue on 23 Sep — 25 Sep 17:00 and 24 Sep 11:00 — and sat
          // there occupying their slots with nothing in them. Root cause, from
          // their own review_reason: "Anthropic API error 400 ... You have
          // reached your specified API usage limits". Both generation attempts
          // failed, so review.body was '', and the needs_attention branch
          // below wrote `body: review.body || ''` — a row with no text.
          //
          // Why nobody was told: that outcome went into `notes`, not
          // `errors`, so mkt_cron_log.errors was null, no edge_function_errors
          // row was written, and the run reported posts_generated: 2 — a clean
          // bill of health on a night both posts were empty. anomalies.ts
          // Rule 4 already watches edge_function_errors for exactly this
          // Anthropic cap message; it never fired because nothing ever
          // reached that table.
          //
          // A post that generated and then FAILED REVIEW still gets queued —
          // that is the review pipeline working, and a human can fix the copy.
          // A post with no text at all is a failure of this job: no row, and a
          // real error so it is surfaced everywhere errors are.
          if (!review.body || !review.body.trim()) {
            errors.push(`${platform}: generation produced no text after ${review.attempts} attempt(s) — nothing queued for slot ${slot.toISOString()}. Last reason: ${review.reason ?? 'unknown'}`)
            console.error(`[crhq-nightly-content] ${platform}: empty body, not queuing. ${review.reason ?? ''}`)
            continue
          }

          // Auto-approve — see _shared/fill.ts's identical guard for the
          // reasoning: only applies to a post that passed review, never to a
          // needs_attention placeholder.
          const autoApprove = review.ok && client.auto_approve === true
          // rejection_feedback_used: same as fill.ts's identical field — the
          // resolved rejection-feedback string actually fed into CRHQ's
          // prompt for this post, or null when there was nothing to feed.
          const row = review.ok
            ? {
                client_id: client.id, platform, content_type: 'post', pillar, body: review.body,
                status: autoApprove ? 'approved' : 'draft', generated_by: 'cron', scheduled_for: slot.toISOString(),
                review_status: 'passed', reviewed_at: review.reviewedAt, generation_attempts: review.attempts,
                content_source, rejection_feedback_used: rejectionFeedback, topic: review.topic,
              }
            : {
                client_id: client.id, platform, content_type: 'post', pillar, body: review.body || '',
                status: 'draft', generated_by: 'cron', scheduled_for: slot.toISOString(),
                review_status: 'needs_attention', reviewed_at: review.reviewedAt,
                review_reason: review.reason, generation_attempts: review.attempts,
                content_source, rejection_feedback_used: rejectionFeedback, topic: review.topic,
              }

          // Facebook and Instagram are generated in the same loop on the same
          // night from the same scrape. Without this the second platform
          // cannot see what the first just wrote, which is the tightest
          // possible repeat window this pipeline has.
          if (review.body) repeatPreventionPosts.unshift(review.body)
          if (review.topic) avoidTopics.unshift(review.topic)

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
          // Same root-cause fix as _shared/fill.ts (31 Aug 2026) — this is
          // the content review pipeline correctly catching a real issue,
          // with the post already sitting in mkt_content_queue for a human
          // to see, not a software failure. Was landing in edge_function_
          // errors indistinguishable from a genuine crash.
          if (!review.ok) notes.push(`${platform}: needs attention — ${review.reason}`)
          if (autoApprove) notes.push(`Auto-approved post for ${client.name}`)

          // Real bug, caught by an actual test run of this deploy, not
          // assumed fixed (7 Sep 2026): CRHQ image generation was disabled
          // entirely on both platforms via mkt_clients.image_gen_disabled_
          // platforms (Craig will supply real photos via Drive going
          // forward). generatePostImage already honours that deny-list and
          // correctly no-ops internally — but this function's OWN
          // imageLanded() check had no way to tell "deliberately disabled"
          // apart from "asked for an image and the pipeline failed", so
          // every single Instagram post (wantsImage is always true there)
          // logged a false "image pipeline failed" error, confirmed live on
          // the first real run after deploying the disable. Checking the
          // same deny-list here, before attempting anything, both saves a
          // wasted call into generatePostImage and reports the true reason.
          const imagesDisabledForPlatform = (Array.isArray(client.image_gen_disabled_platforms) ? client.image_gen_disabled_platforms : [])
            .includes(platform)
          if (imagesDisabledForPlatform) {
            notes.push(`${platform}: image generation disabled for this client — skipped (real photos supplied via Drive)`)
          } else if (review.body && wantsImage) {
            // primarySource.title is the actual scraped video/article this post
            // was built around — prompts.ts already steers the COPY with it.
            // Passing it on is Defect 2's fix: without it the image concept
            // only ever saw the finished copy, which on Instagram is two lines
            // and a URL, and the concepts came out generic as a result. See
            // summariseToVisualConcept in _shared/image.ts.
            await generatePostImage(admin, client, inserted.id, review.body, platform, primarySource.title)
            // An image was asked for. If none landed, the image pipeline
            // failed — say so, loudly, in this run's own log rather than
            // leaving it to be reconstructed from image_review_events days
            // later. See imageLanded's comment for why this is not optional.
            if (!(await imageLanded(admin, inserted.id))) {
              errors.push(`${platform}: image requested for ${inserted.id} but none was produced — image pipeline failed (see image_review_events for this post)`)
              console.error(`[crhq-nightly-content] ${platform}: image requested for ${inserted.id} but none was produced`)
            }
          } else if (review.body && platform === 'facebook') {
            notes.push(`facebook: text-only by design — ${decision.because}`)
            console.log(`[crhq-nightly-content] facebook: skipping image for ${inserted.id} — ${decision.because}`)
          }

          if (review.body) recentTopics.unshift(`[${pillar}] ${review.body.replace(/\s+/g, ' ').trim().slice(0, 140)}`)
          postsGenerated++
          console.log(`[crhq-nightly-content] ${platform}: queued for ${slot.toISOString()} (${content_source})`)
        } catch (e) {
          errors.push(`${platform}: ${String((e as Error)?.message ?? e)}`)
        }
      }
    }

    // Slot recycling — AFTER fresh generation, deliberately: tonight's real
    // scrape content has first claim on the open slots; a recycled story
    // only goes into a slot nothing fresh wanted. See _shared/crhqRecycle.ts
    // for the rules (CRHQ only, once per original, never a story a later
    // post on the same platform already told).
    try {
      const recycle = await recycleMissedSlots(admin, client)
      postsGenerated += recycle.recycled.length
      notes.push(...recycle.notes)
      errors.push(...recycle.errors)
      if (recycle.recycled.length) console.log(`[crhq-nightly-content] recycled ${recycle.recycled.length} missed slot(s)`)
    } catch (e) {
      errors.push(`recycle: ${String((e as Error)?.message ?? e)}`)
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
