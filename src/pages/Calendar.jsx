import { useEffect, useMemo, useState } from 'react'
import supabase from '../lib/supabase'

const PALETTE = ['#E84B35', '#2E4057', '#22C55E', '#F59E0B', '#8FA3B1', '#7E22CE', '#0EA5E9']
const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

function monthGrid(year, month) {
  const first = new Date(year, month, 1)
  const startDow = (first.getDay() + 6) % 7 // Mon=0
  const days = new Date(year, month + 1, 0).getDate()
  const cells = []
  for (let i = 0; i < startDow; i++) cells.push(null)
  for (let d = 1; d <= days; d++) cells.push(new Date(year, month, d))
  while (cells.length % 7) cells.push(null)
  return cells
}

export function Calendar() {
  const [ref, setRef] = useState(() => { const n = new Date(); return { y: n.getFullYear(), m: n.getMonth() } })
  const [posts, setPosts] = useState([])
  const [clients, setClients] = useState([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    (async () => {
      setLoading(true)
      const from = new Date(ref.y, ref.m, 1).toISOString()
      const to = new Date(ref.y, ref.m + 1, 1).toISOString()
      const [s, c] = await Promise.all([
        supabase.from('mkt_scheduled_posts').select('*').gte('scheduled_for', from).lt('scheduled_for', to),
        supabase.from('mkt_clients').select('id, short_name, name').order('name'),
      ])
      // Also include queued items that have a scheduled_for in the month.
      const q = await supabase.from('mkt_content_queue').select('id, client_id, platform, body, scheduled_for')
        .gte('scheduled_for', from).lt('scheduled_for', to).in('status', ['approved', 'scheduled', 'published'])
      setPosts([...(s.data || []), ...(q.data || [])])
      setClients(c.data || [])
      setLoading(false)
    })()
  }, [ref])

  const colourOf = useMemo(() => {
    const map = {}; clients.forEach((c, i) => { map[c.id] = PALETTE[i % PALETTE.length] }); return map
  }, [clients])
  const nameOf = useMemo(() => Object.fromEntries(clients.map((c) => [c.id, c.short_name || c.name])), [clients])

  const cells = monthGrid(ref.y, ref.m)
  const byDay = useMemo(() => {
    const map = {}
    for (const p of posts) {
      if (!p.scheduled_for) continue
      const k = new Date(p.scheduled_for).toDateString()
      ;(map[k] ||= []).push(p)
    }
    return map
  }, [posts])

  const monthName = new Date(ref.y, ref.m, 1).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })
  const move = (d) => setRef((r) => { const n = new Date(r.y, r.m + d, 1); return { y: n.getFullYear(), m: n.getMonth() } })

  return (
    <div className="page">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div><h1>Calendar</h1><p className="page-sub">Scheduled posts, colour-coded by client.</p></div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-ghost btn-sm" onClick={() => move(-1)}>‹</button>
          <button className="btn btn-ghost btn-sm" onClick={() => move(1)}>›</button>
        </div>
      </div>

      <h2 style={{ fontSize: 16, margin: '14px 0 10px' }}>{monthName}</h2>

      {loading ? <span className="spinner" /> : (
        <div className="card" style={{ padding: 10 }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7,1fr)', gap: 4 }}>
            {DOW.map((d) => <div key={d} className="muted" style={{ fontSize: 11, fontWeight: 700, textAlign: 'center', padding: '4px 0' }}>{d}</div>)}
            {cells.map((date, i) => {
              const list = date ? (byDay[date.toDateString()] || []) : []
              const isToday = date && date.toDateString() === new Date().toDateString()
              return (
                <div key={i} style={{ minHeight: 64, border: '1px solid var(--line)', borderRadius: 8, padding: 4, background: date ? 'var(--white)' : 'transparent' }}>
                  {date && <div style={{ fontSize: 11, fontWeight: 700, color: isToday ? 'var(--ember)' : 'var(--mist)' }}>{date.getDate()}</div>}
                  {list.slice(0, 3).map((p, j) => (
                    <div key={j} title={`${nameOf[p.client_id] || ''}: ${p.body || ''}`}
                      style={{ marginTop: 3, fontSize: 10, color: 'var(--white)', background: colourOf[p.client_id] || 'var(--steel)', borderRadius: 4, padding: '2px 4px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {nameOf[p.client_id] || p.platform}
                    </div>
                  ))}
                  {list.length > 3 && <div className="muted" style={{ fontSize: 10, marginTop: 2 }}>+{list.length - 3}</div>}
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
              <span style={{ width: 10, height: 10, borderRadius: 3, background: PALETTE[i % PALETTE.length] }} /> {c.short_name || c.name}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}
