import { useEffect, useMemo, useState } from 'react'
import supabase from '../lib/supabase'

const PALETTE = ['#E84B35', '#2E4057', '#22C55E', '#F59E0B', '#8FA3B1', '#7E22CE', '#0EA5E9']
const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

function monthGrid(year, month) {
  const first = new Date(year, month, 1)
  const startDow = (first.getDay() + 6) % 7
  const days = new Date(year, month + 1, 0).getDate()
  const cells = []
  for (let i = 0; i < startDow; i++) cells.push(null)
  for (let d = 1; d <= days; d++) cells.push(new Date(year, month, d))
  while (cells.length % 7) cells.push(null)
  return cells
}

function getMonday(date) {
  const d = new Date(date)
  const diff = d.getDay() === 0 ? -6 : 1 - d.getDay()
  d.setDate(d.getDate() + diff)
  d.setHours(0, 0, 0, 0)
  return d
}

export function Calendar() {
  const [view, setView] = useState('month')
  const [ref, setRef] = useState(() => { const n = new Date(); return { y: n.getFullYear(), m: n.getMonth() } })
  const [weekStart, setWeekStart] = useState(() => getMonday(new Date()))
  const [posts, setPosts] = useState([])
  const [clients, setClients] = useState([])
  const [loading, setLoading] = useState(true)
  const [reloadKey, setReloadKey] = useState(0)
  const [viewPost, setViewPost] = useState(null)
  const [addDate, setAddDate] = useState(null)

  useEffect(() => {
    (async () => {
      setLoading(true)
      let from, to
      if (view === 'month') {
        from = new Date(ref.y, ref.m, 1).toISOString()
        to   = new Date(ref.y, ref.m + 1, 1).toISOString()
      } else {
        from = weekStart.toISOString()
        const end = new Date(weekStart); end.setDate(end.getDate() + 7)
        to = end.toISOString()
      }

      const [s, c, q] = await Promise.all([
        supabase.from('mkt_scheduled_posts').select('*').gte('scheduled_for', from).lt('scheduled_for', to),
        supabase.from('mkt_clients').select('id, short_name, name, slug').order('name'),
        supabase.from('mkt_content_queue')
          .select('id, client_id, platform, pillar, body, scheduled_for, status')
          .gte('scheduled_for', from).lt('scheduled_for', to)
          .in('status', ['draft', 'pending', 'approved', 'scheduled', 'published']),
      ])

      // Merge, deduplicate by id
      const seen = new Set()
      const merged = []
      for (const p of [...(s.data || []), ...(q.data || [])]) {
        if (!seen.has(p.id)) { seen.add(p.id); merged.push(p) }
      }

      setPosts(merged); setClients(c.data || []); setLoading(false)
    })()
  }, [ref.y, ref.m, view, weekStart, reloadKey])

  const colourOf = useMemo(() => {
    const map = {}; clients.forEach((c, i) => { map[c.id] = PALETTE[i % PALETTE.length] }); return map
  }, [clients])

  const nameOf = useMemo(
    () => Object.fromEntries(clients.map((c) => [c.id, c.short_name || c.name])),
    [clients]
  )

  const byDay = useMemo(() => {
    const map = {}
    for (const p of posts) {
      if (!p.scheduled_for) continue
      const k = new Date(p.scheduled_for).toDateString()
      ;(map[k] ||= []).push(p)
    }
    return map
  }, [posts])

  const moveMonth = (d) => setRef((r) => { const n = new Date(r.y, r.m + d, 1); return { y: n.getFullYear(), m: n.getMonth() } })
  const moveWeek  = (d) => setWeekStart((s) => { const n = new Date(s); n.setDate(n.getDate() + d * 7); return n })

  const monthName = new Date(ref.y, ref.m, 1).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })
  const weekDays  = Array.from({ length: 7 }, (_, i) => { const d = new Date(weekStart); d.setDate(d.getDate() + i); return d })
  const weekLabel = `${weekDays[0].toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} – ${weekDays[6].toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}`
  const cells = monthGrid(ref.y, ref.m)

  return (
    <div className="page">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <div>
          <h1>Calendar</h1>
          <p className="page-sub">Colour-coded by client. Click a post to read it, a date to add one.</p>
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          <div style={{ display: 'flex', border: '1px solid var(--line)', borderRadius: 10, overflow: 'hidden' }}>
            <button className={'btn btn-sm ' + (view === 'month' ? 'btn-dark' : 'btn-ghost')}
              style={{ borderRadius: 0 }} onClick={() => setView('month')}>Month</button>
            <button className={'btn btn-sm ' + (view === 'week' ? 'btn-dark' : 'btn-ghost')}
              style={{ borderRadius: 0 }} onClick={() => setView('week')}>Week</button>
          </div>
          <button className="btn btn-ghost btn-sm" onClick={() => view === 'month' ? moveMonth(-1) : moveWeek(-1)}>‹</button>
          <button className="btn btn-ghost btn-sm" onClick={() => view === 'month' ? moveMonth(1) : moveWeek(1)}>›</button>
        </div>
      </div>

      <h2 style={{ fontSize: 16, margin: '14px 0 10px' }}>{view === 'month' ? monthName : weekLabel}</h2>

      {loading ? (
        <div className="skel" style={{ height: 320, borderRadius: 14 }} />
      ) : view === 'month' ? (
        <div className="card" style={{ padding: 10 }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7,1fr)', gap: 4 }}>
            {DOW.map((d) => (
              <div key={d} className="muted" style={{ fontSize: 11, fontWeight: 700, textAlign: 'center', padding: '4px 0' }}>{d}</div>
            ))}
            {cells.map((date, i) => {
              const list = date ? (byDay[date.toDateString()] || []) : []
              const isToday = date && date.toDateString() === new Date().toDateString()
              return (
                <div key={i}
                  style={{ minHeight: 64, border: '1px solid var(--line)', borderRadius: 8, padding: 4, background: date ? 'var(--white)' : 'transparent', cursor: date ? 'pointer' : 'default' }}
                  onClick={() => date && setAddDate(date)}>
                  {date && (
                    <div style={{ fontSize: 11, fontWeight: 700, color: isToday ? 'var(--ember)' : 'var(--mist)' }}>{date.getDate()}</div>
                  )}
                  {list.slice(0, 3).map((p, j) => (
                    <div key={j}
                      onClick={(e) => { e.stopPropagation(); setViewPost(p) }}
                      title={`${nameOf[p.client_id] || ''}: ${p.body || ''}`}
                      style={{ marginTop: 3, fontSize: 10, color: 'var(--white)', background: colourOf[p.client_id] || 'var(--steel)', borderRadius: 4, padding: '2px 4px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', cursor: 'pointer' }}>
                      {nameOf[p.client_id] || p.platform}
                    </div>
                  ))}
                  {list.length > 3 && <div className="muted" style={{ fontSize: 10, marginTop: 2 }}>+{list.length - 3}</div>}
                </div>
              )
            })}
          </div>
        </div>
      ) : (
        <div className="card" style={{ padding: 10, overflowX: 'auto' }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, minmax(120px, 1fr))', gap: 4, minWidth: 740 }}>
            {weekDays.map((date, i) => {
              const isToday = date.toDateString() === new Date().toDateString()
              const list = byDay[date.toDateString()] || []
              return (
                <div key={i}>
                  <div style={{ fontSize: 12, fontWeight: 700, textAlign: 'center', padding: '4px 2px', color: isToday ? 'var(--ember)' : 'var(--mist)' }}>
                    {DOW[i]} <span style={{ fontWeight: isToday ? 800 : 400 }}>{date.getDate()}</span>
                  </div>
                  <div style={{ border: '1px solid var(--line)', borderRadius: 8, minHeight: 110, padding: 4, cursor: 'pointer' }}
                    onClick={() => setAddDate(date)}>
                    {list.map((p, j) => (
                      <div key={j}
                        onClick={(e) => { e.stopPropagation(); setViewPost(p) }}
                        style={{ marginTop: 4, fontSize: 11, color: 'var(--white)', background: colourOf[p.client_id] || 'var(--steel)', borderRadius: 5, padding: '3px 6px', lineHeight: 1.3, cursor: 'pointer' }}>
                        <div style={{ fontWeight: 700 }}>{nameOf[p.client_id] || p.platform}</div>
                        <div style={{ opacity: 0.85, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {p.body?.slice(0, 40)}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {clients.length > 0 && (
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginTop: 12 }}>
          {clients.map((c, i) => (
            <span key={c.id} style={{ fontSize: 12, display: 'flex', alignItems: 'center', gap: 5 }}>
              <span style={{ width: 10, height: 10, borderRadius: 3, background: PALETTE[i % PALETTE.length] }} />
              {c.short_name || c.name}
            </span>
          ))}
        </div>
      )}

      {/* Post action sheet — View / Edit / Delete */}
      {viewPost && (
        <PostActionModal
          post={viewPost}
          nameOf={nameOf}
          onClose={() => setViewPost(null)}
          onChanged={() => { setViewPost(null); setReloadKey((k) => k + 1) }}
        />
      )}

      {/* Add post modal */}
      {addDate && (
        <AddPostModal
          date={addDate}
          clients={clients}
          onClose={() => setAddDate(null)}
          onSaved={() => { setAddDate(null); setReloadKey((k) => k + 1) }}
        />
      )}
    </div>
  )
}

// Fix 3 — tapping a post on the calendar opens this on any device (including
// iPhone). It offers View, Edit and Delete. Delete removes the post from
// mkt_content_queue and cancels it in Metricool if it was already scheduled
// there (via the delete-post edge function). Edit updates the body and, if the
// post is already scheduled in Metricool, re-syncs it there.
function PostActionModal({ post, nameOf, onClose, onChanged }) {
  // A calendar chip can come from mkt_scheduled_posts (carries content_queue_id)
  // or straight from mkt_content_queue (its own id IS the queue id).
  const contentQueueId = post.content_queue_id || post.id
  const isScheduled = post.status === 'scheduled' || Boolean(post.metricool_post_id)

  const [mode, setMode] = useState('menu') // menu | view | edit
  const [body, setBody] = useState(post.body || '')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  const when = post.scheduled_for
    ? `${new Date(post.scheduled_for).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })} at ${new Date(post.scheduled_for).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`
    : ''

  async function saveEdit() {
    if (!body.trim()) return
    setBusy(true); setErr('')
    const { error } = await supabase.from('mkt_content_queue').update({ body: body.trim() }).eq('id', contentQueueId)
    if (error) { setBusy(false); setErr('Could not save — try again.'); return }
    // If it is already scheduled in Metricool, push the new text through so the
    // scheduled post matches. schedule-to-metricool PATCHes when a Metricool
    // post id already exists.
    if (isScheduled) {
      try { await supabase.functions.invoke('schedule-to-metricool', { body: { content_queue_id: contentQueueId } }) }
      catch { /* the DB edit still saved; a Metricool sync failure is non-fatal here */ }
    }
    setBusy(false)
    onChanged()
  }

  async function doDelete() {
    if (!window.confirm('Delete this post? If it is already scheduled it will also be cancelled in Metricool. This cannot be undone.')) return
    setBusy(true); setErr('')
    const { data, error } = await supabase.functions.invoke('delete-post', { body: { content_queue_id: contentQueueId } })
    setBusy(false)
    if (error || data?.error) { setErr(data?.error || 'Could not delete — try again.'); return }
    onChanged()
  }

  return (
    <div className="modal-bg" onClick={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="modal">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 12 }}>
          <div>
            <div style={{ fontWeight: 800, fontSize: 16 }}>{nameOf[post.client_id] || 'Post'}</div>
            <div className="muted" style={{ fontSize: 12, textTransform: 'capitalize', marginTop: 3 }}>
              {post.platform}{when && ` · ${when}`}{isScheduled ? ' · scheduled' : ''}
            </div>
          </div>
          <button className="btn btn-ghost btn-sm" onClick={onClose}>Close</button>
        </div>

        {mode === 'menu' && (
          <>
            <div style={{ whiteSpace: 'pre-wrap', fontSize: 13, lineHeight: 1.5, color: 'var(--mist)', maxHeight: 96, overflow: 'hidden', marginBottom: 14 }}>
              {(post.body || '').slice(0, 160)}{(post.body || '').length > 160 ? '…' : ''}
            </div>
            {err && <p style={{ color: 'var(--red)', fontSize: 13, marginBottom: 10 }}>{err}</p>}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <button className="btn btn-dark btn-block" onClick={() => setMode('view')}>View</button>
              <button className="btn btn-primary btn-block" onClick={() => setMode('edit')}>Edit</button>
              <button className="btn btn-block" style={{ background: 'var(--red, #DC2626)', color: '#fff' }} disabled={busy} onClick={doDelete}>
                {busy ? 'Deleting…' : 'Delete'}
              </button>
            </div>
          </>
        )}

        {mode === 'view' && (
          <>
            <div style={{ whiteSpace: 'pre-wrap', fontSize: 14, lineHeight: 1.6, marginBottom: 14 }}>{post.body}</div>
            <button className="btn btn-ghost btn-block" onClick={() => setMode('menu')}>Back</button>
          </>
        )}

        {mode === 'edit' && (
          <>
            <div className="field">
              <label>Post body</label>
              <textarea className="input" rows={7} value={body} onChange={(e) => setBody(e.target.value)} />
            </div>
            {err && <p style={{ color: 'var(--red)', fontSize: 13, marginBottom: 8 }}>{err}</p>}
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn btn-ghost" disabled={busy} onClick={() => setMode('menu')}>Back</button>
              <button className="btn btn-primary btn-block" disabled={busy || !body.trim()} onClick={saveEdit}>
                {busy ? 'Saving…' : 'Save changes'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

function AddPostModal({ date, clients, onClose, onSaved }) {
  const [clientId, setClientId] = useState(clients[0]?.id || '')
  const [platform, setPlatform] = useState('facebook')
  const [body, setBody] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  async function save() {
    if (!body.trim() || !clientId) return
    setBusy(true); setErr('')
    const { error } = await supabase.from('mkt_content_queue').insert({
      client_id: clientId, platform, body: body.trim(),
      status: 'draft', scheduled_for: date.toISOString(), pillar: 'General',
    })
    setBusy(false)
    if (error) { setErr('Could not save — try again.'); return }
    onSaved()
  }

  return (
    <div className="modal-bg" onClick={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="modal">
        <h2 style={{ fontSize: 18, marginBottom: 4 }}>Add post</h2>
        <p className="muted" style={{ fontSize: 13, marginBottom: 14 }}>
          {date.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })}
        </p>
        <div className="grid grid-2">
          <div className="field">
            <label>Client</label>
            <select className="input" value={clientId} onChange={(e) => setClientId(e.target.value)}>
              {clients.map((c) => <option key={c.id} value={c.id}>{c.short_name || c.name}</option>)}
            </select>
          </div>
          <div className="field">
            <label>Platform</label>
            <select className="input" value={platform} onChange={(e) => setPlatform(e.target.value)}>
              <option value="facebook">Facebook</option>
              <option value="linkedin">LinkedIn</option>
              <option value="instagram">Instagram</option>
            </select>
          </div>
        </div>
        <div className="field">
          <label>Post body</label>
          <textarea className="input" rows={5} value={body} onChange={(e) => setBody(e.target.value)}
            placeholder="Write the post…" />
        </div>
        {err && <p style={{ color: 'var(--red)', fontSize: 13, marginBottom: 8 }}>{err}</p>}
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary btn-block" disabled={busy || !body.trim() || !clientId} onClick={save}>
            {busy ? 'Saving…' : 'Add draft'}
          </button>
        </div>
      </div>
    </div>
  )
}
