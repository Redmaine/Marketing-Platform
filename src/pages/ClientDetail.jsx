import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import supabase from '../lib/supabase'

const TABS = ['overview', 'content', 'performance', 'reports', 'settings']

export function ClientDetail() {
  const { id } = useParams()
  const [tab, setTab] = useState('overview')
  const [client, setClient] = useState(null)
  const [content, setContent] = useState([])
  const [perf, setPerf] = useState([])
  const [reports, setReports] = useState([])
  const [loading, setLoading] = useState(true)

  async function load() {
    setLoading(true)
    const [c, q, p, r] = await Promise.all([
      supabase.from('mkt_clients').select('*').eq('id', id).maybeSingle(),
      supabase.from('mkt_content_queue').select('*').eq('client_id', id).order('created_at', { ascending: false }),
      supabase.from('mkt_performance').select('*').eq('client_id', id).order('week_start'),
      supabase.from('mkt_reports').select('*').eq('client_id', id).order('created_at', { ascending: false }),
    ])
    setClient(c.data); setContent(q.data || []); setPerf(p.data || []); setReports(r.data || [])
    setLoading(false)
  }
  useEffect(() => { load() }, [id])

  if (loading) return <div className="page"><span className="spinner" /></div>
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
          <button key={t} className={'tab' + (tab === t ? ' active' : '')} onClick={() => setTab(t)} style={{ textTransform: 'capitalize' }}>{t}</button>
        ))}
      </div>

      {tab === 'overview' && <Overview client={client} />}
      {tab === 'content' && <ContentTab content={content} />}
      {tab === 'performance' && <PerformanceTab perf={perf} client={client} />}
      {tab === 'reports' && <ReportsTab reports={reports} />}
      {tab === 'settings' && <SettingsTab client={client} onSaved={load} />}
    </div>
  )
}

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
        <KV k="Posting days" v={(client.post_days || []).join(', ')} />
        <KV k="Posting time" v={client.post_time} />
        <KV k="Rating" v={client.google_rating ? `★ ${client.google_rating} (${client.review_count || 0})` : null} />
      </div>
      <div className="card">
        <h2 style={{ fontSize: 15, marginBottom: 8 }}>Brand & strategy</h2>
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

function ContentTab({ content }) {
  if (content.length === 0) return <p className="empty">Nothing in the queue for this client.</p>
  return (
    <div className="card">
      {content.map((c) => (
        <div key={c.id} className="row" style={{ alignItems: 'flex-start' }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--mist)', textTransform: 'capitalize' }}>{c.platform} · {c.pillar}</div>
            <div style={{ fontSize: 14, marginTop: 3 }}>{c.body}</div>
          </div>
          <span className="pill" style={{ background: 'var(--chalk)', color: 'var(--steel)' }}>{c.status}</span>
        </div>
      ))}
    </div>
  )
}

function PerformanceTab({ perf, client }) {
  if (perf.length === 0) return <p className="empty">No performance data yet.</p>
  const max = Math.max(1, ...perf.map((p) => p.reach || 0))
  return (
    <div className="card">
      <h2 style={{ fontSize: 15, marginBottom: 12 }}>Reach by week</h2>
      <div className="bars">
        {perf.map((p) => (
          <div key={p.id} className="b">
            <div className="bar" style={{ height: `${((p.reach || 0) / max) * 130}px` }} />
            <span className="blabel">{new Date(p.week_start).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}</span>
          </div>
        ))}
      </div>
      <div className="grid grid-3" style={{ marginTop: 16 }}>
        <Stat k="Avg rating" v={client.google_rating ? `★ ${client.google_rating}` : '—'} />
        <Stat k="Posts (latest wk)" v={perf[perf.length - 1]?.posts_published ?? 0} />
        <Stat k="Engagement (latest)" v={perf[perf.length - 1]?.engagement ?? 0} />
      </div>
    </div>
  )
}
function Stat({ k, v }) { return <div style={{ textAlign: 'center' }}><div style={{ fontWeight: 800, fontSize: 18 }}>{v}</div><div className="muted" style={{ fontSize: 12 }}>{k}</div></div> }

function ReportsTab({ reports }) {
  if (reports.length === 0) return <p className="empty">No reports yet. Generate one from Reports.</p>
  return (
    <div className="card">
      {reports.map((r) => (
        <div key={r.id} className="row">
          <div><div style={{ fontWeight: 600 }}>{r.month}</div><div className="muted" style={{ fontSize: 12 }}>{r.status}</div></div>
          {r.pdf_url ? <a className="btn btn-ghost btn-sm" href={r.pdf_url} target="_blank" rel="noreferrer">PDF</a> : <span className="muted" style={{ fontSize: 12 }}>No PDF yet</span>}
        </div>
      ))}
    </div>
  )
}

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
      tone_of_voice: f.tone_of_voice, key_services: f.key_services, target_customer: f.target_customer,
      traffic_light: f.traffic_light, post_time: f.post_time || null, client_can_approve: f.client_can_approve,
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
        <input type="checkbox" checked={f.client_can_approve} onChange={(e) => setF((p) => ({ ...p, client_can_approve: e.target.checked }))} />
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

  async function load() {
    const { data } = await supabase.from('mkt_client_portal_access').select('*')
      .eq('client_id', client.id).order('magic_link_sent_at', { ascending: false })
    setRows(data || [])
  }
  useEffect(() => { load() }, [client.id])

  async function invite(addr) {
    const target = (addr || email || '').trim()
    if (!target) return
    setBusy(true); setMsg('')
    const { data, error } = await supabase.functions.invoke('send-portal-invite', {
      body: { client_id: client.id, email: target, client_name: client.name },
    })
    setBusy(false)
    if (error || !data?.ok) { setMsg(data?.error || "Couldn't send the invite — try again."); return }
    setMsg(`Invite sent to ${target}.`)
    load()
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
              {r.active ? 'Active' : 'Inactive'} · {r.last_login ? `last login ${new Date(r.last_login).toLocaleDateString('en-GB')}` : 'never logged in'}
            </div>
          </div>
          <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => invite(r.email)}>Resend</button>
        </div>
      ))}
      <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
        <input className="input" type="email" placeholder="client@email.co.uk" value={email} onChange={(e) => setEmail(e.target.value)} />
        <button className="btn btn-primary btn-sm" disabled={busy || !email.trim()} onClick={() => invite()}>Send invite</button>
      </div>
      {msg && <p className="muted" style={{ fontSize: 13, marginTop: 8 }}>{msg}</p>}
    </div>
  )
}
