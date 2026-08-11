// Supabase Edge Function: scrape-crhq-content  (Deno)
//
// Manual/on-demand CRHQ scrape — pulls Combat Ready HQ's own latest YouTube
// uploads and combatreadyhq.co.uk/news articles from the last 48 hours, and
// writes the result to crhq_scrape_cache. Useful for forcing a fresh cache
// row without waiting for the nightly run.
//
// The actual scrape logic lives in _shared/crhqScrape.ts, shared with
// crhq-nightly-content — that function now OWNS the automatic 22:00 run
// (it does its own fresh scrape as step 1 of generating that night's CRHQ
// posts, rather than depending on a separately-timed cron's cached output).
// This function's own 22:00 cron job ('crhq-content-scrape') has been
// unscheduled for that reason — see 56_crhq_nightly_pipeline.sql. It is no
// longer invoked automatically, only ever manually.
//
// Deploy:  supabase functions deploy scrape-crhq-content
// Secrets (Supabase vault): YOUTUBE_API_KEY (YouTube Data API v3 — no OAuth,
//   API-key only). Until it's set this just skips the video half and still
//   writes whatever news articles it found.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { scrapeCrhqContent } from '../_shared/crhqScrape.ts'
import { checkCronAuth } from '../_shared/cronAuth.ts'

serve(async (req) => {
  const auth = await checkCronAuth(req, 'scrape-crhq-content')
  if (!auth.authorised) return auth.response!

  const started = Date.now()
  const scraped_at = new Date().toISOString()

  const { videos, articles, errors } = await scrapeCrhqContent()

  const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
  const { error: insertError } = await admin.from('crhq_scrape_cache').insert({ scraped_at, videos, articles })
  if (insertError) {
    errors.push(`cache insert: ${insertError.message}`)
    console.error(`[scrape-crhq-content] cache insert failed: ${insertError.message}`)
  }

  const { error: logError } = await admin.from('mkt_cron_log').insert({
    job_name: 'crhq-content-scrape',
    clients_processed: 1,
    posts_generated: 0,
    errors: errors.length ? errors : null,
    duration_ms: Date.now() - started,
  })
  if (logError) console.error(`[scrape-crhq-content] failed to write mkt_cron_log: ${logError.message}`)

  console.log(`[scrape-crhq-content] ${videos.length} video(s), ${articles.length} article(s), ${errors.length} error(s)`)

  return new Response(JSON.stringify({ videos, articles, scraped_at, errors }), {
    headers: { 'Content-Type': 'application/json' },
  })
})
