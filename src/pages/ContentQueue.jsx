import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import supabase from '../lib/supabase'
import { useAuth } from '../context/AuthContext'

const PLATFORMS = ['facebook', 'instagram', 'google_business', 'blog']

// ISO timestamp -> value for <input type="datetime-local"> in local time.
function toLocalInput(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  if (isNaN(d.getTime())) return ''
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

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
  const [tab, setTab] = useState('posts') // 'posts' | 'blogs' | 'published' — full queue view only
  const [published, setPublished] = useState([])
  const [publishedBrand, setPublishedBrand] = useState('all')
  const [graphics, setGraphics] = useState([])
  const [busyGraphicId, setBusyGraphicId] = useState(null)
  const [scheduleAt, setScheduleAt] = useState({}) // id -> datetime-local override
  const [selected, setSelected] = useState(new Set())
  const [bulkBusy, setBulkBusy] = useState(false)
  const [bulkProgress, setBulkProgress] = useState({ done: 0, total: 0 })
  const [busyBlogId, setBusyBlogId] = useState(null)

  async function load() {
    setLoading(true)
    const [q, b, c, p] = await Promise.all([
      // Soonest-scheduled first so the most urgent approvals surface at the
      // top; posts with no scheduled_for sort to the bottom (nullsFirst: false).
      supabase.from('mkt_content_queue').select('*, client:mkt_clients(short_name,name)').order('scheduled_for', { ascending: true, nullsFirst: false }),
      supabase.from('mkt_blog_posts').select('*, client:mkt_clients(short_name,name)').order('created_at', { ascending: false }),
      supabase.from('mkt_clients').select('id, name, short_name, content_pillars').eq('active', true).order('name'),
      // Published log — only rows whose send time has actually passed.
      supabase.from('published_posts').select('*').lte('date_sent', new Date().toISOString()).order('date_sent', { ascending: false }).limit(500),
    ])
    const g = await supabase.from('mkt_graphic_copy').select('*, client:mkt_clients(short_name,name)').order('week_of', { ascending: false })
    setItems(q.data || [])
    setBlogs(b.data || [])
    setClients(c.data || [])
    setPublished(p.data || [])
    setGraphics(g.data || [])
    if (c.data?.[0] && !gen.client_id) setGen((g) => ({ ...g, client_id: c.data[0].id }))
    setLoading(false)
  }
  useEffect(() => { load() }, [])

  const pending = items.filter((i) => i.status === 'draft')
  const now = new Date()
  const failed = items.filter((i) => i.status === 'approved' && !i.metricool_post_id && i.scheduled_for && new Date(i.scheduled_for) < now)

  async function approve(item) {
    // Item 8c: honour a per-post send-time override from the queue's time
    // picker; fall back to the post's existing scheduled_for (client default).
    const override = scheduleAt[item.id]
    const iso = override ? new Date(override).toISOString() : (item.scheduled_for || null)
    // .select() lets us confirm the update actually matched a row — an RLS
    // policy mismatch or stale id returns error: null with zero rows changed,
    // which would otherwise look like success and leave the card stuck.
    const patch = { status: 'approved', approved_at: new Date().toISOString(), approved_by: user?.email }
    if (iso) patch.scheduled_for = iso
    const { data, error } = await supabase.from('mkt_content_queue')
      .update(patch)
      .eq('id', item.id)
      .select('id')
    if (error || !data?.length) { setNotice('Something went wrong — try again.'); return }
    setItems((p) => p.map((i) => i.id === item.id ? { ...i, status: 'approved' } : i))
    // Was previously fire-and-forget (`.catch(() => {})`) — a Metricool
    // failure (401, rejected post, etc.) was silently swallowed and the
    // card just sat there with no indication anything was wrong. Now
    // awaited, and a real failure surfaces a notice + reloads so the card
    // shows its true state (schedule-to-metricool persists error_message
    // on failure, which the card already renders).
    const { data: schedData, error: schedErr } = await supabase.functions.invoke('schedule-to-metricool', { body: { content_queue_id: item.id, scheduled_for: iso } })
    if (schedErr || schedData?.error) {
      setNotice(`Approved, but scheduling to Metricool failed for ${item.client?.short_name || item.client?.name}: ${schedData?.error || schedErr?.message || 'unknown error'}`)
    }
    load()
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
    const repurposeMsg = data.repurposed
      ? `${data.posts_created} social posts generated from it.`
      : `repurposing failed: ${data.error || 'unknown error'}. Generate those posts manually.`
    const websiteMsg = data.website_post_id
      ? 'A draft is ready in Blog to publish.'
      : `couldn't create a Blog draft: ${data.website_post_error || 'unknown error'} — add it manually.`
    setNotice(`Approved. ${repurposeMsg} ${websiteMsg}`)
    load()
  }
  function copyHtml(blog) {
    navigator.clipboard.writeText(blog.content_html)
    setNotice('HTML copied to clipboard.')
  }

  async function setGraphicStatus(g, status) {
    setBusyGraphicId(g.id); setNotice('')
    const { error } = await supabase.from('mkt_graphic_copy').update({ status }).eq('id', g.id)
    setBusyGraphicId(null)
    if (error) { setNotice('Something went wrong — try again.'); return }
    setGraphics((prev) => prev.map((x) => x.id === g.id ? { ...x, status } : x))
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
              {item.error_message && (
                <p style={{ fontSize: 12, color: '#991B1B', background: '#FEF2F2', border: '1px solid #FEE2E2', borderRadius: 6, padding: '8px 10px', marginBottom: 10 }}>
                  {item.error_message}
                </p>
              )}
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
                      <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                        {item.review_status === 'passed' && (
                          <span className="pill" title={item.reviewed_at ? `Reviewed ${new Date(item.reviewed_at).toLocaleString('en-GB')}` : 'Reviewed'}
                            style={{ background: '#DCFCE7', color: '#166534' }}>✓ Reviewed</span>
                        )}
                        {item.review_status === 'needs_attention' && (
                          <span className="pill" style={{ background: '#FEE2E2', color: '#991B1B' }}>Needs attention</span>
                        )}
                        {/* Task 2 — any pending post with no review timestamp never
                            went through _shared/review.ts. Flag it distinctly (amber
                            with a border) rather than letting it read as a normal
                            reviewed-pending post. */}
                        {!item.reviewed_at && (
                          <span className="pill" title="Queued without an automated review — reviewed_at is null."
                            style={{ background: '#FEF3C7', color: '#92400E', border: '1px solid #F59E0B' }}>⚠ Unreviewed</span>
                        )}
                        <span className="pill" style={{ background: '#FEF3C7', color: '#92400E' }}>pending</span>
                      </div>
                    </div>

                    {!item.reviewed_at && (
                      <p style={{ fontSize: 12, color: '#92400E', background: '#FFFBEB', border: '1px solid #FDE68A', borderRadius: 6, padding: '8px 10px', marginBottom: 10 }}>
                        This post has not been through the automated review — it was queued before the review step existed. Read it carefully before approving.
                      </p>
                    )}

                    {item.review_status === 'needs_attention' && item.review_reason && (
                      <p style={{ fontSize: 12, color: '#991B1B', background: '#FEF2F2', border: '1px solid #FEE2E2', borderRadius: 6, padding: '8px 10px', marginBottom: 10 }}>
                        Review failed twice — {item.review_reason}. Edit and approve manually, or reject.
                      </p>
                    )}

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
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
                          <label style={{ fontSize: 12, color: 'var(--mist)' }}>Send at</label>
                          <input type="datetime-local" className="input" style={{ width: 'auto', fontSize: 13, padding: '6px 8px' }}
                            value={scheduleAt[item.id] ?? toLocalInput(item.scheduled_for)}
                            onChange={(e) => setScheduleAt((s) => ({ ...s, [item.id]: e.target.value }))} />
                        </div>
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
        <button className={'btn btn-sm ' + (tab === 'graphics' ? 'btn-primary' : 'btn-ghost')} onClick={() => setTab('graphics')}>Graphics</button>
        <button className={'btn btn-sm ' + (tab === 'published' ? 'btn-primary' : 'btn-ghost')} onClick={() => setTab('published')}>Published</button>
      </div>

      {notice && <p style={{ color: 'var(--ember)', fontSize: 13, marginTop: 8 }}>{notice}</p>}

      {tab === 'graphics' ? (
        <GraphicsTab graphics={graphics} busyId={busyGraphicId} onApprove={(g) => setGraphicStatus(g, 'approved')} onReject={(g) => setGraphicStatus(g, 'rejected')} />
      ) : tab === 'published' ? (
        <PublishedTab published={published} brand={publishedBrand} setBrand={setPublishedBrand} />
      ) : tab === 'posts' ? (
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
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2 }}>
                    <span className="pill" style={{ background: '#EDE9FE', color: '#5B21B6', fontSize: 10 }}>Blog — Sunday</span>
                    <span style={{ fontSize: 13, fontWeight: 800 }}>{blog.client?.short_name || blog.client?.name}</span>
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--mist)' }}>
                    {blog.publish_date && new Date(blog.publish_date).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })}
                    {blog.target_keyword && <span> · keyword: <strong>{blog.target_keyword}</strong></span>}
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

