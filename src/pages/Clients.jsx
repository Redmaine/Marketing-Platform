import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import supabase from '../lib/supabase'

export function Clients() {
  const navigate = useNavigate()
  const [clients, setClients] = useState([])
  const [reachById, setReachById] = useState({})
  const [loading, setLoading] = useState(true)
  const [adding, setAdding] = useState(false)

  async function load() {
    setLoading(true)
    const [c, p] = await Promise.all([
      supabase.from('mkt_clients').select('*').order('name'),
      supabase.from('mkt_performance').select('client_id, week_start, reach').order('week_start', { ascending: false }),
    ])
    setClients(c.data || [])
    const seen = {}; const map = {}
    for (const r of p.data || []) { if (!(r.client_id in seen)) { seen[r.client_id] = 1; map[r.client_id] = r.reach || 0 } }
    setReachById(map)
    setLoading(false)
  }
  useEffect(() => { load() }, [])

  if (loading) return <div className="page"><span className="spinner" /></div>

  return (
    <div className="page">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
        <div><h1>Clients</h1><p className="page-sub">{clients.length} on the books.</p></div>
        <button className="btn btn-primary btn-sm" onClick={() => setAdding(true)}>+ Add client</button>
      </div>

      {clients.length === 0 ? (
        <p className="empty">No clients yet. Add your first.</p>
      ) : (
        <div className="grid grid-3" style={{ marginTop: 18 }}>
          {clients.map((c) => (
            <button key={c.id} className="card" onClick={() => navigate(`/clients/${c.id}`)}
              style={{ textAlign: 'left', border: '1px solid var(--line)', display: 'block' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                <span className={'dot dot-' + (c.traffic_light || 'green')} />
                {c.tier && <span className="tier">{c.tier}</span>}
              </div>
              <div style={{ fontWeight: 800, fontSize: 16 }}>{c.short_name || c.name}</div>
              <div className="muted" style={{ fontSize: 12, marginBottom: 12 }}>{c.location || c.industry || '—'}</div>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
                <span className="muted">Reach</span><strong>{(reachById[c.id] || 0).toLocaleString('en-GB')}</strong>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, marginTop: 4 }}>
                <span className="muted">Rating</span><strong>{c.google_rating ? `★ ${c.google_rating}` : '—'}</strong>
              </div>
              {c.next_task && <div style={{ marginTop: 12, fontSize: 12, color: 'var(--ember)', fontWeight: 600 }}>{c.next_task}</div>}
            </button>
          ))}
        </div>
      )}

      {adding && <AddClient onClose={() => setAdding(false)} onSaved={() => { setAdding(false); load() }} />}
    </div>
  )
}

function AddClient({ onClose, onSaved }) {
  const [f, setF] = useState({ name: '', website: '', industry: '', location: '', tier: 'visibility', contact_email: '' })
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const u = (k) => (e) => setF((p) => ({ ...p, [k]: e.target.value }))

  async function save() {
    if (!f.name.trim()) return
    setBusy(true); setErr('')
    const { error } = await supabase.from('mkt_clients').insert({
      name: f.name.trim(), short_name: f.name.trim(), website: f.website || null, industry: f.industry || null,
      location: f.location || null, tier: f.tier, contact_email: f.contact_email || null,
      traffic_light: 'green', active: true,
    })
    setBusy(false)
    if (error) { setErr('Something went wrong — try again.'); return }
    onSaved()
  }

  return (
    <div className="modal-bg" onClick={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="modal">
        <h2 style={{ fontSize: 18, marginBottom: 14 }}>Add a client</h2>
        <div className="field"><label>Name</label><input className="input" value={f.name} onChange={u('name')} placeholder="Acme Plumbing" /></div>
        <div className="field"><label>Website</label><input className="input" value={f.website} onChange={u('website')} placeholder="https://…" /></div>
        <div className="grid grid-2">
          <div className="field"><label>Industry</label><input className="input" value={f.industry} onChange={u('industry')} /></div>
          <div className="field"><label>Location</label><input className="input" value={f.location} onChange={u('location')} /></div>
        </div>
        <div className="grid grid-2">
          <div className="field"><label>Tier</label>
            <select className="input" value={f.tier} onChange={u('tier')}>
              <option value="visibility">Visibility</option><option value="growth">Growth</option><option value="accelerate">Accelerate</option>
            </select>
          </div>
          <div className="field"><label>Contact email</label><input className="input" type="email" value={f.contact_email} onChange={u('contact_email')} /></div>
        </div>
        {err && <p style={{ color: 'var(--red)', fontSize: 13 }}>{err}</p>}
        <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary btn-block" disabled={busy || !f.name.trim()} onClick={save}>{busy ? 'Saving…' : 'Add client'}</button>
        </div>
      </div>
    </div>
  )
}
