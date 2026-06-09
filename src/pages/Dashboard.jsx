import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import supabase from '../lib/supabase'

const today = () => new Date().toISOString().split('T')[0]

export function Dashboard() {
  const navigate = useNavigate()
  const [loading, setLoading] = useState(true)
  const [clients, setClients] = useState([])
  const [tasks, setTasks] = useState([])
  const [pending, setPending] = useState(0)
  const [reach, setReach] = useState(0)

  useEffect(() => {
    (async () => {
      const [c, t, q, p] = await Promise.all([
        supabase.from('mkt_clients').select('*').eq('active', true).order('name'),
        supabase.from('mkt_tasks').select('*, client:mkt_clients(short_name,name)').eq('completed', false).order('due_date'),
        supabase.from('mkt_content_queue').select('id', { count: 'exact', head: true }).eq('status', 'pending'),
        supabase.from('mkt_performance').select('client_id, week_start, reach').order('week_start', { ascending: false }),
      ])
      setClients(c.data || [])
      setTasks(t.data || [])
      setPending(q.count || 0)
      // latest reach per client, summed
      const seen = new Set(); let sum = 0
      for (const row of p.data || []) { if (!seen.has(row.client_id)) { seen.add(row.client_id); sum += row.reach || 0 } }
      setReach(sum)
      setLoading(false)
    })()
  }, [])

  const dueToday = tasks.filter((t) => !t.due_date || t.due_date <= today())
  const greeting = new Date().getHours() < 12 ? 'Good morning' : new Date().getHours() < 18 ? 'Good afternoon' : 'Good evening'

  if (loading) return <div className="page"><span className="spinner" /></div>

  return (
    <div className="page">
      <h1>{greeting}.</h1>
      <p className="page-sub">Here's your day.</p>

      <div className="grid grid-4" style={{ marginTop: 18 }}>
        <Stat label="Active clients" value={clients.length} />
        <Stat label="Posts to approve" value={pending} accent={pending > 0} />
        <Stat label="Tasks due today" value={dueToday.length} accent={dueToday.some((t) => t.overdue)} />
        <Stat label="Reach this week" value={reach.toLocaleString('en-GB')} />
      </div>

      <div className="grid grid-2" style={{ marginTop: 18, alignItems: 'start' }}>
        <div className="card">
          <h2 style={{ fontSize: 16, marginBottom: 6 }}>Today's tasks</h2>
          {dueToday.length === 0 ? (
            <p className="empty">Nothing due today. Nice.</p>
          ) : dueToday.map((t) => (
            <div key={t.id} className="row" onClick={() => navigate(`/clients/${t.client_id}`)} style={{ cursor: 'pointer' }}>
              <div>
                <div style={{ fontWeight: 600 }}>{t.task}</div>
                <div className="muted" style={{ fontSize: 12 }}>{t.client?.short_name || t.client?.name}</div>
              </div>
              {t.overdue
                ? <span className="pill" style={{ background: '#FEE2E2', color: 'var(--red)' }}>Overdue</span>
                : <span className="muted" style={{ fontSize: 12 }}>Today</span>}
            </div>
          ))}
        </div>

        <div className="card">
          <h2 style={{ fontSize: 16, marginBottom: 6 }}>Client status</h2>
          {clients.length === 0 ? (
            <p className="empty">No clients yet. Add your first in Clients.</p>
          ) : clients.map((c) => (
            <div key={c.id} className="row" onClick={() => navigate(`/clients/${c.id}`)} style={{ cursor: 'pointer' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
                <span className={'dot dot-' + (c.traffic_light || 'green')} />
                <div>
                  <div style={{ fontWeight: 600 }}>{c.short_name || c.name}</div>
                  <div className="muted" style={{ fontSize: 12 }}>{c.next_task || 'All on track'}</div>
                </div>
              </div>
              <span className="muted" style={{ fontSize: 12 }}>{c.google_rating ? `★ ${c.google_rating}` : ''}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

function Stat({ label, value, accent }) {
  return (
    <div className="card stat">
      <div className="label">{label}</div>
      <div className="value" style={{ color: accent ? 'var(--ember)' : 'var(--ink)' }}>{value}</div>
    </div>
  )
}
