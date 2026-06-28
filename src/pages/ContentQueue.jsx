import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import supabase from '../lib/supabase'
import { useAuth } from '../context/AuthContext'

const PLATFORMS = ['facebook', 'instagram', 'google_business', 'blog']

export function ContentQueue() {
  const { user } = useAuth()
  const [searchParams, setSearchParams] = useSearchParams()
  const statusFilter = searchParams.get('status') // 'draft' when coming from dashboard
  const [items, setItems] = useState([])
  const [clients, setClients] = useState([])
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState(null)
  const [draft, setDraft] = useState('')
  const [gen, setGen] = useState({ client_id: '', platform: 'facebook', pillar: '' })
  const [generating, setGenerating] = useState(false)
  const [notice, setNotice] = useState('')

  async function load() {
    setLoading(true)
    const [q, c] = await Promise.all([
      supabase.from('mkt_content_queue').select('*, client:mkt_clients(short_name,name)').order('created_at', { ascending: false }),
      supabase.from('mkt_clients').select('id, name, short_name, content_pillars').eq('active', true).order('name'),
    ])
    setItems(q.data || [])
    setClients(c.data || [])
    if (c.data?.[0] && !gen.client_id) setGen((g) => ({ ...g, client_id: c.data[0].id }))
    setLoading(false)
  }
  useEffect(() => { load() }, [])

  const pending = items.filter((i) => i.status === 'draft')

  async function approve(item) {
    const { error } = await supabase.from('mkt_content_queue')
      .update({ status: 'approved', approved_at: new Date().toISOString(), approved_by: user?.email })
      .eq('id', item.id)
    if (error) { setNotice('Something went wrong — try again.'); return }
    supabase.functions.invoke('schedule-to-metricool', { body: { content_queue_id: item.id } }).catch(() => {})
    setItems((p) => p.map((i) => i.id === item.id ? { ...i, status: 'approved' } : i))
  }
  async function reject(item) {
    const { error } = await supabase.from('mkt_content_queue').update({ status: 'rejected' }).eq('id', item.id)
    if (error) { setNotice('Something went wrong — try again.'); return }
    setItems((p) => p.map((i) => i.id === item.id ? { ...i, status: 'rejected' } : i))
  }
  async function saveEdit(item) {
    const { error } = await supabase.from('mkt_content_queue').update({ body: draft }).eq('id', item.id)
    if (error) { setNotice('Something went wrong — try again.'); return }
    setItems((p) => p.map((i) => i.id === item.id ? { ...i, body: draft } : i))
    setEditing(null)
  }

  async function generate() {
    if (!gen.client_id || !gen.pillar) { setNotice('Pick a client and a pillar first.'); return }
    setGenerating(true); setNotice('')
    const { data, error } = await supabase.functions.invoke('generate-content', {
      body: { client_id: gen.client_id, platform: gen.platform, pillar: gen.pillar },
    })
    setGenerating(false)
    if (error || !data?.item) { setNotice(data?.error || "Couldn't generate that — try again."); return }
    load()
  }

  const pillarsFor = clients.find((c) => c.id === gen.client_id)?.content_pillars || []

  if (loading) return <div className="page"><span className="spinner" /></div>

  // ── Approval queue view (/content?status=pending) ────────────────────────────
  // Flat list of all pending posts across all clients, with one-click approve/reject.
  if (statusFilter === 'draft') {
    return (
      <div className="page">
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 4 }}>
          <h1 style={{ flex: 1 }}>Awaiting approval</h1>
          <button className="btn btn-ghost btn-sm" onClick={() => setSearchParams({})}>
            View all posts
          </button>
        </div>
        <p className="page-sub">
          {pending.length === 0 ? 'Nothing waiting for approval.' : `${pending.length} post${pending.length === 1 ? '' : 's'} waiting for approval across all brands.`}
        </p>
        {notice && <p style={{ color: 'var(--ember)', fontSize: 13, marginTop: 8, marginBottom: 4 }}>{notice}</p>}

        {pending.length === 0 ? (
          <p className="empty" style={{ marginTop: 24 }}>All caught up.</p>
        ) : (
          <div style={{ marginTop: 16 }}>
            {pending.map((item) => (
              <div key={item.id} className="card" style={{ marginBottom: 12 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8, marginBottom: 10 }}>
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 800, marginBottom: 2 }}>
                      {item.client?.short_name || item.client?.name}
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--mist)', textTransform: 'capitalize' }}>
                      {item.platform}{item.pillar ? ` · ${item.pillar}` : ''}
                      {item.scheduled_for && (
                        <span style={{ marginLeft: 8 }}>
                          · {new Date(item.scheduled_for).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })}
                          {' at '}
                          {new Date(item.scheduled_for).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}
                        </span>
                      )}
                    </div>
                  </div>
                  <span className="pill" style={{ background: '#FEF3C7', color: '#92400E', flexShrink: 0 }}>pending</span>
                </div>

                {editing === item.id ? (
                  <>
                    <textarea className="input" rows={4} value={draft} onChange={(e) => setDraft(e.target.value)}
                      style={{ marginBottom: 8 }} />
                    <div style={{ display: 'flex', gap: 8 }}>
                      <button className="btn btn-primary btn-sm" onClick={() => saveEdit(item)}>Save</button>
                      <button className="btn btn-ghost btn-sm" onClick={() => setEditing(null)}>Cancel</button>
                    </div>
                  </>
                ) : (
                  <>
                    <p style={{ fontSize: 14, lineHeight: 1.6, whiteSpace: 'pre-wrap', marginBottom: 12 }}>{item.body}</p>
                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                      <button className="btn btn-primary btn-sm" style={{ flex: 1 }} onClick={() => approve(item)}>
                        Approve &amp; schedule
                      </button>
                      <button className="btn btn-ghost btn-sm" onClick={() => { setEditing(item.id); setDraft(item.body) }}>
                        Edit
                      </button>
                      <button className="btn btn-ghost btn-sm" style={{ color: 'var(--red)' }} onClick={() => reject(item)}>
                        Reject
                      </button>
                    </div>
                  </>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    )
  }

  // ── Full queue view (/content) ───────────────────────────────────────────────
  return (
    <div className="page">
      <h1>Content queue</h1>
      <p className="page-sub">{pending.length === 0 ? 'Nothing waiting for approval.' : `${pending.length} waiting for approval.`}</p>

      <div className="card" style={{ marginTop: 16 }}>
        <h2 style={{ fontSize: 15, marginBottom: 10 }}>Generate a post</h2>
        <div className="grid grid-3">
          <div className="field"><label>Client</label>
            <select className="input" value={gen.client_id} onChange={(e) => setGen((g) => ({ ...g, client_id: e.target.value, pillar: '' }))}>
              {clients.map((c) => <option key={c.id} value={c.id}>{c.short_name || c.name}</option>)}
            </select>
          </div>
          <div className="field"><label>Platform</label>
            <select className="input" value={gen.platform} onChange={(e) => setGen((g) => ({ ...g, platform: e.target.value }))}>
              {PLATFORMS.map((p) => <option key={p} value={p}>{p.replace('_', ' ')}</option>)}
            </select>
          </div>
          <div className="field"><label>Pillar</label>
            <select className="input" value={gen.pillar} onChange={(e) => setGen((g) => ({ ...g, pillar: e.target.value }))}>
              <option value="">Choose…</option>
              {pillarsFor.map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
          </div>
        </div>
        <button className="btn btn-primary" disabled={generating} onClick={generate}>{generating ? 'Writing…' : 'Generate'}</button>
        {notice && <p style={{ color: 'var(--ember)', fontSize: 13, marginTop: 8 }}>{notice}</p>}
      </div>

      <div style={{ marginTop: 18 }}>
        {items.length === 0 ? <p className="empty">Nothing here yet. Generate your first post above.</p> : items.map((item) => (
          <div key={item.id} className="card" style={{ marginBottom: 12 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--mist)', textTransform: 'capitalize' }}>
                {item.client?.short_name || item.client?.name} · {item.platform} · {item.pillar}
              </div>
              <span className="pill" style={{ background: 'var(--chalk)', color: 'var(--steel)' }}>{item.status}</span>
            </div>

            {editing === item.id ? (
              <textarea className="input" rows={4} value={draft} onChange={(e) => setDraft(e.target.value)} />
            ) : (
              <p style={{ fontSize: 14, lineHeight: 1.5, whiteSpace: 'pre-wrap' }}>{item.body}</p>
            )}

            {item.status === 'pending' && (
              <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
                {editing === item.id ? (
                  <>
                    <button className="btn btn-primary btn-sm btn-block" onClick={() => saveEdit(item)}>Save</button>
                    <button className="btn btn-ghost btn-sm btn-block" onClick={() => setEditing(null)}>Cancel</button>
                  </>
                ) : (
                  <>
                    <button className="btn btn-primary btn-sm btn-block" onClick={() => approve(item)}>Approve</button>
                    <button className="btn btn-ghost btn-sm btn-block" onClick={() => { setEditing(item.id); setDraft(item.body) }}>Edit</button>
                    <button className="btn btn-ghost btn-sm btn-block" onClick={() => reject(item)}>Reject</button>
                  </>
                )}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
