import { useEffect, useState } from 'react'
import supabase from '../lib/supabase'
import { BlogPostModal } from '../components/BlogPostModal'

export function Blog() {
  const [posts, setPosts] = useState([])
  const [clients, setClients] = useState([])
  const [loading, setLoading] = useState(true)
  const [brandFilter, setBrandFilter] = useState('all')
  const [editing, setEditing] = useState(undefined) // post row (edit) | null (create) | undefined (closed)
  const [notice, setNotice] = useState('')

  async function load() {
    setLoading(true)
    const [p, c] = await Promise.all([
      supabase.from('mkt_website_posts').select('*, client:mkt_clients(name, short_name, slug)').order('created_at', { ascending: false }),
      supabase.from('mkt_clients').select('id, name, short_name, slug').eq('active', true).order('name'),
    ])
    setPosts(p.data || [])
    setClients(c.data || [])
    setLoading(false)
  }
  useEffect(() => { load() }, [])

  const rows = brandFilter === 'all' ? posts : posts.filter((p) => p.client?.slug === brandFilter)

  if (loading) return <div className="page"><span className="spinner" /></div>

  return (
    <div className="page">
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 4 }}>
        <h1 style={{ flex: 1 }}>Blog</h1>
        <button className="btn btn-primary btn-sm" onClick={() => setEditing(null)}>+ New post</button>
      </div>
      <p className="page-sub">Write or paste a post, save it as a draft, then publish it straight to the brand's live site.</p>

      {notice && <p style={{ color: 'var(--ember)', fontSize: 13, marginTop: 8 }}>{notice}</p>}

      <div className="field" style={{ maxWidth: 260, marginTop: 16, marginBottom: 4 }}>
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
                    ? `Published ${new Date(post.published_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}`
                    : `Created ${new Date(post.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}`}
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
    </div>
  )
}
