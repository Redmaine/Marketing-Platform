// Supabase Edge Function: send-digest  (Deno) — runs 07:30 daily (scheduled in Phase 5)
// Emails Adrian the day's tasks, overdue items, and posts awaiting approval.
// Invoke (cron, no body).
//
// Deploy:  supabase functions deploy send-digest --no-verify-jwt
// Secrets (Supabase vault): RESEND_API_KEY
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const FROM = 'Your Company AI <hello@yourcompanyai.co.uk>'
const OPS_URL = 'https://ops.yourcompanyai.co.uk'

serve(async () => {
  const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json' } })
  try {
    const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
    const today = new Date().toISOString().split('T')[0]
    const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1)
    const tomorrowDate = tomorrow.toISOString().split('T')[0]

    const [clientsRes, tasksRes, pendingRes, overdueRes, postsRes] = await Promise.all([
      admin.from('mkt_clients').select('id, name, short_name, brand_primary_color').eq('active', true),
      admin.from('mkt_tasks').select('*, client:mkt_clients(short_name,name)').eq('completed', false).lte('due_date', today),
      admin.from('mkt_content_queue').select('id', { count: 'exact', head: true }).in('status', ['draft', 'pending']),
      admin.from('mkt_tasks').select('*, client:mkt_clients(short_name,name)').eq('completed', false).lt('due_date', today),
      // Today's posts awaiting action: drafts/approved scheduled for today.
      admin.from('mkt_content_queue')
        .select('id, platform, body, status, scheduled_for, client:mkt_clients(short_name,name,brand_primary_color)')
        .in('status', ['draft', 'pending', 'approved'])
        .gte('scheduled_for', today).lt('scheduled_for', tomorrowDate)
        .order('scheduled_for', { ascending: true }),
    ])

    const tasks = tasksRes.data || []
    const overdue = overdueRes.data || []
    const posts = postsRes.data || []
    const overdueIds = new Set(overdue.map((o) => o.id))
    const todayTasks = tasks.filter((t) => !overdueIds.has(t.id))
    const pendingCount = pendingRes.count || 0
    const dateLabel = new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })

    const titleOf = (t: { title?: string; task?: string }) => t.title || t.task || 'Task'
    const nameOf = (x: { client?: { short_name?: string; name?: string } }) => x.client?.short_name || x.client?.name || 'Unassigned'
    const esc = (s: string) => String(s ?? '').replace(/</g, '&lt;').replace(/>/g, '&gt;')

    let html = `<div style="font-family:Arial,sans-serif;color:#1C2B3A;max-width:560px">`
    html += `<h2 style="color:#1C2B3A;margin:0 0 4px">Good morning.</h2>`
    html += `<p style="color:#8FA3B1;margin:0 0 16px">${dateLabel}</p>`

    // ── Section 1: Today's posts ──────────────────────────────────────────────
    if (posts.length) {
      html += `<strong>Today's posts</strong>`
      for (const p of posts) {
        const colour = p.client?.brand_primary_color || '#E8410A'
        const preview = esc(String(p.body || '').slice(0, 140)) + (String(p.body || '').length > 140 ? '…' : '')
        html += `<div style="border-left:4px solid ${colour};background:#F7F9FA;border-radius:8px;padding:10px 12px;margin-top:10px">`
        html += `<div style="font-weight:700;font-size:13px">${nameOf(p)} <span style="color:#8FA3B1;font-weight:400">· ${p.platform} · ${p.status}</span></div>`
        html += `<div style="font-size:13px;color:#2E4057;margin:6px 0 8px">${preview}</div>`
        html += `<a href="${OPS_URL}/clients" style="background:${colour};color:#fff;text-decoration:none;padding:6px 12px;border-radius:6px;font-size:13px;font-weight:700">Approve</a>`
        html += `</div>`
      }
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

    const to = Deno.env.get('DIGEST_RECIPIENT_EMAIL') || 'hello@yourcompanyai.co.uk'
    const resendKey = Deno.env.get('RESEND_API_KEY')
    if (!resendKey) return json({ error: 'RESEND_API_KEY not configured' }, 500)
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: FROM, to, subject: `Good morning — here's your day · ${dateLabel}`, html }),
    })
    if (!r.ok) return json({ error: 'Resend rejected the email.', detail: await r.text() }, 502)
    return json({ ok: true, today: todayTasks.length, overdue: overdue.length, pending: pendingCount })
  } catch (e) {
    return json({ error: String((e as Error)?.message ?? e) }, 500)
  }
})
