import { useEffect, useState } from 'react'
import supabase from '../lib/supabase'
// UK-local display formatting (src/lib/ukTime.js). Only the RENDERING of
// stored UTC timestamps goes through these — every query filter, sort and
// date-bucketing key below is left on the raw value, deliberately.
import { ukDate } from '../lib/ukTime'
import { BlogPostModal } from '../components/BlogPostModal'

export function Blog() {
  const [posts, setPosts] = useState([])
  const [aiDrafts, setAiDrafts] = useState([])
  const [clients, setClients] = useState([])
  const [loading, setLoading] = useState(true)
  const [brandFilter, setBrandFilter] = useState('all')
  const [editing, setEditing] = useState(undefined) // post row (edit) | null (create) | undefined (closed)
  const [notice, setNotice] = useState('')
  const [busyDraftId, setBusyDraftId] = useState(null)
  const [rejectingBlog, setRejectingBlog] = useState(null)
  const [blogRejectReason, setBlogRejectReason] = useState('')
  // Display-only filters for the AI drafts list — off by default so the
  // page opens showing just what needs attention. Neither touches what data
  // is loaded or what any button does; both filter the existing aiDrafts
  // array at render time.
  const [showPublished, setShowPublished] = useState(false)
  const [showRejected, setShowRejected] = useState(false)

  async function load() {
    setLoading(true)
    const [p, b, c] = await Promise.all([
      supabase.from('mkt_website_posts').select('*, client:mkt_clients(name, short_name, slug)').order('created_at', { ascending: false }),
      // The Sunday-cron AI blog queue — consolidated here from the old
      // Content queue "Blogs" tab so all blog management lives in one place.
      supabase.from('mkt_blog_posts').select('*, client:mkt_clients(short_name,name,slug)').order('created_at', { ascending: false }),
      supabase.from('mkt_clients').select('id, name, short_name, slug').eq('active', true).order('name'),
    ])
    setPosts(p.data || [])
    setAiDrafts(b.data || [])
    setClients(c.data || [])
    setLoading(false)
  }
  useEffect(() => { load() }, [])

  const rows = brandFilter === 'all' ? posts : posts.filter((p) => p.client?.slug === brandFilter)

  // "Needing attention" = anything not yet published and not rejected —
  // covers draft (awaiting approve & publish) and the rare stuck
  // 'approved'/'publish_failed' states, not just a literal 'draft' status.
  const pendingCount = aiDrafts.filter((b) => b.status !== 'published' && b.status !== 'rejected').length
  const visibleDrafts = aiDrafts.filter((b) => {
    if (b.status === 'published') return showPublished
    if (b.status === 'rejected') return showRejected
    return true
  })

  // The publish half, shared by first-time approve-and-publish and by the
  // retry path for a 'publish_failed'/'approved' row. Returns nothing; sets a
  // notice and reloads. publish-approved-blog now marks the row
  // 'publish_failed' (and logs the reason) when a real publish attempt fails,
  // so that status is left in place — a genuine, visible, retryable state.
  // Only a row still stuck in 'approved' (a failure before the function could
  // mark it) is rescued back to draft so nothing sits in approved limbo.
  async function runPublish(blog) {
    const { data: pubData, error: pubErr } = await supabase.functions.invoke('publish-approved-blog', { body: { blog_id: blog.id, client_id: blog.client_id } })
    if (pubErr || !pubData?.ok) {
      await supabase.from('mkt_blog_posts').update({ status: 'draft' }).eq('id', blog.id).eq('status', 'approved')
      setNotice(`Publishing failed. ${pubData?.error || pubErr?.message || 'Unknown error'}`)
      load()
      return
    }
    if (pubData.method === 'manual') {
      const blobUrl = URL.createObjectURL(new Blob([pubData.htmlContent], { type: 'text/html' }))
      const a = document.createElement('a')
      a.href = blobUrl; a.download = pubData.filename || 'post.html'
      document.body.appendChild(a); a.click(); a.remove()
      URL.revokeObjectURL(blobUrl)
      // Not "Marked published" (30 Aug 2026) — ${blog.client...} isn't wired
      // for automatic publishing, so nothing has actually gone live yet;
      // publish-approved-blog now leaves the row 'publish_unverified' for
      // exactly this reason (see its Branch 3 comment). Saying "published"
      // here was a real, live false claim — confirmed against 4 production
      // rows sitting as status='published' with nothing live anywhere.
      // "Recheck / retry" re-downloads the same file rather than confirming
      // anything live — there is no site to check for this brand, so this
      // row has no automatic path to 'published' at all.
      setNotice(`HTML downloaded — ${blog.client?.short_name || blog.client?.name} isn't wired for automatic publishing, so upload it manually to make it live. Left as "not confirmed live" — nothing here can verify that for you.`)
    } else if (pubData.verified === false) {
      // Committed to GitHub successfully, but the live-URL check (added
      // 12 Aug 2026 — see publish-approved-blog's pollForTitle) couldn't
      // confirm the post actually rendered. Left as 'publish_unverified',
      // not 'published' — this is a genuine distinct outcome, not a failure.
      setNotice(pubData.warning || `Committed, but couldn't confirm ${pubData.liveUrl} is live yet.`)
    } else {
      setNotice(`Published — live at ${pubData.liveUrl}`)
    }
    load()
  }

  // Approve and publish in one tap — no separate Publish step.
  async function approveAndPublish(blog) {
    setBusyDraftId(blog.id); setNotice('')
    const { data: appData, error: appErr } = await supabase.functions.invoke('approve-blog', { body: { blog_id: blog.id } })
    if (appErr || !appData?.ok) {
      setBusyDraftId(null)
      setNotice(appData?.error || appErr?.message || "Couldn't approve that blog — try again.")
      return
    }
    await runPublish(blog)
    setBusyDraftId(null)
  }

  // Retry a blog that already approved (social posts already generated) but
  // failed to publish — re-runs only the publish half, never approve-blog, so
  // retrying can't regenerate a second batch of social posts.
  async function retryPublish(blog) {
    setBusyDraftId(blog.id); setNotice('')
    await runPublish(blog)
    setBusyDraftId(null)
  }

  // Reject flow — same pattern as the content queue (ContentQueue.jsx's
  // reject/submitReject/RejectModal): reason is optional, defaults to
  // "Rejected by Adrian" if left blank. Setting status='rejected' is enough
  // to drop the draft out of visibleDrafts (see the filter above) unless
  // "Show rejected" is checked, so no separate removal step is needed.
  function rejectBlogDraft(blog) {
    setRejectingBlog(blog)
    setBlogRejectReason('')
  }
  async function submitRejectBlogDraft(reason) {
    const blog = rejectingBlog
    if (!blog) return
    const finalReason = (reason || '').trim() || 'Rejected by Adrian'
    const patch = { status: 'rejected', rejection_reason: finalReason, rejected_at: new Date().toISOString() }
    const { error } = await supabase.from('mkt_blog_posts').update(patch).eq('id', blog.id)
    setRejectingBlog(null)
    if (error) { setNotice('Something went wrong — try again.'); return }
    setAiDrafts((prev) => prev.map((b) => (b.id === blog.id ? { ...b, ...patch } : b)))
  }

  if (loading) return <div className="page"><span className="spinner" /></div>

  return (
    <div className="page">
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 4 }}>
        <h1 style={{ flex: 1 }}>Blog</h1>
        <button className="btn btn-primary btn-sm" onClick={() => setEditing(null)}>+ New post</button>
      </div>
      <p className="page-sub">All blog management — AI drafts, manual posts, approve, and publish — lives here.</p>

      {notice && <p style={{ color: 'var(--ember)', fontSize: 13, marginTop: 8 }}>{notice}</p>}

      {aiDrafts.length > 0 && (
        <div style={{ marginTop: 20 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap', marginBottom: 10 }}>
            <h2 style={{ fontSize: 15, margin: 0 }}>
              AI drafts (Sunday cron) — {pendingCount} need{pendingCount === 1 ? 's' : ''} attention
            </h2>
            <label style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 12, color: 'var(--mist)', fontWeight: 600 }}>
              <input type="checkbox" checked={showPublished} onChange={(e) => setShowPublished(e.target.checked)} />
              Show published
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 12, color: 'var(--mist)', fontWeight: 600 }}>
              <input type="checkbox" checked={showRejected} onChange={(e) => setShowRejected(e.target.checked)} />
              Show rejected
            </label>
          </div>
          {visibleDrafts.length === 0 && (
            <p className="empty" style={{ marginBottom: 12 }}>
              {pendingCount === 0 ? 'Nothing needs attention.' : 'Nothing matches the current filters.'}
            </p>
          )}
          {visibleDrafts.map((blog) => (
            <div key={blog.id} className="card" style={{ marginBottom: 12 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8, marginBottom: 10 }}>
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2 }}>
                    <span className="pill" style={{ background: '#EDE9FE', color: '#5B21B6', fontSize: 10 }}>Blog — Sunday</span>
                    <span style={{ fontSize: 13, fontWeight: 800 }}>{blog.client?.short_name || blog.client?.name}</span>
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--mist)' }}>
                    {blog.publish_date && ukDate(blog.publish_date, { weekday: 'short', day: 'numeric', month: 'short' })}
                    {blog.target_keyword && <span> · keyword: <strong>{blog.target_keyword}</strong></span>}
                  </div>
                </div>
                <span className="pill" style={{
                  background: blog.status === 'draft' ? '#FEF3C7' : blog.status === 'published' ? '#D1FAE5' : blog.status === 'publish_failed' ? '#FEE2E2' : blog.status === 'publish_unverified' ? '#FEF3C7' : blog.status === 'rejected' ? '#FEE2E2' : 'var(--chalk)',
                  color: blog.status === 'draft' ? '#92400E' : blog.status === 'published' ? '#065F46' : blog.status === 'publish_failed' ? '#991B1B' : blog.status === 'publish_unverified' ? '#92400E' : blog.status === 'rejected' ? '#991B1B' : 'var(--steel)',
                  flexShrink: 0,
                }}>{blog.status === 'publish_failed' ? 'publish failed' : blog.status === 'publish_unverified' ? 'not confirmed live' : blog.status}</span>
              </div>
              <h3 style={{ fontSize: 17, marginBottom: 6 }}>{blog.title}</h3>
              <p style={{ fontSize: 12, color: 'var(--mist)', marginBottom: 10 }}>{blog.meta_description}</p>
              <div style={{
                maxHeight: 220, overflow: 'auto', border: '1px solid var(--border, #e5e5e5)', borderRadius: 6,
                padding: 12, fontSize: 13, lineHeight: 1.6, marginBottom: 12,
              }} dangerouslySetInnerHTML={{ __html: blog.content_html }} />
              {blog.status === 'draft' ? (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <button className="btn btn-primary btn-sm" disabled={busyDraftId === blog.id} onClick={() => approveAndPublish(blog)}>
                    {busyDraftId === blog.id ? 'Approving & publishing…' : 'Approve & publish'}
                  </button>
                  <button className="btn btn-ghost btn-sm" style={{ color: 'var(--red)' }} disabled={busyDraftId === blog.id} onClick={() => rejectBlogDraft(blog)}>
                    Reject
                  </button>
                </div>
              ) : blog.status === 'published' ? (
                <span className="pill" style={{ background: '#D1FAE5', color: '#065F46' }}>✓ Published</span>
              ) : blog.status === 'rejected' ? (
                <p style={{ fontSize: 12, color: '#991B1B', margin: 0 }}>
                  Rejected{blog.rejected_at && ` ${ukDate(blog.rejected_at, { day: 'numeric', month: 'short', year: 'numeric' })}`}
                  {' — '}{blog.rejection_reason || 'No reason given.'}
                </p>
              ) : (
                // 'publish_failed', 'publish_unverified', or a rare stuck
                // 'approved' — already approved (socials generated), so
                // retry only the publish half.
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <button className="btn btn-primary btn-sm" disabled={busyDraftId === blog.id} onClick={() => retryPublish(blog)}>
                    {busyDraftId === blog.id ? 'Publishing…' : blog.status === 'publish_unverified' ? 'Recheck / retry' : 'Retry publish'}
                  </button>
                  {blog.status === 'publish_failed' && (
                    <span style={{ fontSize: 12, color: '#991B1B' }}>Last publish failed — check the error log.</span>
                  )}
                  {blog.status === 'publish_unverified' && (
                    <span style={{ fontSize: 12, color: '#92400E' }}>
                      {/* live_url is only ever set on the GitHub-committed path
                          (publish-approved-blog Branch 1) — reliable signal for
                          which message applies without a second hardcoded brand
                          list here (30 Aug 2026). Branch 3 (no deploy target,
                          e.g. CRHQ, Quill — LinkedIn) never sets it, and retry
                          there just re-downloads the same file, not a real
                          recheck — see runPublish's 'manual' branch. */}
                      {blog.live_url
                        ? `Committed to GitHub, but not yet confirmed live at ${blog.live_url} — check the site's Netlify deploy, then retry.`
                        : `${blog.client?.short_name || blog.client?.name} isn't wired for automatic publishing — nothing here can confirm it's live. Retry only re-downloads the file.`}
                    </span>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 24, marginBottom: 4 }}>
        <h2 style={{ fontSize: 15, flex: 1 }}>Manual posts</h2>
      </div>

      <div className="field" style={{ maxWidth: 260, marginTop: 12, marginBottom: 4 }}>
        <label>Filter by brand</label>
        <select className="input" value={brandFilter} onChange={(e) => setBrandFilter(e.target.value)}>
          <option value="all">All brands</option>
          {clients.map((c) => <option key={c.slug} value={c.slug}>{c.short_name || c.name}</option>)}
        </select>
      </div>

      <div style={{ marginTop: 12 }}>
        {rows.length === 0 ? (
          <p className="empty">No posts yet. Create one, or wait for Sunday's AI draft.</p>
        ) : rows.map((post) => (
          <button
            key={post.id}
            className="card"
            style={{ display: 'block', width: '100%', textAlign: 'left', marginBottom: 12, border: 'none', cursor: 'pointer' }}
            onClick={() => setEditing(post)}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--mist)', marginBottom: 2 }}>
                  {post.client?.short_name || post.client?.name}
                </div>
                <div style={{ fontSize: 16, fontWeight: 700 }}>{post.title}</div>
                <div style={{ fontSize: 12, color: 'var(--mist)', marginTop: 4 }}>
                  {post.status === 'published' && post.published_at
                    ? `Published ${ukDate(post.published_at, { day: 'numeric', month: 'short', year: 'numeric' })}`
                    : `Created ${ukDate(post.created_at, { day: 'numeric', month: 'short', year: 'numeric' })}`}
                </div>
              </div>
              <span className="pill" style={{
                background: post.status === 'published' ? '#D1FAE5' : '#FEF3C7',
                color: post.status === 'published' ? '#065F46' : '#92400E',
                flexShrink: 0,
              }}>{post.status}</span>
            </div>
          </button>
        ))}
      </div>

      {editing !== undefined && (
        <BlogPostModal
          post={editing}
          clients={clients}
          posts={posts}
          onClose={() => setEditing(undefined)}
          onSaved={() => { setNotice(''); load() }}
        />
      )}

      <RejectBlogModal
        blog={rejectingBlog}
        reason={blogRejectReason}
        setReason={setBlogRejectReason}
        onCancel={() => setRejectingBlog(null)}
        onSubmit={submitRejectBlogDraft}
      />
    </div>
  )
}

// Same pattern as ContentQueue.jsx's RejectModal — reason optional, defaults
// to "Rejected by Adrian" if left blank.
function RejectBlogModal({ blog, reason, setReason, onCancel, onSubmit }) {
  if (!blog) return null
  return (
    <div className="modal-bg" onClick={(e) => { if (e.target === e.currentTarget) onCancel() }}>
      <div className="modal">
        <h2 style={{ fontSize: 18, marginBottom: 4 }}>Reject blog post</h2>
        <p className="muted" style={{ fontSize: 13, marginBottom: 14 }}>{blog.client?.short_name || blog.client?.name} — {blog.title}</p>
        <div className="field">
          <label>Reason (optional)</label>
          <textarea className="input" rows={3} value={reason} onChange={(e) => setReason(e.target.value)}
            placeholder="Leave blank to skip." />
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button className="btn btn-ghost" onClick={onCancel}>Cancel</button>
          <button className="btn btn-ghost" onClick={() => onSubmit('')}>Skip &amp; reject</button>
          <button className="btn btn-primary" style={{ flex: 1 }} onClick={() => onSubmit(reason)}>Reject</button>
        </div>
      </div>
    </div>
  )
}
