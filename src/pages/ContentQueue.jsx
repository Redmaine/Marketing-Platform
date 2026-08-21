import { Fragment, useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import supabase from '../lib/supabase'
import { useAuth } from '../context/AuthContext'
import { awaitingBucket, partitionAwaiting } from '../lib/awaitingApproval'
// UK-local display formatting (src/lib/ukTime.js). Only the RENDERING of
// stored UTC timestamps goes through these — every query filter, sort and
// date-bucketing key below is left on the raw value, deliberately.
import { ukDate, ukTime, ukDateTime } from '../lib/ukTime'

const PLATFORMS = ['facebook', 'instagram', 'google_business', 'blog']

// Section headings for the approval queue's labelled groups. Every awaiting
// post lands in exactly one of these and they always sum back to the headline
// total — the point of the grouping is that a post can be visually separated
// (because it needs different handling) without being quietly dropped from the
// count, which is what previously made three screens disagree.
const AWAITING_SECTION_META = {
  ready: { label: 'Ready to review', hint: 'Passed automated review and still in date.' },
  needs_attention: { label: 'Failed automated review', hint: 'Flagged by content review — read before approving or rejecting.' },
  blog_dependent: { label: 'Waiting on a blog post', hint: 'Blocked until the blog they reference is published.' },
  stale: { label: 'Past their scheduled slot', hint: 'The scheduled date has already passed — reschedule or reject.' },
}

// Platform labels/colours for the queue's platform badge — every value ever
// written to mkt_content_queue.platform must have an entry here (falls back
// to a generic grey + the raw value below if a new platform shows up).
const PLATFORM_META = {
  facebook: { label: 'Facebook', bg: '#DBEAFE', color: '#1E3A8A' },
  instagram: { label: 'Instagram', bg: '#FCE7F3', color: '#9D174D' },
  linkedin: { label: 'LinkedIn', bg: '#DBEAFE', color: '#0C4A6E' },
  google_business: { label: 'Google Business', bg: '#DCFCE7', color: '#166534' },
  blog: { label: 'Blog', bg: '#EDE9FE', color: '#5B21B6' },
}
function PlatformPill({ platform }) {
  const meta = PLATFORM_META[platform] || { label: platform || 'Unknown platform', bg: 'var(--chalk)', color: 'var(--steel)' }
  return (
    <span className="pill" style={{ background: meta.bg, color: meta.color, fontWeight: 800, flexShrink: 0 }}>
      {meta.label}
    </span>
  )
}

// A social post that references a blog (either explicitly linked via blog_id
// by approve-blog, or detected by these phrases in the copy) is
// "blog-dependent": it can't be approved until the blog it points to is live,
// or it would go out advertising a post that 404s.
const BLOG_KEYWORDS = ['blog', 'latest post', 'we wrote', 'read more']
const BLOG_WAIT_MESSAGE = 'Waiting for blog to publish before this post can be approved.'
function referencesBlog(item) {
  if (item.review_status === 'blog_dependent') return true
  const body = (item.body || '').toLowerCase()
  return BLOG_KEYWORDS.some((k) => body.includes(k))
}

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
  const [clients, setClients] = useState([])
  const [blogs, setBlogs] = useState([]) // mkt_blog_posts (id, client_id, status) — for blog-dependent gating
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState(null)
  const [draft, setDraft] = useState('')
  const [gen, setGen] = useState({ client_id: '', platform: 'facebook', pillar: '' })
  const [generating, setGenerating] = useState(false)
  const [notice, setNotice] = useState('')
  const [tab, setTab] = useState('posts') // 'posts' | 'graphics' | 'published' | 'rejected' — full queue view only
  const [published, setPublished] = useState([])
  const [publishedBrand, setPublishedBrand] = useState('all')
  const [graphics, setGraphics] = useState([])
  const [busyGraphicId, setBusyGraphicId] = useState(null)
  const [scheduleAt, setScheduleAt] = useState({}) // id -> datetime-local override
  const [selected, setSelected] = useState(new Set())
  const [bulkBusy, setBulkBusy] = useState(false)
  const [bulkProgress, setBulkProgress] = useState({ done: 0, total: 0 })
  const [rejectingItem, setRejectingItem] = useState(null)
  const [rejectReasonInput, setRejectReasonInput] = useState('')
  const [writingPost, setWritingPost] = useState(false)
  const [writeForm, setWriteForm] = useState({ client_id: '', platform: '', body: '', scheduled_date: '' })
  const [writeImageFile, setWriteImageFile] = useState(null)
  const [writeBusy, setWriteBusy] = useState(false)
  const [slotLoading, setSlotLoading] = useState(false)
  const [hiddenExpanded, setHiddenExpanded] = useState(false)

  async function load() {
    setLoading(true)
    const [q, c, p] = await Promise.all([
      // Soonest-scheduled first so the most urgent approvals surface at the
      // top; posts with no scheduled_for sort to the bottom (nullsFirst: false).
      supabase.from('mkt_content_queue').select('*, client:mkt_clients(short_name,name)').order('scheduled_for', { ascending: true, nullsFirst: false }),
      // connected_platforms drives the "Write a post" platform dropdown — it
      // is filtered to the platforms the selected brand actually has.
      supabase.from('mkt_clients').select('id, name, short_name, content_pillars, connected_platforms').eq('active', true).order('name'),
      // Published log — only rows whose send time has actually passed.
      supabase.from('published_posts').select('*').lte('date_sent', new Date().toISOString()).order('date_sent', { ascending: false }).limit(500),
    ])
    const g = await supabase.from('mkt_graphic_copy').select('*, client:mkt_clients(short_name,name)').order('week_of', { ascending: false })
    // Blog statuses drive the blog-dependent gate below; title is needed for
    // the Hidden posts section's "Waiting for [title] to publish" note.
    // Small table; fetch all.
    const b = await supabase.from('mkt_blog_posts').select('id, client_id, title, status, created_at').order('created_at', { ascending: false })
    let itemRows = q.data || []
    const blogRows = b.data || []

    // Hidden posts — a blog_dependent post whose linked (or client's most
    // recent) blog has since published is no longer actually dependent on
    // anything; release it back into the main approval queue by resetting
    // review_status to 'passed' (it already passed content review —
    // blog_dependent only ever gates on the blog, see blogGate below). Same
    // "no blog, or the blog is live → nothing to wait for" rule blogGate uses.
    const toRelease = itemRows.filter((i) => {
      if (i.status !== 'draft' || i.review_status !== 'blog_dependent') return false
      const blog = i.blog_id
        ? blogRows.find((b) => b.id === i.blog_id)
        : blogRows.filter((b) => b.client_id === i.client_id && b.status !== 'published')[0]
      return !blog || blog.status === 'published'
    })
    if (toRelease.length) {
      const releaseIds = toRelease.map((i) => i.id)
      const { error: releaseError } = await supabase.from('mkt_content_queue').update({ review_status: 'passed' }).in('id', releaseIds)
      if (!releaseError) {
        const releasedSet = new Set(releaseIds)
        itemRows = itemRows.map((i) => releasedSet.has(i.id) ? { ...i, review_status: 'passed' } : i)
      }
    }

    setItems(itemRows)
    setClients(c.data || [])
    setPublished(p.data || [])
    setGraphics(g.data || [])
    setBlogs(blogRows)
    if (c.data?.[0] && !gen.client_id) setGen((g) => ({ ...g, client_id: c.data[0].id }))
    setLoading(false)
  }
  useEffect(() => { load() }, [])

  // Canonical "awaiting approval" — see src/lib/awaitingApproval.js, which
  // Dashboard's headline count is built from too, so the two can no longer
  // disagree about what the same words mean.
  //
  // This list previously applied two silent exclusions on top of the
  // canonical definition: needs_attention/blog_dependent posts (never
  // rendered at all), and anything whose scheduled_for had already passed.
  // Both are still separated out — they genuinely warrant different visual
  // treatment — but as labelled sections WITHIN the same total rather than
  // as subtractions from it. A stale or failed post has not been dealt with;
  // dropping it from the count only made the work invisible.
  const now = new Date()
  const awaiting = partitionAwaiting(items, now)
  // The full canonical set, ordered so the actionable ones lead: clean posts
  // first, then ones that failed review, then blog-blocked, then stale.
  const pending = [
    ...awaiting.ready,
    ...awaiting.needsAttention,
    ...awaiting.blogDependent,
    ...awaiting.stale,
  ]
  // Was scoped to only overdue rows (scheduled_for < now). Scheduling to
  // Metricool happens once, synchronously, at the moment a post is approved
  // — there is no later cron sweep that retries it — so an approved post
  // with no metricool_post_id is stuck the same way whether its slot is
  // already overdue or still days away; there is no cron between now and
  // then that would fix it on its own. Rescheduling such a post to a future
  // date (the fix for the overdue case) used to pull it out of this filter
  // entirely, making it invisible everywhere in the UI. Unconditional on
  // scheduled_for now, so any approved-but-unscheduled row stays visible
  // regardless of date, for every brand.
  const failed = items.filter((i) => i.status === 'approved' && !i.metricool_post_id)
  const rejected = items.filter((i) => i.status === 'rejected')
  // Sourced from the shared partition rather than re-filtered locally. Note
  // this bucket was previously always empty — `pending` excluded
  // needs_attention entirely, so the "Reject all failed" toolbar button that
  // reads it could never render. Now that the canonical list includes them,
  // that button works as originally intended.
  const needsAttention = awaiting.needsAttention
  // Rejected posts must never clutter the main queue — they get their own
  // tab (below), not a spot in the default "Posts" list.
  const visibleItems = items.filter((i) => i.status !== 'rejected')

  // These drive the collapsible "Hidden posts" panel on the FULL queue view
  // (/content), where the main list is every non-rejected post and this panel
  // is the only place these two states get their own approve/reject controls.
  // They are no longer used on the approval queue view — there, the same posts
  // now appear inline as labelled sections of the canonical total, so keeping
  // the panel as well would render each of them twice on one screen.
  const hiddenNeedsAttention = awaiting.needsAttention
  const hiddenBlogDependent = awaiting.blogDependent

  // Find the blog a post depends on: the explicitly linked one (blog_id) if
  // present, otherwise the client's most recent not-yet-published blog (the
  // one a keyword-detected teaser is presumably waiting on). Uses loaded state
  // for rendering; approve() re-checks against the DB before acting.
  function relatedBlog(item) {
    if (item.blog_id) return blogs.find((b) => b.id === item.blog_id) || null
    return blogs.filter((b) => b.client_id === item.client_id && b.status !== 'published')[0] || null
  }
  // Render-time state: is this post blog-dependent, and is it currently blocked
  // (dependent + the blog isn't published yet)?
  function blogBlockState(item) {
    if (!referencesBlog(item)) return { dependent: false, blocked: false }
    const blog = relatedBlog(item)
    return { dependent: true, blocked: !!blog && blog.status !== 'published' }
  }
  // Authoritative gate used at approval time. Returns the wait message if the
  // post must not be approved yet, else null. Also durably marks a
  // keyword-detected post's review_status as blog_dependent so the queue
  // reflects the true state on the next load.
  async function blogGate(item) {
    if (!referencesBlog(item)) return null
    let blog = null
    if (item.blog_id) {
      const { data } = await supabase.from('mkt_blog_posts').select('id, status').eq('id', item.blog_id).maybeSingle()
      blog = data || null
    }
    if (!blog) {
      const { data } = await supabase.from('mkt_blog_posts').select('id, status')
        .eq('client_id', item.client_id).neq('status', 'published')
        .order('created_at', { ascending: false }).limit(1)
      blog = data?.[0] || null
    }
    // No blog, or the blog is live → nothing to wait for.
    if (!blog || blog.status === 'published') return null
    if (item.review_status !== 'blog_dependent') {
      await supabase.from('mkt_content_queue').update({ review_status: 'blog_dependent' }).eq('id', item.id)
      setItems((p) => p.map((i) => i.id === item.id ? { ...i, review_status: 'blog_dependent' } : i))
    }
    return BLOG_WAIT_MESSAGE
  }

  async function approve(item) {
    // Blog-dependent posts can't go out until their blog is live.
    const gate = await blogGate(item)
    if (gate) { setNotice(gate); return }
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
    // Best-effort ops-dashboard regen — the approval itself is already
    // confirmed above, so a failure here must never block or surface in the
    // approve UX, only in the console (see rejectAllFailed/bulkApprove for
    // the same pattern).
    supabase.functions.invoke('generate-daily-status').catch((e) => console.error('[generate-daily-status] regen failed:', e))
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
  function reject(item) {
    setRejectingItem(item)
    setRejectReasonInput('')
  }
  async function submitReject(reason) {
    const item = rejectingItem
    if (!item) return
    // Reason is optional — blank (or skipped entirely) falls back to a
    // default so there's always something for the daily rejected-posts email.
    const finalReason = (reason || '').trim() || 'Rejected by Adrian'
    const patch = { status: 'rejected', rejection_reason: finalReason, rejected_at: new Date().toISOString() }
    const { error } = await supabase.from('mkt_content_queue').update(patch).eq('id', item.id)
    setRejectingItem(null)
    if (error) { setNotice('Something went wrong — try again.'); return }
    setItems((p) => p.map((i) => i.id === item.id ? { ...i, ...patch } : i))
    // Best-effort ops-dashboard regen — see approve() above for why this is
    // fire-and-forget rather than awaited.
    supabase.functions.invoke('generate-daily-status').catch((e) => console.error('[generate-daily-status] regen failed:', e))
  }
  async function rejectAllFailed() {
    if (needsAttention.length === 0) return
    if (!window.confirm(`Reject all ${needsAttention.length} post${needsAttention.length === 1 ? '' : 's'} marked "needs attention"? This can't be undone.`)) return
    setBulkBusy(true); setBulkProgress({ done: 0, total: needsAttention.length }); setNotice('')
    const rejectedAt = new Date().toISOString()
    let failures = 0
    for (const item of needsAttention) {
      const { error } = await supabase.from('mkt_content_queue')
        .update({ status: 'rejected', rejection_reason: 'Rejected by Adrian', rejected_at: rejectedAt })
        .eq('id', item.id)
      if (error) failures++
      setBulkProgress((p) => ({ ...p, done: p.done + 1 }))
    }
    setBulkBusy(false)
    if (failures > 0) setNotice(`${failures} post${failures === 1 ? '' : 's'} failed to reject — try again.`)
    // Best-effort ops-dashboard regen — once for the whole batch, not once
    // per item (see approve() above for why this is fire-and-forget).
    supabase.functions.invoke('generate-daily-status').catch((e) => console.error('[generate-daily-status] regen failed:', e))
    load()
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
    let blocked = 0
    for (const id of ids) {
      const item = items.find((i) => i.id === id)
      // Skip blog-dependent posts whose blog isn't live yet — same gate as
      // single approve, so a bulk approve can't slip one through.
      if (item && await blogGate(item)) { blocked++; setBulkProgress((p) => ({ ...p, done: p.done + 1 })); continue }
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
    const notes = []
    if (failures > 0) notes.push(`${failures} post${failures === 1 ? '' : 's'} failed to schedule to Metricool — see "Failed to schedule" on the dashboard.`)
    if (blocked > 0) notes.push(`${blocked} blog-dependent post${blocked === 1 ? '' : 's'} skipped — ${BLOG_WAIT_MESSAGE.toLowerCase()}`)
    if (notes.length) setNotice(notes.join(' '))
    // Best-effort ops-dashboard regen — once for the whole batch, not once
    // per item (see approve() above for why this is fire-and-forget).
    supabase.functions.invoke('generate-daily-status').catch((e) => console.error('[generate-daily-status] regen failed:', e))
    load()
  }

  async function setGraphicStatus(g, status) {
    setBusyGraphicId(g.id); setNotice('')
    const { error } = await supabase.from('mkt_graphic_copy').update({ status }).eq('id', g.id)
    setBusyGraphicId(null)
    if (error) { setNotice('Something went wrong — try again.'); return }
    setGraphics((prev) => prev.map((x) => x.id === g.id ? { ...x, status } : x))
  }

  // Platforms this brand has actually connected — the dropdown is filtered to
  // these, and create-manual-post enforces the same rule server-side.
  function platformsFor(clientId) {
    const c = clients.find((x) => x.id === clientId)
    return Array.isArray(c?.connected_platforms) ? c.connected_platforms : []
  }

  // Asks create-manual-post for the brand/platform's next available posting
  // slot and pre-populates the date picker with it. Resolved server-side so
  // the default date comes from exactly the same schedule logic that the
  // displacement and the cron use — not a second implementation in the UI.
  async function loadNextSlot(clientId, platform) {
    if (!clientId || !platform) { setWriteForm((f) => ({ ...f, scheduled_date: '' })); return }
    setSlotLoading(true)
    const { data, error } = await supabase.functions.invoke('create-manual-post', {
      body: { action: 'next_slot', client_id: clientId, platform },
    })
    setSlotLoading(false)
    if (error || data?.error || !data?.next_slot) {
      // Leave the picker empty rather than guessing a date — the user can
      // still choose one, and submitting without a date is blocked below.
      setWriteForm((f) => ({ ...f, scheduled_date: '' }))
      return
    }
    setWriteForm((f) => ({ ...f, scheduled_date: data.next_slot }))
  }

  function openWritePost() {
    const firstClient = clients[0]
    const firstPlatform = (Array.isArray(firstClient?.connected_platforms) ? firstClient.connected_platforms : [])[0] || ''
    setWriteForm({ client_id: firstClient?.id || '', platform: firstPlatform, body: '', scheduled_date: '' })
    setWriteImageFile(null)
    setWritingPost(true)
    if (firstClient?.id && firstPlatform) loadNextSlot(firstClient.id, firstPlatform)
  }

  // Brand change resets the platform to that brand's first connected one (the
  // previous selection may not exist for the new brand) and re-resolves the
  // default date for the new pairing.
  function onWriteBrandChange(clientId) {
    const nextPlatform = platformsFor(clientId)[0] || ''
    setWriteForm((f) => ({ ...f, client_id: clientId, platform: nextPlatform }))
    loadNextSlot(clientId, nextPlatform)
  }
  function onWritePlatformChange(platform) {
    setWriteForm((f) => ({ ...f, platform }))
    loadNextSlot(writeForm.client_id, platform)
  }
  function fileToBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(String(reader.result).split(',')[1] || '')
      reader.onerror = reject
      reader.readAsDataURL(file)
    })
  }
  // 'YYYY-MM-DD' -> "Tue 5 August" for the confirmation message.
  function prettyDate(ymd) {
    const [y, m, d] = String(ymd || '').split('-').map(Number)
    if (!y || !m || !d) return ymd
    return new Date(y, m - 1, d).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'long' })
  }

  async function submitWritePost() {
    if (!writeForm.client_id || !writeForm.platform) { setNotice('Pick a brand and a platform first.'); return }
    if (!writeForm.body.trim()) { setNotice('Write the post copy first.'); return }
    if (!writeForm.scheduled_date) { setNotice('Pick a date to schedule this post for.'); return }
    setWriteBusy(true); setNotice('')
    let image_base64, image_content_type
    if (writeImageFile) {
      try {
        image_base64 = await fileToBase64(writeImageFile)
        image_content_type = writeImageFile.type
      } catch {
        setNotice('Could not read the image file — try a different one, or leave it blank.')
        setWriteBusy(false)
        return
      }
    }
    const { data, error } = await supabase.functions.invoke('create-manual-post', {
      body: {
        client_id: writeForm.client_id, platform: writeForm.platform, body: writeForm.body,
        scheduled_date: writeForm.scheduled_date, image_base64, image_content_type,
      },
    })
    if (error || data?.error) {
      setWriteBusy(false)
      setNotice(data?.error || error?.message || 'Could not write that post — try again.')
      return
    }

    // The post is inserted already approved, but nothing sweeps approved rows
    // to Metricool — approve() in this same file pushes on approval for
    // exactly this reason, so a manual post has to do the same or it would
    // never actually send. The displaced post only needs re-pushing if it was
    // already live on Metricool, since its send time has now changed.
    const schedulingErrors = []
    const { data: schedData, error: schedErr } = await supabase.functions.invoke('schedule-to-metricool', {
      body: { content_queue_id: data.item.id },
    })
    if (schedErr || schedData?.error) schedulingErrors.push(schedData?.error || schedErr?.message || 'unknown error')
    if (data.displaced?.had_metricool_post) {
      const { data: dData, error: dErr } = await supabase.functions.invoke('schedule-to-metricool', {
        body: { content_queue_id: data.displaced.id },
      })
      if (dErr || dData?.error) schedulingErrors.push(`moved post: ${dData?.error || dErr?.message || 'unknown error'}`)
    }

    setWriteBusy(false)
    setWritingPost(false)
    const base = data.displaced
      ? `Post scheduled for ${prettyDate(data.scheduled_date)}. Previous post moved to ${prettyDate(data.displaced.new_date)}.`
      : `Post scheduled for ${prettyDate(data.scheduled_date)}.`
    setNotice(schedulingErrors.length
      ? `${base} Scheduling to Metricool failed: ${schedulingErrors.join('; ')}`
      : base)
    load()
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
                    {item.scheduled_for && <span style={{ marginLeft: 8 }}>· was due {ukDate(item.scheduled_for, { day: 'numeric', month: 'short' })}</span>}
                  </div>
                </div>
                <span className="pill" style={{ background: '#FEE2E2', color: '#991B1B', flexShrink: 0 }}>failed</span>
              </div>
              {item.error_message && (
                <p style={{ fontSize: 12, color: '#991B1B', background: '#FEF2F2', border: '1px solid #FEE2E2', borderRadius: 6, padding: '8px 10px', marginBottom: 10 }}>
                  {item.error_message}
                </p>
              )}
              <p style={{ fontSize: 14, lineHeight: 1.6, whiteSpace: 'pre-wrap', overflowWrap: 'break-word', marginBottom: 12 }}>{item.body}</p>
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
              {needsAttention.length > 0 && (
                <button className="btn btn-ghost btn-sm" style={{ color: 'var(--red)' }} disabled={bulkBusy} onClick={rejectAllFailed}>
                  {bulkBusy ? `Rejecting ${bulkProgress.done}/${bulkProgress.total}…` : `Reject all failed (${needsAttention.length})`}
                </button>
              )}
            </div>

            <div style={{ marginTop: 12 }}>
              {pending.map((item, idx) => {
                const blk = blogBlockState(item)
                // `pending` is pre-sorted by bucket (see partitionAwaiting
                // above), so a change of bucket between consecutive items is
                // exactly a section boundary — no separate grouping pass and
                // no second source of truth about which section an item is in.
                const bucket = awaitingBucket(item, now)
                const showHeader = idx === 0 || bucket !== awaitingBucket(pending[idx - 1], now)
                const meta = AWAITING_SECTION_META[bucket]
                const bucketCount = pending.filter((p) => awaitingBucket(p, now) === bucket).length
                return (
                <Fragment key={item.id}>
                {showHeader && meta && (
                  <div style={{ marginTop: idx === 0 ? 0 : 22, marginBottom: 8 }}>
                    <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--ink)' }}>
                      {meta.label} <span style={{ fontWeight: 500, color: 'var(--muted)' }}>({bucketCount})</span>
                    </div>
                    <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>{meta.hint}</div>
                  </div>
                )}
                <div className="card" style={{ marginBottom: 12, display: 'flex', gap: 10 }}>
                  <input type="checkbox" checked={selected.has(item.id)} onChange={() => toggleSelect(item.id)} style={{ marginTop: 4 }} />
                  {/* minWidth: 0 overrides the flex item's default auto min-width
                      (which otherwise floors at the content's un-wrapped intrinsic
                      width) — without it, a long unbroken string like a URL could
                      still push this column wider than the card, even with
                      overflow-wrap set on the paragraph itself. */}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
                      <div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2 }}>
                          <span style={{ fontSize: 13, fontWeight: 800 }}>
                            {item.client?.short_name || item.client?.name}
                          </span>
                          <PlatformPill platform={item.platform} />
                        </div>
                        <div style={{ fontSize: 11, color: 'var(--mist)' }}>
                          {item.pillar}
                          {item.scheduled_for && (
                            <span style={{ marginLeft: item.pillar ? 8 : 0 }}>
                              {item.pillar ? '· ' : ''}{ukDate(item.scheduled_for, { weekday: 'short', day: 'numeric', month: 'short' })}
                              {' at '}
                              {ukTime(item.scheduled_for)}
                            </span>
                          )}
                        </div>
                      </div>
                      {/* flexWrap here (plus flexWrap on the row above) is the fix for
                          the badge-row overflow bug: without it this group of up to 4
                          pills refuses to shrink below its unwrapped width — same
                          min-width/flex-shrink flex-item gotcha as the body-text fix
                          above, just on a nested flex container instead of a <p>. */}
                      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', minWidth: 0 }}>
                        {item.review_status === 'passed' && (
                          <span className="pill" title={item.reviewed_at ? `Reviewed ${ukDateTime(item.reviewed_at)}` : 'Reviewed'}
                            style={{ background: '#DCFCE7', color: '#166534' }}>✓ Reviewed</span>
                        )}
                        {item.review_status === 'needs_attention' && (
                          <span className="pill" style={{ background: '#FEE2E2', color: '#991B1B' }}>Needs attention</span>
                        )}
                        {blk.dependent && (
                          <span className="pill" title={blk.blocked ? BLOG_WAIT_MESSAGE : 'References a blog — its post is published.'}
                            style={{ background: blk.blocked ? '#E0E7FF' : '#DCFCE7', color: blk.blocked ? '#3730A3' : '#166534' }}>
                            {blk.blocked ? '⏳ Waiting for blog' : '✓ Blog live'}
                          </span>
                        )}
                        {/* Task 2 — any pending post with no review timestamp never
                            went through _shared/review.ts. Flag it distinctly (amber
                            with a border) rather than letting it read as a normal
                            reviewed-pending post. Gated on review_status !== 'passed'
                            too — some rows carry review_status='passed' with a null
                            reviewed_at (backfilled/legacy), and reviewed_at alone used
                            to show this badge even then, contradicting the green
                            Reviewed badge above (which is keyed on review_status). Only
                            one of the two should ever show for a given post. */}
                        {!item.reviewed_at && item.review_status !== 'passed' && (
                          <span className="pill" title="Queued without an automated review — reviewed_at is null."
                            style={{ background: '#FEF3C7', color: '#92400E', border: '1px solid #F59E0B' }}>⚠ Unreviewed</span>
                        )}
                        <span className="pill" style={{ background: '#FEF3C7', color: '#92400E' }}>pending</span>
                      </div>
                    </div>

                    {!item.reviewed_at && item.review_status !== 'passed' && (
                      <p style={{ fontSize: 12, color: '#92400E', background: '#FFFBEB', border: '1px solid #FDE68A', borderRadius: 6, padding: '8px 10px', marginBottom: 10 }}>
                        This post has not been through the automated review — it was queued before the review step existed. Read it carefully before approving.
                      </p>
                    )}

                    {item.review_status === 'needs_attention' && item.review_reason && (
                      <p style={{ fontSize: 12, color: '#991B1B', background: '#FEF2F2', border: '1px solid #FEE2E2', borderRadius: 6, padding: '8px 10px', marginBottom: 10 }}>
                        Review failed twice — {item.review_reason}. Edit and approve manually, or reject.
                      </p>
                    )}

                    {blk.blocked && (
                      <p style={{ fontSize: 12, color: '#3730A3', background: '#EEF2FF', border: '1px solid #C7D2FE', borderRadius: 6, padding: '8px 10px', marginBottom: 10 }}>
                        {BLOG_WAIT_MESSAGE}
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
                        <PostImage item={item} />
                        <p style={{ fontSize: 14, lineHeight: 1.6, whiteSpace: 'pre-wrap', overflowWrap: 'break-word', marginBottom: 12 }}>{item.body}</p>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
                          <label style={{ fontSize: 12, color: 'var(--mist)' }}>Send at</label>
                          <input type="datetime-local" className="input" style={{ width: 'auto', fontSize: 13, padding: '6px 8px' }}
                            value={scheduleAt[item.id] ?? toLocalInput(item.scheduled_for)}
                            onChange={(e) => setScheduleAt((s) => ({ ...s, [item.id]: e.target.value }))} />
                        </div>
                        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                          <button className="btn btn-primary btn-sm" style={{ flex: 1 }} disabled={blk.blocked}
                            title={blk.blocked ? BLOG_WAIT_MESSAGE : undefined} onClick={() => approve(item)}>
                            {blk.blocked ? 'Waiting for blog' : 'Approve & schedule'}
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
                </Fragment>
              ) })}
            </div>
          </>
        )}

        {/* The "Hidden posts" panel deliberately isn't rendered here any more:
            needs_attention and blog_dependent posts are now part of the
            canonical awaiting-approval list above, each under its own labelled
            section, so this panel would show every one of them a second time
            on the same screen. It still renders on the full queue view
            (/content), where it remains the only place those posts get their
            own approve/reject controls. */}

        <RejectModal item={rejectingItem} reason={rejectReasonInput} setReason={setRejectReasonInput}
          onCancel={() => setRejectingItem(null)} onSubmit={submitReject} />
      </div>
    )
  }

  // ── Full queue view (/content) ───────────────────────────────────────────────
  return (
    <div className="page">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
        <div>
          <h1>Content queue</h1>
          <p className="page-sub">{pending.length === 0 ? 'Nothing waiting for approval.' : `${pending.length} waiting for approval.`}</p>
        </div>
        <button className="btn btn-primary btn-sm" style={{ flexShrink: 0 }} onClick={openWritePost}>Write a post</button>
      </div>

      <div style={{ display: 'flex', gap: 8, marginTop: 16, marginBottom: 4 }}>
        <button className={'btn btn-sm ' + (tab === 'posts' ? 'btn-primary' : 'btn-ghost')} onClick={() => setTab('posts')}>Posts</button>
        <button className={'btn btn-sm ' + (tab === 'graphics' ? 'btn-primary' : 'btn-ghost')} onClick={() => setTab('graphics')}>Graphics</button>
        <button className={'btn btn-sm ' + (tab === 'published' ? 'btn-primary' : 'btn-ghost')} onClick={() => setTab('published')}>Published</button>
        <button className={'btn btn-sm ' + (tab === 'rejected' ? 'btn-primary' : 'btn-ghost')} onClick={() => setTab('rejected')}>Rejected{rejected.length > 0 ? ` (${rejected.length})` : ''}</button>
      </div>

      {notice && <p style={{ color: 'var(--ember)', fontSize: 13, marginTop: 8 }}>{notice}</p>}

      {tab === 'graphics' ? (
        <GraphicsTab graphics={graphics} busyId={busyGraphicId} onApprove={(g) => setGraphicStatus(g, 'approved')} onReject={(g) => setGraphicStatus(g, 'rejected')} />
      ) : tab === 'published' ? (
        <PublishedTab published={published} brand={publishedBrand} setBrand={setPublishedBrand} />
      ) : tab === 'rejected' ? (
        <RejectedTab rejected={rejected} />
      ) : (
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

          {/* Fix 3 — this is the nav's actual "Content" tab (the default
              /content view); the Hidden posts toggle previously only
              existed on the separate /content?status=draft "Awaiting
              approval" view, so needs_attention/blog_dependent counts were
              invisible from here. Same data, same toggle component, same
              collapsed-by-default behaviour — just rendered here too. */}
          <HiddenPostsSection
            expanded={hiddenExpanded} onToggle={() => setHiddenExpanded((e) => !e)}
            needsAttention={hiddenNeedsAttention} blogDependent={hiddenBlogDependent}
            relatedBlog={relatedBlog} onApprove={approve} onReject={reject}
          />

          <div style={{ marginTop: 18 }}>
            {visibleItems.length === 0 ? <p className="empty">Nothing here yet. Generate your first post above.</p> : visibleItems.map((item) => (
              <div key={item.id} className="card" style={{ marginBottom: 12 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8, flexWrap: 'wrap', gap: 6 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--mist)' }}>
                      {item.client?.short_name || item.client?.name}{item.pillar ? ` · ${item.pillar}` : ''}
                    </span>
                    <PlatformPill platform={item.platform} />
                  </div>
                  <span className="pill" style={{ background: 'var(--chalk)', color: 'var(--steel)' }}>{item.status}</span>
                </div>

                {editing === item.id ? (
                  <textarea className="input" rows={4} value={draft} onChange={(e) => setDraft(e.target.value)} />
                ) : (
                  <>
                    <PostImage item={item} />
                    <p style={{ fontSize: 14, lineHeight: 1.5, whiteSpace: 'pre-wrap', overflowWrap: 'break-word' }}>{item.body}</p>
                  </>
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
      )}
      <RejectModal item={rejectingItem} reason={rejectReasonInput} setReason={setRejectReasonInput}
        onCancel={() => setRejectingItem(null)} onSubmit={submitReject} />
      <WritePostModal open={writingPost} clients={clients} form={writeForm} setForm={setWriteForm}
        platforms={platformsFor(writeForm.client_id)} slotLoading={slotLoading}
        onBrandChange={onWriteBrandChange} onPlatformChange={onWritePlatformChange}
        imageFile={writeImageFile} setImageFile={setWriteImageFile} busy={writeBusy}
        onCancel={() => setWritingPost(false)} onSubmit={submitWritePost} />
    </div>
  )
}

// "Write a post" — manual post creation. Brand, platform (filtered to that
// brand's connected platforms), copy, scheduled date, optional image.
//
// The date defaults to the brand/platform's next available posting slot,
// resolved server-side by create-manual-post so it comes from exactly the
// same schedule logic the cron and the displacement use. Picking a date that
// already holds a cron-generated post displaces that post forward — handled
// entirely in the edge function; this is just the form.
function WritePostModal({ open, clients, form, setForm, platforms, slotLoading, onBrandChange, onPlatformChange, imageFile, setImageFile, busy, onCancel, onSubmit }) {
  if (!open) return null
  const noPlatforms = platforms.length === 0
  return (
    <div className="modal-bg" onClick={(e) => { if (e.target === e.currentTarget) onCancel() }}>
      <div className="modal">
        <h2 style={{ fontSize: 18, marginBottom: 14 }}>Write a post</h2>
        <div className="grid grid-2" style={{ marginBottom: 12 }}>
          <div className="field"><label>Brand</label>
            <select className="input" value={form.client_id} onChange={(e) => onBrandChange(e.target.value)}>
              {clients.map((c) => <option key={c.id} value={c.id}>{c.short_name || c.name}</option>)}
            </select>
          </div>
          <div className="field"><label>Platform</label>
            <select className="input" value={form.platform} disabled={noPlatforms}
              onChange={(e) => onPlatformChange(e.target.value)}>
              {noPlatforms
                ? <option value="">No connected platforms</option>
                : platforms.map((p) => (
                    <option key={p} value={p}>{PLATFORM_META[p]?.label || p.replace('_', ' ')}</option>
                  ))}
            </select>
          </div>
        </div>
        {noPlatforms && (
          <p style={{ fontSize: 12, color: '#92400E', background: '#FFFBEB', border: '1px solid #FDE68A', borderRadius: 6, padding: '8px 10px', marginBottom: 12 }}>
            This brand has no connected platforms, so a post can't be scheduled for it.
          </p>
        )}
        <div className="field" style={{ marginBottom: 12 }}>
          <label>Copy</label>
          <textarea className="input" rows={5} value={form.body} onChange={(e) => setForm((f) => ({ ...f, body: e.target.value }))} />
        </div>
        <div className="field" style={{ marginBottom: 12 }}>
          <label>Scheduled date{slotLoading ? ' — finding next slot…' : ''}</label>
          <input type="date" className="input" value={form.scheduled_date} disabled={slotLoading}
            onChange={(e) => setForm((f) => ({ ...f, scheduled_date: e.target.value }))} />
          <div style={{ fontSize: 11, color: 'var(--mist)', marginTop: 4 }}>
            Defaults to this brand's next free slot. Choosing a date that already has a scheduled post moves that post to the next free slot.
          </div>
        </div>
        <div className="field" style={{ marginBottom: 16 }}>
          <label>Image (optional)</label>
          <input type="file" accept="image/*" onChange={(e) => setImageFile(e.target.files?.[0] || null)} />
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button className="btn btn-ghost" onClick={onCancel} disabled={busy}>Cancel</button>
          <button className="btn btn-primary" style={{ flex: 1 }} onClick={onSubmit} disabled={busy || noPlatforms}>
            {busy ? 'Scheduling…' : 'Schedule post'}
          </button>
        </div>
      </div>
    </div>
  )
}

// The image fill.ts generates alongside each post (see _shared/image.ts),
// shown next to the copy in every place the queue renders a post. A null
// image_url isn't an error state to hide — it's flagged so Adrian knows to
// add one manually rather than approving a post that will go out bare.
function PostImage({ item }) {
  if (item.content_type && item.content_type !== 'post') return null
  if (item.image_url) {
    return (
      <img src={item.image_url} alt="" style={{ width: '100%', maxWidth: 320, borderRadius: 8, display: 'block', marginBottom: 12 }} />
    )
  }
  return (
    <div style={{
      fontSize: 12, color: '#92400E', background: '#FFFBEB', border: '1px dashed #F59E0B',
      borderRadius: 8, padding: '10px 12px', marginBottom: 12, maxWidth: 320,
    }}>
      Image missing — add manually
    </div>
  )
}

// Reject flow — reason is optional (defaults to "Rejected by Adrian" if left
// blank), so a fast bulk-reject session doesn't require typing anything.
// "Skip & reject" is the explicit no-typing path; "Reject" uses whatever's
// in the textarea, falling back to the same default if it's empty too.
function RejectModal({ item, reason, setReason, onCancel, onSubmit }) {
  if (!item) return null
  return (
    <div className="modal-bg" onClick={(e) => { if (e.target === e.currentTarget) onCancel() }}>
      <div className="modal">
        <h2 style={{ fontSize: 18, marginBottom: 4 }}>Reject post</h2>
        <p className="muted" style={{ fontSize: 13, marginBottom: 14 }}>{item.client?.short_name || item.client?.name}</p>
        <div className="field">
          <label>Reason (optional)</label>
          <textarea className="input" rows={3} value={reason} onChange={(e) => setReason(e.target.value)}
            placeholder="Shows in the daily rejected-posts email — leave blank to skip." />
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

// Hidden posts — needs_attention and blog_dependent drafts that the main
// approval queue deliberately never renders (see the `pending` filter
// above). Collapsed by default; the toggle always shows the count so a
// backlog here isn't invisible. Auto-release for blog_dependent posts
// happens in load() (their blog has published — they're filtered out of
// `blogDependent` before it ever reaches this component), so everything
// rendered here is still genuinely waiting on something.
function HiddenPostsSection({ expanded, onToggle, needsAttention, blogDependent, relatedBlog, onApprove, onReject }) {
  const total = needsAttention.length + blogDependent.length
  if (total === 0) return null
  return (
    <div style={{ marginTop: 24 }}>
      <button className="btn btn-ghost btn-sm" onClick={onToggle} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span>{expanded ? '▾' : '▸'}</span>
        <span>Hidden ({total})</span>
      </button>

      {expanded && (
        <div style={{ marginTop: 12 }}>
          {needsAttention.map((item) => (
            <div key={item.id} className="card" style={{ marginBottom: 12 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8, marginBottom: 10 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ fontSize: 13, fontWeight: 800 }}>{item.client?.short_name || item.client?.name}</span>
                  <PlatformPill platform={item.platform} />
                </div>
                <span className="pill" style={{ background: '#FEE2E2', color: '#991B1B', flexShrink: 0 }}>Needs attention</span>
              </div>
              <p style={{ fontSize: 12, color: '#991B1B', background: '#FEF2F2', border: '1px solid #FEE2E2', borderRadius: 6, padding: '8px 10px', marginBottom: 10 }}>
                {item.review_reason || 'Automated review failed — no reason recorded.'}
              </p>
              <p style={{ fontSize: 14, lineHeight: 1.6, whiteSpace: 'pre-wrap', overflowWrap: 'break-word', marginBottom: 12 }}>{item.body}</p>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <button className="btn btn-primary btn-sm" style={{ flex: 1 }} onClick={() => onApprove(item)}>Approve anyway</button>
                <button className="btn btn-ghost btn-sm" style={{ color: 'var(--red)' }} onClick={() => onReject(item)}>Reject</button>
              </div>
            </div>
          ))}

          {blogDependent.map((item) => {
            const blog = relatedBlog(item)
            return (
              <div key={item.id} className="card" style={{ marginBottom: 12 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8, marginBottom: 10 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span style={{ fontSize: 13, fontWeight: 800 }}>{item.client?.short_name || item.client?.name}</span>
                    <PlatformPill platform={item.platform} />
                  </div>
                  <span className="pill" style={{ background: '#E0E7FF', color: '#3730A3', flexShrink: 0 }}>⏳ Waiting for blog</span>
                </div>
                <p style={{ fontSize: 12, color: '#3730A3', background: '#EEF2FF', border: '1px solid #C7D2FE', borderRadius: 6, padding: '8px 10px', marginBottom: 10 }}>
                  Waiting for {blog?.title ? `"${blog.title}"` : 'its blog'} to publish.
                </p>
                <p style={{ fontSize: 14, lineHeight: 1.6, whiteSpace: 'pre-wrap', overflowWrap: 'break-word', margin: 0 }}>{item.body}</p>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

// Rejected posts get their own tab rather than sitting in the main queue —
// the log still exists (and feeds the daily email digest), it just doesn't
// clutter the default view. Shows the reason captured at reject time.
function RejectedTab({ rejected }) {
  if (rejected.length === 0) return <p className="empty" style={{ marginTop: 16 }}>Nothing rejected.</p>
  return (
    <div style={{ marginTop: 12 }}>
      {rejected.map((item) => (
        <div key={item.id} className="card" style={{ marginBottom: 12 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--mist)', textTransform: 'capitalize' }}>
              {item.client?.short_name || item.client?.name} · {item.platform}{item.pillar ? ` · ${item.pillar}` : ''}
            </div>
            <span className="pill" style={{ background: '#FEE2E2', color: '#991B1B' }}>rejected</span>
          </div>
          {item.rejected_at && (
            <div style={{ fontSize: 11, color: 'var(--mist)', marginBottom: 8 }}>
              Rejected {ukDate(item.rejected_at, { day: 'numeric', month: 'short', year: 'numeric' })}
            </div>
          )}
          <p style={{ fontSize: 14, lineHeight: 1.5, whiteSpace: 'pre-wrap', overflowWrap: 'break-word', marginBottom: 10 }}>{item.body}</p>
          <p style={{ fontSize: 12, color: '#991B1B', background: '#FEF2F2', border: '1px solid #FEE2E2', borderRadius: 6, padding: '8px 10px', margin: 0 }}>
            {item.rejection_reason || 'No reason given.'}
          </p>
        </div>
      ))}
    </div>
  )
}

// Item 4 — Published tab. Shows what has actually gone out (published_posts,
// filtered server-side to date_sent <= now), with brand / date / platform /
// first 100 chars of the copy, filterable by brand. Vertical card list —
// same layout as Posts/Rejected — not the old horizontally-scrolling table.
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
      ) : rows.map((p) => (
        <div key={p.id} className="card" style={{ marginBottom: 12 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--mist)', textTransform: 'capitalize' }}>
              {p.brand} · {String(p.platform).replace('_', ' ')}
            </div>
            <span className="pill" style={{ background: 'var(--chalk)', color: 'var(--steel)' }}>
              {ukDate(p.date_sent, { day: 'numeric', month: 'short', year: 'numeric' })}
            </span>
          </div>
          <p style={{ fontSize: 14, lineHeight: 1.5, whiteSpace: 'pre-wrap', overflowWrap: 'break-word', margin: 0 }}>
            {String(p.post_copy || '').slice(0, 100)}{String(p.post_copy || '').length > 100 ? '…' : ''}
          </p>
        </div>
      ))}
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
                Graphic — week of {ukDate(g.week_of, { day: 'numeric', month: 'short' })}
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
