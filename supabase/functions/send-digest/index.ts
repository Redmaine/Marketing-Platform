// Supabase Edge Function: send-digest  (Deno) — runs 07:30 UK time daily
// Emails Adrian the day's tasks, overdue items, and every post awaiting
// approval (sorted soonest-scheduled first) across all brands.
// Invoke (cron, no body).
//
// Deploy:  supabase functions deploy send-digest --no-verify-jwt
// (Deployed with JWT verification off so it can be triggered directly by the
// cron schedule — protected instead by a service-role bearer check below,
// same pattern as backfill-content, since this emails Adrian directly and
// has no caller in the frontend.)
// Secrets (Supabase vault): RESEND_API_KEY, DIGEST_RECIPIENT_EMAIL
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { checkCronAuth } from '../_shared/cronAuth.ts'
// Display-only UK-local formatting — see _shared/ukTime.ts. Both labels
// below used a bare toLocaleDateString, which formats in the RUNTIME's own
// timezone, and the Supabase Edge runtime's is UTC — so during BST a post
// scheduled 00:30 UK (23:30 UTC the day before) was listed under the wrong
// day. The query bounds in this file stay UTC.
import { formatUkDate, formatUkTime } from '../_shared/ukTime.ts'

const FROM = 'Your Company AI <hello@yourcompanyai.co.uk>'
const OPS_URL = 'https://ops.yourcompanyai.co.uk'
const DEFAULT_RECIPIENT = 'adrianfielding@me.com'

