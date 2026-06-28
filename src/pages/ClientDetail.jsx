import { useEffect, useRef, useState } from 'react'
import { useParams } from 'react-router-dom'
import supabase from '../lib/supabase'

const TABS = ['overview', 'content', 'calendar', 'notes', 'report', 'settings']
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function ClientDetail() {
  const { slug } = useParams()
  const [tab, setTab] = useState('overview')
  const [client, setClient] = useState(null)
  const [content, setContent] = useState([])
  const [reports, setReports] = useState([])
  const [loading, setLoading] = useState(true)

  async function load() {
    setLoading(true)
    const clientQuery = supabase.from('mkt_clients').select('*')
    const c = await (UUID_RE.test(slug)
      ? clientQuery.eq('id', slug)
      : clientQuery.eq('slug', slug)).maybeSingle()

    const found = c.data
    if (!found) { setClient(null); setLoading(false); return }

    const [q, r] = await Promise.all([
      supabase.from('mkt_content_queue').select('*').eq('client_id', found.id).order('created_at', { ascending: false }),
      supabase.from('mkt_reports').select('*').eq('client_id', found.id).order('created_at', { ascending: false }),
    ])
    setClient(found); setContent(q.data || []); setReports(r.data || [])
    setLoading(false)
  }
  useEffect(() => { load() }, [slug])

  if (loading) return (
    <div className="page">
      <div className="skel" style={{ height: 32, width: 180, marginBottom: 8 }} />
      <div className="skel" style={{ height: 16, width: 120, marginBottom: 20 }} />
      <div style={{ display: 'flex', gap: 4, marginBottom: 16 }}>
        {TABS.map((_, i) => <div key={i} className="skel" style={{ height: 36, width: 76, borderRadius: 8 }} />)}
      </div>
      <div className="skel" style={{ height: 220, borderRadius: 14 }} />
    </div>
  )
  if (!client) return <div className="page"><p className="empty">Client not found.</p></div>

  return (
    <div className="page">
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span className={'dot dot-' + (client.traffic_light || 'green')} />
        <h1>{client.name}</h1>
        {client.tier && <span className="tier">{client.tier}</span>}
      </div>
      <p className="page-sub">{client.location || client.industry}</p>

      <div className="tabs">
        {TABS.map((t) => (
          <button key={t} className={'tab' + (tab === t ? ' active' : '')} onClick={() => setTab(t)}
            style={{ textTransform: 'capitalize' }}>{t}</button>
        ))}
      </div>

      {tab === 'overview'  && <Overview client={client} />}
      {tab === 'content'   && <ContentTab content={content} onRefresh={load} />}
      {tab === 'calendar'  && <CalendarTab clientId={client.id} />}
      {tab === 'notes'     && <NotesTab clientId={client.id} />}
      {tab === 'report'    && <ReportTab reports={reports} clientId={client.id} onRefresh={load} />}
      {tab === 'settings'  && <SettingsTab client={client} onSaved={load} />}
    </div>
  )
}

/* ---- Overview ---- */
function KV({ k, v }) {
  return <div className="row"><span className="muted">{k}</span><span style={{ fontWeight: 600, textAlign: 'right' }}>{v || '—'}</span></div>
}

