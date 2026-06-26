import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import supabase from '../lib/supabase'
import { GeneratePostModal } from '../components/GeneratePostModal'

function greetingWord() {
  const h = new Date().getHours()
  return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening'
}
function todayLabel() {
  return new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })
}

const CLIENT_ORDER = ['yca', 'ps', 'ouay', 'hormonely']

export function Dashboard() {
  const navigate = useNavigate()
  const [loading, setLoading] = useState(true)
  const [clients, setClients] = useState([])
  const [postsByClient, setPostsByClient] = useState({})
  const [postsToday, setPostsToday] = useState(0)
  const [tasksDue, setTasksDue] = useState(0)
  const [awaitingApproval, setAwaitingApproval] = useState(0)
  const [genClient, setGenClient] = useState(null)

  async function load() {
    setLoading(true)
    const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0)
    const todayEnd = new Date(); todayEnd.setHours(23, 59, 59, 999)
    const todayStr = new Date().toISOString().split('T')[0]

    const [c, tasks, approval, today] = await Promise.all([
      supabase.from('mkt_clients').select('*').eq('active', true).order('name'),
      supabase.from('mkt_tasks').select('id', { count: 'exact', head: true })
        .eq('completed', false).lte('due_date', todayStr),
      supabase.from('mkt_content_queue').select('id', { count: 'exact', head: true })
        .in('status', ['draft', 'pending']),
      supabase.from('mkt_content_queue')
        .select('client_id, body, status, platform')
        .gte('scheduled_for', todayStart.toISOString())
        .lte('scheduled_for', todayEnd.toISOString()),
    ])

    const byClient = {}
    for (const p of today.data || []) {
      if (!byClient[p.client_id]) byClient[p.client_id] = p
    }

    setClients(c.data || [])
    setPostsByClient(byClient)
    setPostsToday((today.data || []).length)
    setTasksDue(tasks.count || 0)
    setAwaitingApproval(approval.count || 0)
    setLoading(false)
  }

  useEffect(() => { load() }, [])

  const sorted = [...clients].sort((a, b) => {
    const ai = CLIENT_ORDER.indexOf(a.slug)
    const bi = CLIENT_ORDER.indexOf(b.slug)
    if (ai !== -1 && bi !== -1) return ai - bi
    if (ai !== -1) return -1
    if (bi !== -1) return 1
    return (a.name || '').localeCompare(b.name || '')
  })

  if (loading) return (
    <div className="page">
      <div className="skel" style={{ height: 34, width: 200, marginBottom: 8 }} />
      <div className="skel" style={{ height: 16, width: 160, marginBottom: 22 }} />
      <div className="grid grid-3" style={{ marginBottom: 20 }}>
        {[1, 2, 3].map((i) => <div key={i} className="card"><div className="skel" style={{ height: 56 }} /></div>)}
      </div>
      <div className="cards-swipe">
        {[1, 2, 3, 4].map((i) => <div key={i} className="card"><div className="skel" style={{ height: 140 }} /></div>)}
      </div>
    </div>
  )

  return (
    <div className="page">
      <h1 style={{ fontSize: 28 }}>{greetingWord()}.</h1>
      <p className="page-sub" style={{ marginBottom: 22 }}>{todayLabel()}</p>

      <div className="grid grid-3" style={{ marginBottom: 20 }}>
        <StatPill label="Posts today" value={postsToday} accent={postsToday > 0} />
        <StatPill label="Tasks due" value={tasksDue} accent={tasksDue > 0} />
        <StatPill label="Awaiting approval" value={awaitingApproval} accent={awaitingApproval > 0} />
      </div>

      <div className="cards-swipe">
        {sorted.map((c) => {
          const accent = c.brand_primary_color || 'var(--ember)'
          const post = postsByClient[c.id]
          const to = `/clients/${c.slug || c.id}`
          return (
            <div key={c.id} className="card" style={{ borderLeft: `4px solid ${accent}`, padding: '16px 18px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                <span className={'dot dot-' + (c.traffic_light || 'green')} />
                <span style={{ fontWeight: 800, fontSize: 15, flex: 1 }}>{c.short_name || c.name}</span>
                {c.tier && <span className="tier" style={{ fontSize: 10 }}>{c.tier}</span>}
              </div>
              <p style={{ fontSize: 13, lineHeight: 1.5, marginBottom: 14, minHeight: 48, color: post ? 'var(--ink)' : 'var(--mist)' }}>
                {post
                  ? (post.body?.length > 130 ? post.body.slice(0, 130) + '…' : post.body)
                  : 'No post scheduled today.'}
              </p>
              <div style={{ display: 'flex', gap: 8 }}>
                <button className="btn btn-primary btn-sm" style={{ flex: 1 }} onClick={() => setGenClient(c)}>
                  Generate post
                </button>
                <button className="btn btn-ghost btn-sm" onClick={() => navigate(to)}>View</button>
              </div>
            </div>
          )
        })}
      </div>

      {genClient && (
        <GeneratePostModal client={genClient} onClose={() => setGenClient(null)} onDone={load} />
      )}
    </div>
  )
}

function StatPill({ label, value, accent }) {
  return (
    <div className="card" style={{ textAlign: 'center', padding: '14px 16px' }}>
      <div style={{ fontSize: 30, fontWeight: 800, letterSpacing: '-0.03em', color: accent ? 'var(--ember)' : 'var(--ink)' }}>
        {value}
      </div>
      <div className="muted" style={{ fontSize: 13, fontWeight: 600, marginTop: 3 }}>{label}</div>
    </div>
  )
}
