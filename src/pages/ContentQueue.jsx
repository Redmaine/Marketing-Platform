import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import supabase from '../lib/supabase'
import { useAuth } from '../context/AuthContext'

const PLATFORMS = ['facebook', 'instagram', 'google_business', 'blog']

export function ContentQueue() {
  const { user } = useAuth()
  const [searchParams, setSearchParams] = useSearchParams()
  const statusFilter = searchParams.get('status') // 'draft' or 'failed' when coming from dashboard
  const [items, setItems] = useState([])
  const [blogs, setBlogs] = useState([])
  const [clients, setClients] = useState([])
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState(null)
  const [draft, setDraft] = useState('')
  const [gen, setGen] = useState({ client_id: '', platform: 'facebook', pillar: '' })
  const [generating, setGenerating] = useState(false)
  const [notice, setNotice] = useState('')
  const [tab, setTab] = useState('posts') // 'posts' | 'blogs' — full queue view only
  const [selected, setSelected] = useState(new Set())
  const [bulkBusy, setBulkBusy] = useState(false)
  const [bulkProgress, setBulkProgress] = useState({ done: 0, total: 0 })
  const [busyBlogId, setBusyBlogId] = useState(null)

  async function load() {
    setLoading(true)
    const [q, b, c] = await Promise.all([
      // Soonest-scheduled first so the most urgent approvals surface at the
      // top; posts with no scheduled_for sort to the bottom (nullsFirst: false).
      supabase.from('mkt_content_queue').select('*, client:mkt_clients(short_name,name)').order('scheduled_for', { ascending: true, nullsFirst: false }),
      supabase.from('mkt_blog_posts').select('*, client:mkt_clients(short_name,name)').order('created_at', { ascending: false }),
      supabase.from('mkt_clients').select('id, name, short_name, content_pillars').eq('active', true).order('name'),
    ])
    setItems(q.data || [])
    setBlogs(b.data || [])
    setClients(c.data || [])
    if (c.data?.[0] && !gen.client_id) setGen((g) => ({ ...g, client_id: c.data[0].id }))
    setLoading(false)
  }
  useEffect(() => { load() }, [])

  const pending = items.filter((i) => i.status === 'draft')
  const now = new Date()
  const failed = items.filter((i) => i.status === 'approved' && !i.metricool_post_id && i.scheduled_for && new Date(i.scheduled_for) < now)

  async function approve(item) {
    // .select() lets us confirm the update actually matched a row — an RLS
    // policy mismatch or stale id returns error: null with zero rows changed,
    // which would otherwise look like success and leave the card stuck.
    const { data, error } = await supabase.from('mkt_content_queue')
      .update({ status: 'approved', approved_at: new Date().toISOString(), approved_by: user?.email })
      .eq('id', item.id)
      .select('id')
    if (error || !data?.length) { setNotice('Something went wrong — try again.'); return }
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
  async function retry(item) {
    setNotice('')
    const { error } = await supabase.functions.invoke('schedule-to-metricool', { body: { content_queue_id: item.id } })
    if (error) { setNotice(`Retry failed for ${item.client?.short_name || item.client?.name}.`); return }
    load()
  }

  function toggleSelect(id) {
    setSelected((s) => {
      const next = new Set(s)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }
  function toggleSelectAll() {
    setSelected((s) => s.size === pending.length ? new Set() : new Set(pending.map((i) => i.id)))
  }
  async function bulkApprove() {
    const ids = Array.from(selected)
    if (ids.length === 0) return
    setBulkBusy(true); setBulkProgress({ done: 0, total: ids.length }); setNotice('')
    let failures = 0
    for (const id of ids) {
      const { error } = await supabase.from('mkt_content_queue')
        .update({ status: 'approved', approved_at: new Date().toISOString(), approved_by: user?.email })
        .eq('id', id)
      if (error) { failures++; setBulkProgress((p) => ({ ...p, done: p.done + 1 })); continue }
      try {
        const { error: fnErr } = await supabase.functions.invoke('schedule-to-metricool', { body: { content_queue_id: id } })
        if (fnErr) failures++
      } catch { failures++ }
      setItems((p) => p.map((i) => i.id === id ? { ...i, status: 'approved' } : i))
      setBulkProgress((p) => ({ ...p, done: p.done + 1 }))
    }
    setBulkBusy(false)
    setSelected(new Set())
    if (failures > 0) setNotice(`${failures} post${failures === 1 ? '' : 's'} failed to schedule to Metricool — see "Failed to schedule" on the dashboard.`)
    load()
  }

  async function approveBlog(blog) {
    setBusyBlogId(blog.id); setNotice('')
    const { data, error } = await supabase.functions.invoke('approve-blog', { body: { blog_id: blog.id } })
    setBusyBlogId(null)
    if (error || !data?.ok) { setNotice(data?.error || "Couldn't approve that blog — try again."); return }
    if (data.repurposed) setNotice(`Approved. ${data.posts_created} social posts generated from it.`)
    else setNotice(`Blog approved, but repurposing failed: ${data.error || 'unknown error'}. Generate those posts manually.`)
    load()
  }
  function copyHtml(blog) {
    navigator.clipboard.writeText(blog.content_html)
    setNotice('HTML copied to clipboard.')
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

  // ── Failed-to-schedule view (/content?status=failed) ─────────────────────────
  if (statusFilter === 'failed') {
    return (
      <div className="page">
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 4 }}>
          <h1 style={{ flex: 1 }}>Failed to schedule</h1>
          <button className="btn btn-ghost btn-sm" onClick={() => setSearchParams({})}>View all posts</button>
        </div>
        <p className="page-sub">
          {failed.length === 0 ? 'Nothing stuck — everything approved has made it to Metricool.' : `${failed.length} post${failed.length === 1 ? '' : 's'} approved but never reached Metricool.`}
        </p>
        {notice && <p style={{ color: 'var(--ember)', fontSize: 13, marginTop: 8 }}>{notice}</p>}
        <div style={{ marginTop: 16 }}>
          {failed.map((item) => (
            <div key={item.id} className="card" style={{ marginBottom: 12 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8, marginBottom: 10 }}>
                <div>
                  <div style={{ fontSize: 13, fontWeight: 800, marginBottom: 2 }}>{item.client?.short_name || item.client?.name}</div>
                  <div style={{ fontSize: 11, color: 'var(--mist)', textTransform: 'capitalize' }}>
                    {item.platform}{item.pillar ? ` · ${item.pillar}` : ''}
                    {item.scheduled_for && <span style={{ marginLeft: 8 }}>· was due {new Date(item.scheduled_for).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}</span>}
                  </div>
                </div>
                <span className="pill" style={{ background: '#FEE2E2', color: '#991B1B', flexShrink: 0 }}>failed</span>
              </div>
              <p style={{ fontSize: 14, lineHeight: 1.6, whiteSpace: 'pre-wrap', marginBottom: 12 }}>{item.body}</p>
              <button className="btn btn-primary btn-sm" onClick={() => retry(item)}>Retry</button>
            </div>
          ))}
        </div>
      </div>
    )
  }

  // ── Approval queue view (/content?status=draft) ──────────────────────────────
  if (statusFilter === 'draft') {
    return (
      <div className="page">
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 4 }}>
          <h1 style={{ flex: 1 }}>Awaiting approval</h1>
          <button className="btn btn-ghost btn-sm" onClick={() => setSearchParams({})}>View all posts</button>
        </div>
        <p className="page-sub">
          {pending.length === 0 ? 'Nothing waiting for approval.' : `${pending.length} post${pending.length === 1 ? '' : 's'} waiting for approval across all brands.`}
        </p>
        {notice && <p style={{ color: 'var(--ember)', fontSize: 13, marginTop: 8, marginBottom: 4 }}>{notice}</p>}

        {pending.length === 0 ? (
          <p className="empty" style={{ marginTop: 24 }}>All caught up.</p>
        ) : (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 16, marginBottom: 4 }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, fontWeight: 600 }}>
                <input type="checkbox" checked={selected.size === pending.length && pending.length > 0} onChange={toggleSelectAll} />
                Select all
              </label>
              <button className="btn btn-primary btn-sm" disabled={selected.size === 0 || bulkBusy} onClick={bulkApprove}>
                {bulkBusy ? `Approving ${bulkProgress.done}/${bulkProgress.total}…` : `Approve selected${selected.size ? ` (${selected.size})` : ''}`}
              </button>
            </div>

            <div style={{ marginTop: 12 }}>
              {pending.map((item) => (
                <div key={item.id} className="card" style={{ marginBottom: 12, display: 'flex', gap: 10 }}>
                  <input type="checkbox" checked={selected.has(item.id)} onChange={() => toggleSelect(item.id)} style={{ marginTop: 4 }} />
                  <div style={{ flex: 1 }}>
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
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    )
  }

  // ── Full queue view (/content) ───────────────────────────────────────────────
  return (
    <div className="page">
      <h1>Content queue</h1>
      <p className="page-sub">{pending.length === 0 ? 'Nothing waiting for approval.' : `${pending.length} waiting for approval.`}</p>

      <div style={{ display: 'flex', gap: 8, marginTop: 16, marginBottom: 4 }}>
        <button className={'btn btn-sm ' + (tab === 'posts' ? 'btn-primary' : 'btn-ghost')} onClick={() => setTab('posts')}>Posts</button>
        <button className={'btn btn-sm ' + (tab === 'blogs' ? 'btn-primary' : 'btn-ghost')} onClick={() => setTab('blogs')}>Blogs</button>
      </div>

      {notice && <p style={{ color: 'var(--ember)', fontSize: 13, marginTop: 8 }}>{notice}</p>}

      {tab === 'posts' ? (
        <>
          <div className="card" style={{ marginTop: 12 }}>
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
        </>
      ) : (
        <div style={{ marginTop: 12 }}>
          {blogs.length === 0 ? <p className="empty">No blogs generated yet — the Sunday cron writes one per client per week.</p> : blogs.map((blog) => (
            <div key={blog.id} className="card" style={{ marginBottom: 12 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8, marginBottom: 10 }}>
                <div>
                  <div style={{ fontSize: 13, fontWeight: 800, marginBottom: 2 }}>{blog.client?.short_name || blog.client?.name}</div>
                  <div style={{ fontSize: 11, color: 'var(--mist)' }}>
                    {blog.publish_date && new Date(blog.publish_date).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })}
                  </div>
                </div>
                <span className="pill" style={{
                  background: blog.status === 'draft' ? '#FEF3C7' : blog.status === 'approved' ? '#D1FAE5' : 'var(--chalk)',
                  color: blog.status === 'draft' ? '#92400E' : blog.status === 'approved' ? '#065F46' : 'var(--steel)',
                  flexShrink: 0,
                }}>{blog.status}</span>
              </div>
              <h3 style={{ fontSize: 17, marginBottom: 6 }}>{blog.title}</h3>
              <p style={{ fontSize: 12, color: 'var(--mist)', marginBottom: 10 }}>{blog.meta_description}</p>
              <div style={{
                maxHeight: 220, overflow: 'auto', border: '1px solid var(--border, #e5e5e5)', borderRadius: 6,
                padding: 12, fontSize: 13, lineHeight: 1.6, marginBottom: 12,
              }} dangerouslySetInnerHTML={{ __html: blog.content_html }} />
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {blog.status === 'draft' && (
                  <button className="btn btn-primary btn-sm" disabled={busyBlogId === blog.id} onClick={() => approveBlog(blog)}>
                    {busyBlogId === blog.id ? 'Approving…' : 'Approve'}
                  </button>
                )}
                {blog.status !== 'draft' && (
                  <button className="btn btn-ghost btn-sm" onClick={() => copyHtml(blog)}>Copy HTML</button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