function Overview({ client }) {
  const sb = client.website_score_breakdown || {}
  return (
    <div className="grid grid-2" style={{ alignItems: 'start' }}>
      <div className="card">
        <h2 style={{ fontSize: 15, marginBottom: 8 }}>Details</h2>
        <KV k="Industry" v={client.industry} />
        <KV k="Website" v={client.website} />
        <KV k="Monthly fee" v={client.monthly_fee ? `£${client.monthly_fee}` : null} />
        <KV k="Rating" v={client.google_rating ? `★ ${client.google_rating} (${client.review_count || 0})` : null} />
      </div>
      <div className="card">
        <h2 style={{ fontSize: 15, marginBottom: 8 }}>Strategy</h2>
        <KV k="Tone of voice" v={client.tone_of_voice} />
        <KV k="Services" v={client.key_services} />
        <KV k="Target customer" v={client.target_customer} />
        <KV k="Pillars" v={(client.content_pillars || []).join(' · ')} />
        {client.website_score != null && (
          <>
            <div className="row"><span className="muted">Website score</span><strong>{client.website_score}/100</strong></div>
            <div style={{ display: 'flex', gap: 10, marginTop: 8 }}>
              {['mobile', 'copy', 'cta', 'trust'].map((k) => (
                <div key={k} style={{ flex: 1, textAlign: 'center' }}>
                  <div style={{ fontWeight: 800 }}>{sb[k] ?? '—'}</div>
                  <div className="muted" style={{ fontSize: 11, textTransform: 'capitalize' }}>{k}</div>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  )
}

/* ---- Content tab ---- */
function statusColour(s) {
  const map = {
    draft:     { bg: '#F3F4F6', text: '#6B7280' },
    pending:   { bg: '#FEF3C7', text: '#92400E' },
    approved:  { bg: '#D1FAE5', text: '#065F46' },
    scheduled: { bg: '#DBEAFE', text: '#1E40AF' },
    published: { bg: '#E0E7FF', text: '#3730A3' },
  }
  return map[s] || { bg: 'var(--chalk)', text: 'var(--steel)' }
}

function ContentTab({ content, onRefresh }) {
  const [filter, setFilter] = useState('all')
  const [editing, setEditing] = useState(null)
  const [retrying, setRetrying] = useState(null)   // item id currently being retried
  const [notice, setNotice] = useState('')

  const FILTERS = ['all', 'draft', 'pending', 'approved', 'scheduled', 'published']
  const filtered = filter === 'all' ? content : content.filter((c) => c.status === filter)

  async function approve(item) {
    const scheduled_for = item.scheduled_for || new Date(Date.now() + 86_400_000).toISOString()
    await supabase.from('mkt_content_queue')
      .update({ status: 'approved', approved_at: new Date().toISOString(), scheduled_for })
      .eq('id', item.id)
    onRefresh()
  }

  async function del(item) {
    if (!window.confirm('Delete this post?')) return
    await supabase.from('mkt_content_queue').delete().eq('id', item.id)
    onRefresh()
  }

  async function retryMetricool(item) {
    setRetrying(item.id); setNotice('')
    const { data, error } = await supabase.functions.invoke('schedule-to-metricool', {
      body: { content_queue_id: item.id, scheduled_for: item.scheduled_for },
    })
    setRetrying(null)
    if (error || data?.error) {
      const detail = data?.detail ? ' — ' + (typeof data.detail === 'string' ? data.detail : JSON.stringify(data.detail)) : ''
      setNotice('Metricool error: ' + (data?.error || error?.message || 'unknown') + detail)
    } else {
      setNotice('Scheduled to Metricool for ' + new Date(data.scheduled_for).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }))
      onRefresh()
    }
  }

  return (
    <>
      <div style={{ display: 'flex', gap: 6, marginBottom: 14, overflowX: 'auto', paddingBottom: 4 }}>
        {FILTERS.map((s) => (
          <button key={s} onClick={() => setFilter(s)}
            className={'btn btn-sm ' + (filter === s ? 'btn-dark' : 'btn-ghost')}
            style={{ textTransform: 'capitalize', whiteSpace: 'nowrap' }}>{s}</button>
        ))}
      </div>
      {notice && (
        <div style={{ marginBottom: 12, padding: '8px 12px', borderRadius: 8, fontSize: 13,
          background: notice.startsWith('Metricool error') ? 'var(--red-pale, #FEE2E2)' : '#D1FAE5',
          color: notice.startsWith('Metricool error') ? 'var(--red, #DC2626)' : '#065F46' }}>
          {notice}
          <button onClick={() => setNotice('')} style={{ marginLeft: 10, fontSize: 12, background: 'none', border: 'none', cursor: 'pointer', opacity: 0.6 }}>✕</button>
        </div>
      )}

      {filtered.length === 0 ? <p className="empty">Nothing here.</p> : (
        <div className="card">
          {filtered.map((c) => (
            <div key={c.id} style={{ padding: '14px 0', borderBottom: '1px solid var(--line)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 10 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--mist)', textTransform: 'capitalize', marginBottom: 6 }}>
                    {c.platform}{c.pillar ? ` · ${c.pillar}` : ''}
                    {c.scheduled_for && (
                      <span style={{ marginLeft: 8 }}>
                        {new Date(c.scheduled_for).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}
                        {' '}{new Date(c.scheduled_for).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}
                      </span>
                    )}
                  </div>
                  {editing === c.id ? (
                    <EditInline item={c} onDone={() => { setEditing(null); onRefresh() }} />
                  ) : (
                    <div style={{ fontSize: 14, lineHeight: 1.5 }}>{c.body}</div>
                  )}
                </div>

                {editing !== c.id && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4, flexShrink: 0, alignItems: 'flex-end' }}>
                    <span className="pill" style={{ background: statusColour(c.status).bg, color: statusColour(c.status).text }}>
                      {c.status}
                    </span>
                    {/* Issue 4: show scheduled date/time under status badge */}
                    {c.scheduled_for && (c.status === 'approved' || c.status === 'scheduled') && (
                      <span style={{ fontSize: 11, color: 'var(--mist)', textAlign: 'right', lineHeight: 1.3 }}>
                        {new Date(c.scheduled_for).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })}
                        {' at '}
                        {new Date(c.scheduled_for).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}
                      </span>
                    )}
                    <div style={{ display: 'flex', gap: 4, marginTop: 4, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                      {(c.status === 'draft' || c.status === 'pending') && (
                        <button className="btn btn-primary btn-sm" style={{ fontSize: 12 }} onClick={() => approve(c)}>Approve</button>
                      )}
                      {/* Issue 1: only show Retry when status is 'approved' — once scheduled, status is the source of truth */}
                      {c.status === 'approved' && (
                        <button className="btn btn-ghost btn-sm" style={{ fontSize: 12, color: '#92400E', background: '#FEF3C7', border: '1px solid #F59E0B' }}
                          disabled={retrying === c.id} onClick={() => retryMetricool(c)}>
                          {retrying === c.id ? 'Sending…' : 'Send to Metricool'}
                        </button>
                      )}
                      <button className="btn btn-ghost btn-sm" style={{ fontSize: 12 }} onClick={() => setEditing(c.id)}>Edit</button>
                      <button className="btn btn-ghost btn-sm" style={{ fontSize: 12, color: 'var(--red)' }} onClick={() => del(c)}>Delete</button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  )
}

function EditInline({ item, onDone }) {
  const [body, setBody] = useState(item.body || '')
  const [scheduledFor, setScheduledFor] = useState(
    item.scheduled_for ? item.scheduled_for.slice(0, 16) : ''
  )
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')

  async function save() {
    setBusy(true); setNotice('')
    const updates = { body }
    if (scheduledFor) updates.scheduled_for = new Date(scheduledFor).toISOString()
    await supabase.from('mkt_content_queue').update(updates).eq('id', item.id)

    // Issue 5: if post is approved or already has a Metricool ID, re-send with
    // the new time. The edge function handles PATCH vs POST (issue 8).
    const shouldResend = item.status === 'approved' || item.metricool_post_id
    if (shouldResend && scheduledFor) {
      const iso = new Date(scheduledFor).toISOString()
      const { data, error } = await supabase.functions.invoke('schedule-to-metricool', {
        body: { content_queue_id: item.id, scheduled_for: iso },
      })
      if (error || data?.error) {
        const detail = data?.detail
          ? ' — ' + (typeof data.detail === 'string' ? data.detail : JSON.stringify(data.detail))
          : ''
        setNotice('Saved, but Metricool error: ' + (data?.error || error?.message || 'unknown') + detail)
        setBusy(false)
        return
      }
    }

    setBusy(false); onDone()
  }

  return (
    <>
      <textarea className="input" rows={5} value={body} onChange={(e) => setBody(e.target.value)}
        style={{ marginBottom: 8 }} />
      <div className="field" style={{ marginBottom: 8 }}>
        <label style={{ fontSize: 11, fontWeight: 600, color: 'var(--mist)', display: 'block', marginBottom: 4 }}>
          Scheduled for
        </label>
        <input className="input" type="datetime-local" value={scheduledFor}
          onChange={(e) => setScheduledFor(e.target.value)} disabled={busy} />
      </div>
      {notice && (
        <p style={{ fontSize: 12, color: 'var(--red)', marginBottom: 8 }}>{notice}</p>
      )}
      <div style={{ display: 'flex', gap: 8 }}>
        <button className="btn btn-ghost btn-sm" onClick={onDone} disabled={busy}>Cancel</button>
        <button className="btn btn-primary btn-sm" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save'}</button>
      </div>
    </>
  )
}

/* ---- Calendar tab ---- */
function CalendarTab({ clientId }) {
  const [posts, setPosts] = useState([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    (async () => {
      const from = new Date(); from.setHours(0, 0, 0, 0)
      const to = new Date(from); to.setDate(to.getDate() + 28)
      const { data } = await supabase.from('mkt_content_queue').select('*')
        .eq('client_id', clientId)
        .gte('scheduled_for', from.toISOString())
        .lte('scheduled_for', to.toISOString())
        .order('scheduled_for')
      setPosts(data || []); setLoading(false)
    })()
  }, [clientId])

  if (loading) return <div className="skel" style={{ height: 140, marginTop: 4 }} />
  if (posts.length === 0) return <p className="empty">Nothing scheduled in the next 4 weeks.</p>

  return (
    <div className="card">
      {posts.map((p) => (
        <div key={p.id} className="row" style={{ alignItems: 'flex-start' }}>
          <div style={{ minWidth: 72 }}>
            <div style={{ fontWeight: 700, fontSize: 14 }}>
              {p.scheduled_for ? new Date(p.scheduled_for).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : '—'}
            </div>
            <div className="muted" style={{ fontSize: 12 }}>
              {p.scheduled_for ? new Date(p.scheduled_for).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : ''}
            </div>
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="muted" style={{ fontSize: 12, fontWeight: 600, textTransform: 'capitalize', marginBottom: 3 }}>{p.platform}</div>
            <div style={{ fontSize: 14, lineHeight: 1.4 }}>
              {(p.body?.length || 0) > 120 ? p.body.slice(0, 120) + '…' : p.body}
            </div>
          </div>
          <span className="pill" style={{ background: statusColour(p.status).bg, color: statusColour(p.status).text, flexShrink: 0 }}>
            {p.status}
          </span>
        </div>
      ))}
    </div>
  )
}

/* ---- Notes tab ---- */
function NotesTab({ clientId }) {
  const [note, setNote] = useState('')
  const [noteId, setNoteId] = useState(null)
  const [saved, setSaved] = useState(true)
  const timer = useRef(null)

  useEffect(() => {
    ;(async () => {
      const { data } = await supabase.from('mkt_client_notes').select('*')
        .eq('client_id', clientId).order('created_at', { ascending: false }).limit(1).maybeSingle()
      if (data) { setNote(data.note || ''); setNoteId(data.id) }
    })()
    return () => clearTimeout(timer.current)
  }, [clientId])

  function onChange(val) {
    setNote(val); setSaved(false)
    clearTimeout(timer.current)
    timer.current = setTimeout(async () => {
      if (noteId) {
        await supabase.from('mkt_client_notes').update({ note: val }).eq('id', noteId)
      } else {
        const { data } = await supabase.from('mkt_client_notes')
          .insert({ client_id: clientId, note: val }).select('id').single()
        if (data) setNoteId(data.id)
      }
      setSaved(true)
    }, 1500)
  }

  return (
    <div className="card">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <h2 style={{ fontSize: 15 }}>Notes</h2>
        <span className="muted" style={{ fontSize: 12 }}>{saved ? '● Saved' : '○ Saving…'}</span>
      </div>
      <textarea className="input" rows={14} value={note} onChange={(e) => onChange(e.target.value)}
        placeholder="Strategy notes, key wins, client context…" style={{ resize: 'vertical' }} />
    </div>
  )
}

/* ---- Report tab ---- */
function ReportTab({ reports, clientId, onRefresh }) {
  const [generating, setGenerating] = useState(false)
  const [err, setErr] = useState('')

  async function generate() {
    setGenerating(true); setErr('')
    const now = new Date()
    const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
    const { error } = await supabase.functions.invoke('generate-report', {
      body: { client_id: clientId, month, year: now.getFullYear() },
    })
    setGenerating(false)
    if (error) { setErr('Could not generate — try again.'); return }
    onRefresh()
  }

  return (
    <>
      <div style={{ marginBottom: 16 }}>
        <button className="btn btn-primary btn-sm" onClick={generate} disabled={generating}>
          {generating ? 'Generating…' : 'Generate this month'}
        </button>
      </div>
      {err && <p style={{ color: 'var(--red)', fontSize: 13, marginBottom: 10 }}>{err}</p>}
      {reports.length === 0 ? <p className="empty">No reports yet.</p> : (
        <div className="card">
          {reports.map((r) => (
            <div key={r.id} className="row">
              <div>
                <div style={{ fontWeight: 600 }}>{r.month}</div>
                <div className="muted" style={{ fontSize: 12 }}>
                  {r.posts_published != null ? `${r.posts_published} posts published` : r.status}
                </div>
              </div>
              {r.pdf_url && <a className="btn btn-ghost btn-sm" href={r.pdf_url} target="_blank" rel="noreferrer">PDF</a>}
            </div>
          ))}
        </div>
      )}
    </>
  )
}

/* ---- Settings tab ---- */
function SettingsTab({ client, onSaved }) {
  const [f, setF] = useState({
    tone_of_voice: client.tone_of_voice || '', key_services: client.key_services || '',
    target_customer: client.target_customer || '', traffic_light: client.traffic_light || 'green',
    post_time: client.post_time || '', client_can_approve: !!client.client_can_approve,
  })
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const u = (k) => (e) => setF((p) => ({ ...p, [k]: e.target.value }))

  async function save() {
    setBusy(true); setMsg('')
    const { error } = await supabase.from('mkt_clients').update({
      tone_of_voice: f.tone_of_voice, key_services: f.key_services,
      target_customer: f.target_customer, traffic_light: f.traffic_light,
      post_time: f.post_time || null, client_can_approve: f.client_can_approve,
    }).eq('id', client.id)
    setBusy(false)
    setMsg(error ? 'Something went wrong — try again.' : 'Saved.')
    if (!error) onSaved()
  }

  return (
    <>
      <div className="card">
        <div className="field"><label>Tone of voice</label><textarea className="input" rows={2} value={f.tone_of_voice} onChange={u('tone_of_voice')} /></div>
        <div className="field"><label>Key services</label><textarea className="input" rows={2} value={f.key_services} onChange={u('key_services')} /></div>
        <div className="field"><label>Target customer</label><textarea className="input" rows={2} value={f.target_customer} onChange={u('target_customer')} /></div>
        <div className="grid grid-2">
          <div className="field"><label>Traffic light</label>
            <select className="input" value={f.traffic_light} onChange={u('traffic_light')}>
              <option value="green">Green</option><option value="amber">Amber</option><option value="red">Red</option>
            </select>
          </div>
          <div className="field"><label>Posting time</label><input className="input" type="time" value={f.post_time} onChange={u('post_time')} /></div>
        </div>
        <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 14, marginBottom: 14 }}>
          <input type="checkbox" checked={f.client_can_approve}
            onChange={(e) => setF((p) => ({ ...p, client_can_approve: e.target.checked }))} />
          Let this client approve / reject their own posts in the portal
        </label>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <button className="btn btn-primary" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save changes'}</button>
          {msg && <span className="muted" style={{ fontSize: 13 }}>{msg}</span>}
        </div>
      </div>
      <PortalAccess client={client} />
    </>
  )
}

function PortalAccess({ client }) {
  const [rows, setRows] = useState([])
  const [email, setEmail] = useState(client.contact_email || '')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')

  async function loadRows() {
    const { data } = await supabase.from('mkt_client_portal_access').select('*')
      .eq('client_id', client.id).order('magic_link_sent_at', { ascending: false })
    setRows(data || [])
  }
  useEffect(() => { loadRows() }, [client.id])

  async function invite(addr) {
    const target = (addr || email || '').trim()
    if (!target) return
    setBusy(true); setMsg('')
    const { data, error } = await supabase.functions.invoke('send-portal-invite', {
      body: { client_id: client.id, email: target, client_name: client.name },
    })
    setBusy(false)
    if (error || !data?.ok) { setMsg(data?.error || "Couldn't send the invite — try again."); return }
    setMsg(`Invite sent to ${target}.`); loadRows()
  }

  return (
    <div className="card" style={{ marginTop: 14 }}>
      <h2 style={{ fontSize: 15, marginBottom: 8 }}>Portal access</h2>
      {rows.length === 0 ? (
        <p className="muted" style={{ fontSize: 13 }}>No portal access yet.</p>
      ) : rows.map((r) => (
        <div key={r.id} className="row">
          <div>
            <div style={{ fontWeight: 600 }}>{r.email}</div>
            <div className="muted" style={{ fontSize: 12 }}>
              {r.active ? 'Active' : 'Inactive'} · {r.last_login
                ? `last login ${new Date(r.last_login).toLocaleDateString('en-GB')}`
                : 'never logged in'}
            </div>
          </div>
          <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => invite(r.email)}>Resend</button>
        </div>
      ))}
      <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
        <input className="input" type="email" placeholder="client@email.co.uk" value={email}
          onChange={(e) => setEmail(e.target.value)} />
        <button className="btn btn-primary btn-sm" disabled={busy || !email.trim()} onClick={() => invite()}>
          Send invite
        </button>
      </div>
      {msg && <p className="muted" style={{ fontSize: 13, marginTop: 8 }}>{msg}</p>}
    </div>
  )
}