// Item 4 — Published tab. Shows what has actually gone out (published_posts,
// filtered server-side to date_sent <= now), with brand / date / platform /
// first 100 chars of the copy, filterable by brand.
function PublishedTab({ published, brand, setBrand }) {
  const brands = Array.from(new Set(published.map((p) => p.brand))).sort()
  const rows = brand === 'all' ? published : published.filter((p) => p.brand === brand)
  return (
    <div style={{ marginTop: 12 }}>
      <div className="field" style={{ maxWidth: 260, marginBottom: 12 }}>
        <label>Filter by brand</label>
        <select className="input" value={brand} onChange={(e) => setBrand(e.target.value)}>
          <option value="all">All brands</option>
          {brands.map((b) => <option key={b} value={b}>{b}</option>)}
        </select>
      </div>
      {rows.length === 0 ? (
        <p className="empty">Nothing published yet. Posts appear here once their scheduled send time has passed.</p>
      ) : (
        <div className="card" style={{ padding: 0, overflow: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ textAlign: 'left', color: 'var(--mist)', borderBottom: '1px solid var(--chalk)' }}>
                <th style={{ padding: '10px 12px' }}>Brand</th>
                <th style={{ padding: '10px 12px' }}>Date</th>
                <th style={{ padding: '10px 12px' }}>Platform</th>
                <th style={{ padding: '10px 12px' }}>Post</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => (
                <tr key={p.id} style={{ borderBottom: '1px solid var(--chalk)' }}>
                  <td style={{ padding: '10px 12px', fontWeight: 700, whiteSpace: 'nowrap' }}>{p.brand}</td>
                  <td style={{ padding: '10px 12px', whiteSpace: 'nowrap', color: 'var(--mist)' }}>
                    {new Date(p.date_sent).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}
                  </td>
                  <td style={{ padding: '10px 12px', textTransform: 'capitalize', whiteSpace: 'nowrap' }}>{String(p.platform).replace('_', ' ')}</td>
                  <td style={{ padding: '10px 12px' }}>{String(p.post_copy || '').slice(0, 100)}{String(p.post_copy || '').length > 100 ? '…' : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

// Item 7 — Graphics tab. Weekly brand graphic copy: headline (highlight word
// in the brand accent colour), subline, labelled "Graphic — week of [date]".
// Copy only — approving marks it ready for the designer, it never auto-posts.
function GraphicsTab({ graphics, busyId, onApprove, onReject }) {
  function renderHeadline(g) {
    const hw = (g.highlight_word || '').trim()
    if (!hw) return g.headline
    const parts = String(g.headline).split(new RegExp(`(\\b${hw.replace(/[^\w]/g, '')}\\b)`, 'i'))
    return parts.map((p, i) =>
      p.toLowerCase() === hw.toLowerCase()
        ? <span key={i} style={{ color: 'var(--ember, #E8410A)' }}>{p}</span>
        : <span key={i}>{p}</span>
    )
  }
  if (graphics.length === 0) return <p className="empty" style={{ marginTop: 16 }}>No graphic copy yet — the Monday 07:00 cron writes one per brand per week.</p>
  return (
    <div style={{ marginTop: 12 }}>
      {graphics.map((g) => (
        <div key={g.id} className="card" style={{ marginBottom: 12 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8, marginBottom: 10 }}>
            <div>
              <span className="pill" style={{ background: '#E0F2FE', color: '#075985', fontSize: 10 }}>
                Graphic — week of {new Date(g.week_of).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}
              </span>
              <div style={{ fontSize: 13, fontWeight: 800, marginTop: 4 }}>{g.client?.short_name || g.client?.name}</div>
            </div>
            <span className="pill" style={{
              background: g.status === 'draft' ? '#FEF3C7' : g.status === 'approved' ? '#D1FAE5' : '#FEE2E2',
              color: g.status === 'draft' ? '#92400E' : g.status === 'approved' ? '#065F46' : '#991B1B', flexShrink: 0,
            }}>{g.status}</span>
          </div>
          <div style={{ fontSize: 24, fontWeight: 800, lineHeight: 1.15, marginBottom: 6 }}>{renderHeadline(g)}</div>
          <div style={{ fontSize: 15, color: 'var(--mist)' }}>{g.subline}</div>
          {g.status === 'draft' && (
            <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
              <button className="btn btn-primary btn-sm" disabled={busyId === g.id} onClick={() => onApprove(g)}>
                {busyId === g.id ? '…' : 'Approve'}
              </button>
              <button className="btn btn-ghost btn-sm" style={{ color: 'var(--red)' }} disabled={busyId === g.id} onClick={() => onReject(g)}>Reject</button>
            </div>
          )}
        </div>
      ))}
    </div>
  )
}
