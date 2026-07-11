import { useEffect, useState } from 'react'
import supabase from '../lib/supabase'
import { slugify, uniqueSlug, autoExcerpt, markdownToHtml } from '../lib/blog'

// Brands with a working one-tap publish path (publish-blog-post edge
// function commits to GitHub + triggers a Netlify deploy). Everyone else
// gets a disabled Publish button with an honest reason — see
// supabase/functions/publish-blog-post/index.ts for why Quill and Steady
// specifically aren't (and won't be, without further work) wired the same
// way as Hormonely/Neuro Decoded.
const PUBLISH_READY = new Set(['hormonely', 'neuro-decoded'])
const PUBLISH_DISABLED_REASON = {
  quill: 'Manual publish — no linked GitHub repo yet',
  steady: 'Manual publish — Steady has its own blog admin',
}
const DEFAULT_DISABLED_REASON = 'Manual publish — blog not yet wired.'

function publishDisabledReason(slug) {
  if (PUBLISH_READY.has(slug)) return null
  return PUBLISH_DISABLED_REASON[slug] || DEFAULT_DISABLED_REASON
}

const EMPTY = { client_id: '', title: '', slug: '', body: '', excerpt: '', featured_image_url: '', seo_keyword: '' }

export function BlogPostModal({ post, clients, posts, onClose, onSaved }) {
  const [form, setForm] = useState(() => post
    ? { client_id: post.client_id, title: post.title, slug: post.slug, body: post.body || '', excerpt: post.excerpt || '', featured_image_url: post.featured_image_url || '', seo_keyword: post.seo_keyword || '' }
    : { ...EMPTY, client_id: clients[0]?.id || '' })
  const [slugTouched, setSlugTouched] = useState(!!post)
  const [excerptTouched, setExcerptTouched] = useState(!!post?.excerpt)
  const [preview, setPreview] = useState(false)
  const [saving, setSaving] = useState(false)
  const [publishing, setPublishing] = useState(false)
  const [error, setError] = useState('')
  const [savedPost, setSavedPost] = useState(post || null)

  useEffect(() => {
    if (!slugTouched) setForm((f) => ({ ...f, slug: slugify(f.title) }))
  }, [form.title, slugTouched])

  useEffect(() => {
    if (!excerptTouched) setForm((f) => ({ ...f, excerpt: autoExcerpt(f.body) }))
  }, [form.body, excerptTouched])

  function set(k, v) { setForm((f) => ({ ...f, [k]: v })) }

  const client = clients.find((c) => c.id === form.client_id)
  const disabledReason = client ? publishDisabledReason(client.slug) : null
  const canSave = form.client_id && form.title.trim() && form.body.trim()

  async function saveDraft() {
    setError('')
    if (!canSave) { setError('Pick a brand, and fill in a title and body.'); return }
    setSaving(true)
    const finalSlug = uniqueSlug(form.slug || slugify(form.title), form.client_id, posts, savedPost?.id)
    const row = {
      client_id: form.client_id,
      title: form.title.trim(),
      slug: finalSlug,
      body: form.body,
      excerpt: form.excerpt || autoExcerpt(form.body),
      featured_image_url: form.featured_image_url || null,
      seo_keyword: form.seo_keyword || null,
      updated_at: new Date().toISOString(),
    }
    let result
    if (savedPost) {
      result = await supabase.from('mkt_website_posts').update(row).eq('id', savedPost.id).select().single()
    } else {
      result = await supabase.from('mkt_website_posts').insert(row).select().single()
    }
    setSaving(false)
    if (result.error) { setError(`Could not save: ${result.error.message}`); return }
    setSavedPost(result.data)
    setForm((f) => ({ ...f, slug: finalSlug }))
    onSaved?.()
  }

  async function publish() {
    if (!savedPost) { setError('Save the draft first.'); return }
    setError(''); setPublishing(true)
    const { data, error: fnErr } = await supabase.functions.invoke('publish-blog-post', { body: { post_id: savedPost.id } })
    setPublishing(false)
    if (fnErr || data?.error) { setError(data?.error || fnErr?.message || 'Publish failed — try again.'); return }
    if (data?.warning) setError(data.warning)
    setSavedPost((p) => ({ ...p, status: 'published', published_at: data?.published_at || new Date().toISOString() }))
    onSaved?.()
  }

  const published = savedPost?.status === 'published'

  return (
    <div className="modal-bg" onClick={(e) => { if (e.target === e.currentTarget && !saving && !publishing) onClose() }}>
      <div className="modal" style={{ maxWidth: 680 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
          <h2 style={{ fontSize: 18, flex: 1 }}>{savedPost ? 'Edit post' : 'New blog post'}</h2>
          {savedPost && (
            <span className="pill" style={{
              background: published ? '#D1FAE5' : '#FEF3C7',
              color: published ? '#065F46' : '#92400E',
            }}>{savedPost.status}</span>
          )}
        </div>

        <div className="field">
          <label>Brand</label>
          <select className="input" value={form.client_id} onChange={(e) => set('client_id', e.target.value)} disabled={!!savedPost}>
            {clients.map((c) => <option key={c.id} value={c.id}>{c.short_name || c.name}</option>)}
          </select>
        </div>

        <div className="field">
          <label>Title</label>
          <input className="input" value={form.title} onChange={(e) => set('title', e.target.value)} placeholder="How to…" />
        </div>

        <div className="field">
          <label>Slug</label>
          <input className="input" value={form.slug} onChange={(e) => { setSlugTouched(true); set('slug', slugify(e.target.value)) }} placeholder="how-to" />
        </div>

        <div className="field">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <label style={{ marginBottom: 0 }}>Body (markdown)</label>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setPreview((p) => !p)}>
              {preview ? 'Edit' : 'Preview'}
            </button>
          </div>
          {preview ? (
            <div className="card" style={{ marginTop: 8, maxHeight: 360, overflow: 'auto' }}>
              {form.featured_image_url && (
                <img src={form.featured_image_url} alt="" style={{ width: '100%', borderRadius: 8, marginBottom: 12 }} />
              )}
              <h1 style={{ fontSize: 22, marginBottom: 8 }}>{form.title || 'Untitled'}</h1>
              <div style={{ fontSize: 14, lineHeight: 1.6 }} dangerouslySetInnerHTML={{ __html: markdownToHtml(form.body) }} />
            </div>
          ) : (
            <textarea className="input" rows={12} value={form.body} onChange={(e) => set('body', e.target.value)}
              placeholder={'Write or paste markdown here…'} style={{ marginTop: 8, fontFamily: 'ui-monospace, monospace', fontSize: 13 }} />
          )}
        </div>

        <div className="grid grid-2">
          <div className="field">
            <label>SEO keyword (optional)</label>
            <input className="input" value={form.seo_keyword} onChange={(e) => set('seo_keyword', e.target.value)} />
          </div>
          <div className="field">
            <label>Featured image URL (optional)</label>
            <input className="input" value={form.featured_image_url} onChange={(e) => set('featured_image_url', e.target.value)} placeholder="https://…" />
          </div>
        </div>

        <div className="field">
          <label>Excerpt</label>
          <textarea className="input" rows={2} value={form.excerpt} onChange={(e) => { setExcerptTouched(true); set('excerpt', e.target.value) }} />
        </div>

        {error && <p style={{ color: 'var(--red)', fontSize: 13, marginBottom: 10 }}>{error}</p>}

        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button className="btn btn-ghost" onClick={onClose} disabled={saving || publishing}>Close</button>
          <button className="btn btn-dark" style={{ flex: 1 }} onClick={saveDraft} disabled={saving || publishing || !canSave}>
            {saving ? 'Saving…' : 'Save draft'}
          </button>
          {published ? (
            <button className="btn btn-primary" style={{ flex: 1 }} disabled>Published ✓</button>
          ) : (
            <button
              className="btn btn-primary" style={{ flex: 1 }}
              disabled={!savedPost || publishing || !!disabledReason}
              title={disabledReason || ''}
              onClick={publish}
            >
              {publishing ? 'Publishing…' : disabledReason || 'Publish'}
            </button>
          )}
        </div>
        {!savedPost && <p className="muted" style={{ fontSize: 12, marginTop: 10 }}>Save a draft first — Publish unlocks once it's saved.</p>}
      </div>
    </div>
  )
}
