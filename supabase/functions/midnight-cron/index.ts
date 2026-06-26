// Supabase Edge Function: midnight-cron  (Deno) — runs 00:00 daily via pg_cron
// Pre-generates tomorrow's posts for every active client that's due to post, so
// they're waiting in the queue for approval in the morning.
//
// Why it doesn't call generate-content: that function is admin-gated (mkt_is_admin
// on the caller's JWT). Cron runs with the service role (no user email), so it
// would be rejected. We mirror generate-content here — same model, same
// MASTER_SYSTEM_PROMPT verbatim, same user-message template — and write directly.
//
// Deploy:  supabase functions deploy midnight-cron
// Schedule: see 11_cron_jobs.sql.  Secrets (vault): ANTHROPIC_API_KEY.
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const MODEL = 'claude-haiku-4-5-20251001'

// MASTER_SYSTEM_PROMPT — verbatim from the brief. Do not shorten or rewrite.
const MASTER_SYSTEM_PROMPT = `You are one of the best copywriters in the UK. You have won awards. Your work has appeared in national campaigns. You write for businesses, not brands — and you write like a person, not a department.

VOICE AND STYLE — NON-NEGOTIABLE:
- Short sentences. Varied rhythm. Punchy. Read it back — if it sounds like a press release, start again.
- Lead with the most interesting thing. Not a preamble. Not context-setting. The most interesting thing, first.
- Never tell the reader what they already know. Don't explain the problem they live with every day — just show you understand it, then move.
- Every sentence must earn its place. If removing it changes nothing, remove it.
- Write the way a smart, straight-talking business owner would speak to a customer they respect.
- No corporate voice. No agency voice. The voice of the business itself.

BANNED WORDS AND PHRASES — NEVER USE THESE:
leverage, utilise, comprehensive, seamless, game-changing, innovative, cutting-edge, passionate, excited, proud, delighted, thrilled, dynamic, bespoke (unless it genuinely is), solution (as a verb), ecosystem, journey, space (as in "the HR space"), empower, transform, revolutionise, best-in-class, world-class, going forward, at the end of the day, in today's fast-paced world, we're excited to announce, don't hesitate to, reach out.

BANNED FORMATS:
- No emojis. Ever.
- No hashtag spam. Maximum two hashtags if needed, specific not generic.
- No bullet points in social copy.
- No "Here's a post about X:" — just write the post.
- No exclamation marks unless the sentence genuinely warrants one (rare).

QUALITY TEST — before finishing, ask:
1. Would a real person write this? Or does it sound like it was generated?
2. Is the opening line strong enough to stop a scroll?
3. Is there a single weak sentence that could be cut?
4. Does it sound like THIS business, or could it belong to anyone?

FORMAT: Return only the post copy. Nothing else. No preamble. No label. Just the copy.`

async function generatePost(client: Record<string, any>, platform: string, pillar: string): Promise<string> {
  // v3: the client's own master_prompt is the system prompt.
  const systemPrompt = (client.master_prompt && client.master_prompt.trim())
    ? client.master_prompt
    : MASTER_SYSTEM_PROMPT
  const userMessage = `Write a ${platform} post for the ${pillar} content pillar. 150-250 words.`
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': Deno.env.get('ANTHROPIC_API_KEY')!,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ model: MODEL, max_tokens: 600, system: systemPrompt, messages: [{ role: 'user', content: userMessage }] }),
  })
  const ai = await r.json()
  return ai?.content?.[0]?.text?.trim() ?? ''
}

serve(async () => {
  const started = Date.now()
  const errors: string[] = []
  let clientsProcessed = 0
  let postsGenerated = 0

  const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)

  try {
    // Tomorrow's day_of_week (0=Sun..6=Sat) in UK time — matched against
    // mkt_content_schedule.day_of_week.
    const tomorrow = new Date()
    tomorrow.setDate(tomorrow.getDate() + 1)
    const tomorrowDow = Number(
      new Intl.DateTimeFormat('en-GB', { weekday: 'short', timeZone: 'Europe/London' })
        .format(tomorrow)
        .replace(/Sun/, '0').replace(/Mon/, '1').replace(/Tue/, '2').replace(/Wed/, '3')
        .replace(/Thu/, '4').replace(/Fri/, '5').replace(/Sat/, '6')
    )

    // All active schedules due tomorrow, with their client joined.
    const { data: schedules } = await admin
      .from('mkt_content_schedule')
      .select('*, client:mkt_clients(*)')
      .eq('active', true)
      .eq('day_of_week', tomorrowDow)

    for (const sched of schedules ?? []) {
      clientsProcessed++
      const client = sched.client
      if (!client || client.active === false) continue
      try {
        const platform: string = sched.platform || 'facebook'

        // Skip if this client+platform already has something waiting for tomorrow.
        const { count } = await admin
          .from('mkt_content_queue')
          .select('id', { count: 'exact', head: true })
          .eq('client_id', client.id)
          .eq('platform', platform)
          .in('status', ['draft', 'pending', 'scheduled'])
        if ((count ?? 0) > 0) continue

        // Pillar: schedule's own pillar wins; otherwise rotate the client's pillars.
        const pillars: string[] = client.content_pillars ?? []
        let pillar = sched.pillar || pillars[0] || 'General'
        if (!sched.pillar && pillars.length > 1) {
          const { data: last } = await admin
            .from('mkt_content_queue').select('pillar')
            .eq('client_id', client.id).order('created_at', { ascending: false }).limit(1).maybeSingle()
          if (last?.pillar) {
            const i = pillars.indexOf(last.pillar)
            pillar = pillars[(i + 1) % pillars.length]
          }
        }

        const body = await generatePost(client, platform, pillar)
        if (!body) { errors.push(`${client.name}: empty AI response`); continue }

        // Planned slot = tomorrow at the schedule's time_uk (kept as a hint).
        const [hh, mm] = String(sched.time_uk ?? client.post_time ?? '09:00').split(':')
        const slot = new Date(tomorrow); slot.setHours(Number(hh) || 9, Number(mm) || 0, 0, 0)

        const { error } = await admin.from('mkt_content_queue').insert({
          client_id: client.id, platform, content_type: 'post', pillar, body,
          status: 'draft', generated_by: 'cron', scheduled_for: slot.toISOString(),
        })
        if (error) { errors.push(`${client.name}: insert failed — ${error.message}`); continue }
        postsGenerated++
      } catch (e) {
        errors.push(`${client?.name ?? 'unknown'}: ${String((e as Error)?.message ?? e)}`)
      }
    }
  } catch (e) {
    errors.push(`fatal: ${String((e as Error)?.message ?? e)}`)
  }

  // Log the run.
  await admin.from('mkt_cron_log').insert({
    job_name: 'midnight-content-generation',
    clients_processed: clientsProcessed,
    posts_generated: postsGenerated,
    errors: errors.length ? errors : null,
    duration_ms: Date.now() - started,
  })

  return new Response(JSON.stringify({ ok: true, clientsProcessed, postsGenerated, errors }), {
    headers: { 'Content-Type': 'application/json' },
  })
})