serve(async (req) => {
  const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json' } })

  const auth = await checkCronAuth(req, 'send-digest')
  if (!auth.authorised) return auth.response!

  try {
    const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    const admin = createClient(Deno.env.get('SUPABASE_URL')!, SERVICE_ROLE_KEY)
    const today = new Date().toISOString().split('T')[0]

    // Part 5 — competitor intelligence only runs Monday 06:00 (see
    // weekly-competitor-search), so the section is only relevant on the
    // Monday occurrence of this daily digest. UK-local, matching every other
    // day-of-week check in this codebase (dayOfWeekUK in _shared/generate.ts).
    const isMondayUK = new Intl.DateTimeFormat('en-GB', { weekday: 'short', timeZone: 'Europe/London' }).format(new Date()) === 'Mon'

    const [clientsRes, tasksRes, overdueRes, postsRes, competitorRes] = await Promise.all([
      admin.from('mkt_clients').select('id, name, short_name, brand_primary_color').eq('active', true),
      admin.from('mkt_tasks').select('*, client:mkt_clients(short_name,name)').eq('completed', false).lte('due_date', today),
      admin.from('mkt_tasks').select('*, client:mkt_clients(short_name,name)').eq('completed', false).lt('due_date', today),
      // Every post awaiting approval across all brands, soonest-scheduled
      // first — not just today's slice. Posts with no scheduled_for sort
      // last (nullsFirst: false) rather than disappearing from the digest.
      //
      // CANONICAL DEFINITION: status IN ('draft','pending'), with no
      // review_status filter and no date filter. This was the most complete
      // of the three definitions that used to exist, and it is now the one
      // Dashboard.jsx and ContentQueue.jsx use as well, via the shared helper
      // in src/lib/awaitingApproval.js — see that file for the full rationale.
      // A post that failed review, or whose slot has passed, still needs a
      // human decision and must stay in this count.
      //
      // This function is a Deno edge function and cannot import across the
      // src/ boundary through its own bundler, so the status list below is a
      // deliberate mirror of AWAITING_APPROVAL_STATUSES rather than an import.
      // If that constant changes, change this line with it.
      admin.from('mkt_content_queue')
        .select('id, platform, body, status, review_status, scheduled_for, is_manual, client:mkt_clients(short_name,name,brand_primary_color)')
        .in('status', ['draft', 'pending'])
        .order('scheduled_for', { ascending: true, nullsFirst: false }),
      isMondayUK
        ? admin.from('competitor_intelligence').select('search_query, result_summary').eq('run_date', today).order('created_at', { ascending: true })
        : Promise.resolve({ data: [] }),
    ])

    const tasks = tasksRes.data || []
    const overdue = overdueRes.data || []
    const posts = postsRes.data || []
    const competitorFindings = competitorRes.data || []
    const overdueIds = new Set(overdue.map((o) => o.id))
    const todayTasks = tasks.filter((t) => !overdueIds.has(t.id))
    const pendingCount = posts.length
    const dateLabel = formatUkDate(new Date(), { weekday: 'long', day: 'numeric', month: 'long' })

    const titleOf = (t: { title?: string; task?: string }) => t.title || t.task || 'Task'
    const nameOf = (x: { client?: { short_name?: string; name?: string } }) => x.client?.short_name || x.client?.name || 'Unassigned'
    const esc = (s: string) => String(s ?? '').replace(/</g, '&lt;').replace(/>/g, '&gt;')

    let html = `<div style="font-family:Arial,sans-serif;color:#1C2B3A;max-width:560px">`
    html += `<h2 style="color:#1C2B3A;margin:0 0 4px">Good morning.</h2>`
    html += `<p style="color:#8FA3B1;margin:0 0 16px">${dateLabel}</p>`

    // ── Section 1: Posts awaiting approval, soonest-scheduled first ───────────
    if (posts.length) {
      html += `<strong>Posts awaiting approval (${posts.length})</strong>`
      for (const p of posts) {
        const colour = p.client?.brand_primary_color || '#E8410A'
        const preview = esc(String(p.body || '').slice(0, 140)) + (String(p.body || '').length > 140 ? '…' : '')
        // Now shows the UK time of day as well as the UK day. This list is
        // the one place Adrian decides whether a slot is right before
        // approving it, and the slot's hour was the one thing it never said.
        const when = p.scheduled_for
          ? `${formatUkDate(p.scheduled_for, { weekday: 'short', day: 'numeric', month: 'short' })}, ${formatUkTime(p.scheduled_for)}`
          : 'no date set'
        html += `<div style="border-left:4px solid ${colour};background:#F7F9FA;border-radius:8px;padding:10px 12px;margin-top:10px">`
        // This badge reflects ORIGIN, not approval state: is_manual means a
        // human wrote the post, !is_manual means the generation pipeline did.
        // It was previously labelled "scheduled", which read as "already
        // approved and queued to Metricool" — the exact opposite of the truth
        // for a post sitting in a list titled "awaiting approval". Every
        // unreviewed auto-generated draft in this digest carried it, so the
        // reader was told the thing needing a decision had already been dealt
        // with. "auto-generated" is what the flag actually means.
        const originLabel = p.is_manual
          ? `<span style="background:#EDE9FE;color:#5B21B6;border-radius:4px;padding:1px 6px;font-size:11px;font-weight:700;margin-left:6px">manual</span>`
          : `<span style="background:#F1F5F9;color:#475569;border-radius:4px;padding:1px 6px;font-size:11px;font-weight:700;margin-left:6px">auto-generated</span>`
        // Review state is a separate axis from origin, and the one that
        // actually changes what the reader should do. Previously absent
        // entirely: a post that failed automated review appeared in this list
        // looking identical to a clean one.
        const reviewLabel = p.review_status === 'needs_attention'
          ? `<span style="background:#FEE2E2;color:#991B1B;border-radius:4px;padding:1px 6px;font-size:11px;font-weight:700;margin-left:6px">failed review</span>`
          : p.review_status === 'blog_dependent'
            ? `<span style="background:#FEF3C7;color:#92400E;border-radius:4px;padding:1px 6px;font-size:11px;font-weight:700;margin-left:6px">waiting on blog</span>`
            : ''
        html += `<div style="font-weight:700;font-size:13px">${nameOf(p)} <span style="color:#8FA3B1;font-weight:400">· ${p.platform} · ${when}</span>${originLabel}${reviewLabel}</div>`
        html += `<div style="font-size:13px;color:#2E4057;margin:6px 0 8px">${preview}</div>`
        html += `<a href="${OPS_URL}/content?status=draft" style="background:${colour};color:#fff;text-decoration:none;padding:6px 12px;border-radius:6px;font-size:13px;font-weight:700">Review</a>`
        html += `</div>`
      }
    }

    // ── Section: Competitor intelligence (Mondays only) ────────────────────────
    if (isMondayUK) {
      html += `<div style="margin-top:16px"><strong>Competitor intelligence</strong>`
      if (competitorFindings.length) {
        for (const f of competitorFindings) {
          html += `<div style="background:#F7F9FA;border-radius:8px;padding:10px 12px;margin-top:8px">`
          html += `<div style="font-weight:700;font-size:13px">${esc(f.search_query)}</div>`
          html += `<div style="font-size:13px;color:#2E4057;margin-top:4px">${esc(f.result_summary)}</div>`
          html += `</div>`
        }
      } else {
        html += `<p style="color:#8FA3B1;font-size:13px;margin-top:6px">Competitor search did not run — check weekly-competitor-search function.</p>`
      }
      html += `</div>`
    }

    if (overdue.length) {
      html += `<div style="background:#FEE2E2;border-radius:10px;padding:12px 14px;margin:16px 0">`
      html += `<strong style="color:#EF4444">Overdue — clear these first</strong>`
      for (const t of overdue) html += `<div style="color:#991B1B;font-size:14px;margin-top:6px">${esc(titleOf(t))} <span style="color:#8FA3B1">· ${nameOf(t)}</span></div>`
      html += `</div>`
    }

    // ── Section 2: Tasks due today ────────────────────────────────────────────
    if (todayTasks.length) {
      html += `<div style="margin-top:16px"><strong>Tasks due today</strong>`
      for (const t of todayTasks) {
        html += `<div style="margin-top:8px"><div style="font-size:14px;font-weight:600">${esc(titleOf(t))} <span style="color:#8FA3B1;font-weight:400">· ${nameOf(t)}</span></div>`
        if (t.notes) html += `<div style="font-size:13px;color:#8FA3B1;margin-top:2px">${esc(t.notes)}</div>`
        html += `</div>`
      }
      html += `</div>`
    } else if (!overdue.length && !posts.length) {
      html += `<p>Nothing scheduled today. Enjoy it.</p>`
    }

    // ── Section 3: Open the platform ──────────────────────────────────────────
    html += `<p style="margin-top:18px;font-size:14px">${pendingCount} post${pendingCount === 1 ? '' : 's'} waiting for approval.</p>`
    html += `<p style="margin-top:14px"><a href="${OPS_URL}" style="background:#E8410A;color:#fff;text-decoration:none;padding:10px 18px;border-radius:8px;font-weight:700">Open the platform</a></p>`
    html += `<p style="color:#8FA3B1;font-size:12px;margin-top:18px">${clientsRes.data?.length || 0} active clients · ${OPS_URL.replace('https://', '')}</p></div>`

    const to = Deno.env.get('DIGEST_RECIPIENT_EMAIL') || DEFAULT_RECIPIENT
    const resendKey = Deno.env.get('RESEND_API_KEY')
    if (!resendKey) {
      console.error('[send-digest] RESEND_API_KEY not configured — cannot send')
      return json({ error: 'RESEND_API_KEY not configured' }, 500)
    }
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: FROM, to, subject: `Good morning — here's your day · ${dateLabel}`, html }),
    })
    if (!r.ok) {
      const detail = await r.text()
      console.error(`[send-digest] Resend rejected the email (to=${to}): ${detail}`)
      return json({ error: 'Resend rejected the email.', detail }, 502)
    }
    console.log(`[send-digest] sent to ${to} — ${todayTasks.length} task(s) today, ${overdue.length} overdue, ${pendingCount} awaiting approval`)
    return json({ ok: true, to, today: todayTasks.length, overdue: overdue.length, pending: pendingCount })
  } catch (e) {
    console.error(`[send-digest] fatal: ${String((e as Error)?.message ?? e)}`)
    return json({ error: String((e as Error)?.message ?? e) }, 500)
  }
})
