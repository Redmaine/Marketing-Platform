// Supabase Edge Function: weekly-content-prompt  (Deno) — runs every Monday
// at 08:00 via pg_cron.
//
// One short email PER active client (not a combined digest — see
// monthly-performance-pull for that pattern) listing what's already planned
// for that brand this week (Mon-Sun), and inviting Adrian to reply with
// anything to fold in — a completed job, a product update, a piece of news.
//
// REPLY HANDLING IS OUT OF SCOPE — this function only sends the prompt.
// Nothing in this codebase parses or acts on a reply to this email; that's a
// future feature (would need an inbound-email webhook, e.g. Resend's inbound
// routing or a dedicated mailbox poll, feeding whatever's added back into
// that week's content generation). Flagging here so it isn't assumed to
// already work.
//
// Deploy:  supabase functions deploy weekly-content-prompt
// Schedule: see 57_monthly_performance_pipeline.sql.
// Secrets (Supabase vault): RESEND_API_KEY.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { checkCronAuth } from '../_shared/cronAuth.ts'

const FROM = 'Your Company AI <hello@yourcompanyai.co.uk>'
const RECIPIENT = 'hello@yourcompanyai.co.uk'
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

function dayOfWeekUK(d: Date): number {
  return Number(
    new Intl.DateTimeFormat('en-GB', { weekday: 'short', timeZone: 'Europe/London' })
      .format(d)
      .replace(/Sun/, '0').replace(/Mon/, '1').replace(/Tue/, '2').replace(/Wed/, '3')
      .replace(/Thu/, '4').replace(/Fri/, '5').replace(/Sat/, '6')
  )
}

function addDays(d: Date, n: number): Date {
  const x = new Date(d)
  x.setDate(x.getDate() + n)
  return x
}

// This week's Monday 00:00 through next Monday 00:00 (UK-local day
// boundaries, matching generate-daily-status's own date-bucketing approach).
// Runs on a Monday, so this is always "today through Sunday" — kept
// dow-general rather than hardcoded so a manual/late trigger on another day
// still returns a sane current week.
function thisWeekBounds(now: Date): { monday: Date; nextMonday: Date } {
  const dow = dayOfWeekUK(now) // 0=Sun..6=Sat
  const mondayOffset = dow === 0 ? -6 : 1 - dow
  const monday = new Date(now); monday.setHours(0, 0, 0, 0)
  monday.setDate(monday.getDate() + mondayOffset)
  const nextMonday = addDays(monday, 7)
  return { monday, nextMonday }
}

serve(async (req) => {
  const auth = await checkCronAuth(req, 'weekly-content-prompt')
  if (!auth.authorised) return auth.response!

  const started = Date.now()
  const errors: string[] = []
  let clientsProcessed = 0
  let emailsSent = 0

  const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
  const resendKey = Deno.env.get('RESEND_API_KEY')

  try {
    if (!resendKey) throw new Error('RESEND_API_KEY not configured in Supabase vault')

    const now = new Date()
    const { monday, nextMonday } = thisWeekBounds(now)
    const dateLabel = monday.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })

    const { data: clients, error: clientsError } = await admin
      .from('mkt_clients').select('id, name').eq('active', true).order('name')
    if (clientsError) throw new Error(`could not load active clients: ${clientsError.message}`)
    console.log(`[weekly-content-prompt] starting run for week of ${dateLabel} — ${clients?.length ?? 0} active client(s)`)

    for (const client of clients ?? []) {
      clientsProcessed++
      try {
        const { data: posts, error: postsError } = await admin
          .from('mkt_content_queue')
          .select('platform, pillar, scheduled_for')
          .eq('client_id', client.id)
          .eq('content_type', 'post')
          .neq('status', 'rejected')
          .gte('scheduled_for', monday.toISOString())
          .lt('scheduled_for', nextMonday.toISOString())
          .order('scheduled_for', { ascending: true })
        if (postsError) { errors.push(`${client.name}: ${postsError.message}`); continue }

        // One line per day, Mon-Sun, whatever's planned (there can be more
        // than one post — e.g. facebook + instagram the same day).
        const byDay = new Map<number, string[]>()
        for (const p of posts ?? []) {
          if (!p.scheduled_for) continue
          const dow = dayOfWeekUK(new Date(p.scheduled_for))
          const line = `${p.pillar || 'General'} (${p.platform})`
          const existing = byDay.get(dow) ?? []
          existing.push(line)
          byDay.set(dow, existing)
        }
        const weekOrder = [1, 2, 3, 4, 5, 6, 0] // Monday..Sunday
        const themeLines = weekOrder.map((dow) => {
          const items = byDay.get(dow)
          return `${DAY_NAMES[dow]}: ${items && items.length ? items.join(', ') : 'Nothing scheduled'}`
        })

        const subject = `Quill Weekly Prompt — ${client.name} — ${dateLabel}`
        const text = [
          'Good morning. Here is what is planned for ' + client.name + ' this week:',
          '',
          ...themeLines,
          '',
          'Anything to add? A job completed, a product update, a piece of news? Reply to this email and it will be worked into this week\'s posts.',
        ].join('\n')

        const r = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { Authorization: `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ from: FROM, to: RECIPIENT, subject, text }),
        })
        if (!r.ok) {
          const detail = await r.text()
          errors.push(`${client.name}: Resend rejected the email — ${detail.slice(0, 300)}`)
          continue
        }
        emailsSent++
        console.log(`[weekly-content-prompt] ${client.name}: sent`)
      } catch (e) {
        const msg = `${client.name}: ${String((e as Error)?.message ?? e)}`
        errors.push(msg)
        console.error(`[weekly-content-prompt] ${msg}`)
      }
    }
  } catch (e) {
    const msg = `fatal: ${String((e as Error)?.message ?? e)}`
    errors.push(msg)
    console.error(`[weekly-content-prompt] ${msg}`)
  }

  const { error: logError } = await admin.from('mkt_cron_log').insert({
    job_name: 'weekly-content-prompt',
    clients_processed: clientsProcessed,
    posts_generated: 0,
    errors: errors.length ? errors : null,
    duration_ms: Date.now() - started,
  })
  if (logError) console.error(`[weekly-content-prompt] failed to write mkt_cron_log: ${logError.message}`)

  if (errors.length) {
    const { error: efeError } = await admin.from('edge_function_errors').insert({
      function_name: 'weekly-content-prompt',
      error_message: errors.join(' | ').slice(0, 4000),
    })
    if (efeError) console.error(`[weekly-content-prompt] failed to write edge_function_errors: ${efeError.message}`)
  }

  console.log(`[weekly-content-prompt] run complete — ${clientsProcessed} client(s), ${emailsSent} email(s) sent, ${errors.length} error(s)`)

  return new Response(JSON.stringify({ ok: true, clientsProcessed, emailsSent, errors }), {
    headers: { 'Content-Type': 'application/json' },
  })
})
