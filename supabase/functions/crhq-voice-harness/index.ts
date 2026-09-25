// Verification harness for the CRHQ voice/structure fix (25 Sep 2026). NOT
// part of the pipeline, not called by any cron, and DELIBERATELY LEFT
// UNDEPLOYED — every call spends real Anthropic tokens — exactly like
// image-harness, which exists for the same reason and is used the same way:
//
//   supabase functions deploy crhq-voice-harness --project-ref <ref>
//   …run the checks…
//   supabase functions delete crhq-voice-harness --project-ref <ref>
//
// WHY IT EXISTS. Adrian's standard: "Do not report any item as fixed based on
// 'no exception thrown'." A prompt change cannot be verified by reading it.
// The 25 Sep instruction-drift failure was a prompt that asked for the shape
// the brief bans, and the only way to know it is fixed is to generate real
// posts and look at them.
//
// It calls the SAME exported functions the nightly cron calls — generatePost
// (which is buildSystemPrompt + buildUserMessage + the live model) and the
// deterministic checks from review.ts — against the real mkt_clients row and
// the real crhq_scrape_cache, in the project's own environment with the real
// ANTHROPIC_API_KEY. So what is tested is the shipped code path, not a copy.
//
// WRITES NOTHING. It reads mkt_clients, crhq_scrape_cache and
// mkt_content_queue, and returns the generated bodies in the response. No
// queue row, no cron log, no client update — nothing to clean up afterwards.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { generatePost } from '../_shared/generate.ts'
import { crhqThirdPersonViolation, crhqStructureRepeatViolation, clientBannedWordViolation } from '../_shared/review.ts'
import { buildSystemPrompt, buildUserMessage } from '../_shared/prompts.ts'
import { checkCronAuth } from '../_shared/cronAuth.ts'

const CRHQ_ID = 'c14ccad0-21f8-44f0-9464-24f321bea37b'

serve(async (req) => {
  const auth = await checkCronAuth(req, 'crhq-voice-harness')
  if (!auth.authorised) return auth.response ?? new Response('unauthorised', { status: 401 })

  const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
  const { count = 3, platforms = ['facebook', 'instagram'], show_prompt = false } = await req.json().catch(() => ({}))

  const { data: client } = await admin.from('mkt_clients').select('*').eq('id', CRHQ_ID).single()
  const { data: cacheRows } = await admin.from('crhq_scrape_cache').select('videos, articles').order('scraped_at', { ascending: false }).limit(1)
  const videos = (cacheRows?.[0]?.videos ?? []) as Array<Record<string, string>>
  const articles = (cacheRows?.[0]?.articles ?? []) as Array<Record<string, string>>
  const { data: recentRows } = await admin.from('mkt_content_queue')
    .select('body').eq('client_id', CRHQ_ID).order('created_at', { ascending: false }).limit(12)
  const recentBodies = (recentRows ?? []).map((r: { body: string | null }) => r.body).filter(Boolean) as string[]

  const results: Array<Record<string, unknown>> = []
  const produced: string[] = []

  for (const platform of platforms as string[]) {
    for (let i = 0; i < count; i++) {
      const src = videos[i % Math.max(videos.length, 1)]
      const forGen = {
        ...client,
        _crhq_scrape: { videos, articles },
        _crhq_primary_source: src ? { type: 'video', title: src.title, url: src.url } : undefined,
        // Everything generated so far in this run counts as "recent", so the
        // posts are judged against each other and not just against history —
        // the tightest possible repeat window, same as the cron does.
        _repeat_prevention_posts: [...produced, ...recentBodies].slice(0, 20),
        _recent_topics: [], _topics_to_avoid: [],
      }
      try {
        const body = await generatePost(forGen, platform, 'CRHQ latest content')
        const against = [...produced, ...recentBodies]
        produced.push(body)
        results.push({
          platform, source: src?.title ?? null, body,
          third_person: crhqThirdPersonViolation(client, body),
          structure_repeat: crhqStructureRepeatViolation(client, body, against),
          banned_word: clientBannedWordViolation(client, body),
          opening_five_words: body.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim().split(' ').slice(0, 5).join(' '),
          closing_line: String(body).split('\n').map((l) => l.trim()).filter(Boolean).slice(-1)[0] ?? '',
          words: body.trim().split(/\s+/).length,
        })
      } catch (e) {
        results.push({ platform, error: String((e as Error)?.message ?? e).slice(0, 300) })
      }
    }
  }

  return new Response(JSON.stringify({
    ok: true,
    scrape: { videos: videos.length, articles: articles.length },
    results,
    ...(show_prompt && client ? { prompt_sample: { system: buildSystemPrompt(client), user: buildUserMessage(client, 'facebook', 'CRHQ latest content') } } : {}),
  }, null, 2), { headers: { 'Content-Type': 'application/json' } })
})
