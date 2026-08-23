// Releases mkt_content_queue rows stuck in review_status='blog_dependent'
// once the blog they actually depend on has published.
//
// Confirmed real incident (21 Aug 2026): approve-blog stamps a blog's 3
// AI-repurposed social posts with review_status='blog_dependent' at
// creation time, and the ONLY release path was client-side, inside
// ContentQueue.jsx's load() — it only ever ran if a human happened to have
// that specific admin page open. 4 real posts (Hormonely, Once Upon A You)
// sat blocked for weeks pointing at blogs that had already published, with
// nothing anywhere surfacing that the wait condition was already met.
// Manually rejected as a one-off cleanup before this fix landed — there was
// no backlog left to migrate.
//
// This is shared by two callers so the release condition lives in exactly
// one place and can't drift between them:
//   - publish-approved-blog calls releaseForClient() right after a blog's
//     status flips to 'published' — the real-time trigger, resolves the
//     common case within the same request.
//   - sweep-blog-dependent-posts calls releaseAll() on a schedule — the
//     backstop for a blog published through any other path (steady/manual
//     branches, a future code path, direct SQL), or for anything the
//     real-time hook missed for any reason.
//
// Release condition mirrors ContentQueue.jsx's pre-existing client-side
// logic exactly, not a reinvention of it: a draft, blog_dependent post is
// released (review_status -> 'passed', it already passed content review —
// blog_dependent only ever gated on the blog) once the blog it's waiting on
// is published. A post's blog_id, if set, must name that exact blog;
// otherwise (no blog_id) it falls back to the client's most-recently-created
// blog that isn't published — if that blog is the one just published, or
// there's no such blog left at all, the post is released.

// deno-lint-ignore no-explicit-any
type Admin = any

interface BlogRow {
  id: string
  client_id: string
  status: string
  created_at: string
}

interface QueueRow {
  id: string
  blog_id: string | null
}

// Why a post is no longer waiting, or that it still is. A blog only ever
// leaves the queue two ways — it publishes, or it is rejected — and until
// 22 Aug 2026 only the first was handled, so a post whose blog was REJECTED
// waited forever for something that could never happen. See the rejected
// branch below.
type Outcome = 'pass' | 'attention' | 'wait'

function outcomeFor(blog: BlogRow | null): Outcome {
  if (!blog) return 'pass'                      // nothing to wait on at all
  if (blog.status === 'published') return 'pass' // the thing it waited for happened
  if (blog.status === 'rejected') return 'attention' // it will never happen
  return 'wait'                                  // genuinely still in the queue
}

export const REJECTED_BLOG_REASON =
  'The blog this post references was rejected, so it will never publish. Decide whether to rewrite this post without the reference, or reject it.'

async function releaseForBlogs(
  admin: Admin,
  clientId: string,
  blogs: BlogRow[],
): Promise<{ released: number; ids: string[]; flagged: number; flaggedIds: string[] }> {
  const empty = { released: 0, ids: [] as string[], flagged: 0, flaggedIds: [] as string[] }
  const { data: pending, error: pErr } = await admin
    .from('mkt_content_queue')
    .select('id, blog_id')
    .eq('client_id', clientId)
    .eq('status', 'draft')
    .eq('review_status', 'blog_dependent')
  if (pErr) throw new Error(`load pending blog_dependent rows for client ${clientId}: ${pErr.message}`)
  if (!pending?.length) return empty

  const byId = new Map(blogs.map((b) => [b.id, b]))
  // blogs is expected newest-first (created_at desc) — same ordering
  // ContentQueue.jsx's query uses, so this fallback picks the same blog it
  // would have.
  //
  // Deliberately NOT narrowed to exclude rejected blogs. A post with no
  // blog_id is a keyword-detected teaser pinned to whatever was outstanding
  // when it was written; if that blog was then rejected, the teaser is
  // referencing something that will never exist and a human needs to see it.
  // Narrowing this to "genuinely pending only" would resolve such a post to
  // null and silently mark it 'passed' — publishing a teaser for a blog that
  // does not exist, which is worse than the stuck state being fixed here.
  const mostRecentUnpublished = blogs.find((b) => b.status !== 'published') ?? null

  const ids: string[] = []
  const flaggedIds: string[] = []
  for (const row of pending as QueueRow[]) {
    const blog = row.blog_id ? byId.get(row.blog_id) ?? null : mostRecentUnpublished
    const outcome = outcomeFor(blog)
    if (outcome === 'pass') ids.push(row.id)
    else if (outcome === 'attention') flaggedIds.push(row.id)
    // 'wait' — the blog is genuinely still in the approval queue, leave it.
  }

  if (ids.length) {
    // It already passed content review — blog_dependent only ever gated on
    // the blog — so it goes straight back into the normal approval queue.
    const { error: uErr } = await admin.from('mkt_content_queue').update({ review_status: 'passed' }).in('id', ids)
    if (uErr) throw new Error(`release blog_dependent rows for client ${clientId}: ${uErr.message}`)
  }

  if (flaggedIds.length) {
    // NOT 'passed': the post's own copy references a blog that will never
    // exist, so approving it unchanged would publish a dead reference. A
    // human decides whether to rewrite or reject — which is exactly what
    // needs_attention already means everywhere else in this queue.
    const { error: fErr } = await admin
      .from('mkt_content_queue')
      .update({ review_status: 'needs_attention', review_reason: REJECTED_BLOG_REASON })
      .in('id', flaggedIds)
    if (fErr) throw new Error(`flag rejected-blog rows for client ${clientId}: ${fErr.message}`)
  }

  return { released: ids.length, ids, flagged: flaggedIds.length, flaggedIds }
}

// Scoped to one client — the cheap, real-time path called right after a
// specific blog publishes. Fetches only that client's blogs.
export async function releaseForClient(
  admin: Admin,
  clientId: string,
): Promise<{ released: number; ids: string[]; flagged: number; flaggedIds: string[] }> {
  const { data: blogs, error: bErr } = await admin
    .from('mkt_blog_posts')
    .select('id, client_id, status, created_at')
    .eq('client_id', clientId)
    .order('created_at', { ascending: false })
  if (bErr) throw new Error(`load blogs for client ${clientId}: ${bErr.message}`)
  return releaseForBlogs(admin, clientId, (blogs || []) as BlogRow[])
}

// Unscoped — the periodic sweep's backstop path. One query for every blog
// across every client, grouped client-side, so this is a fixed two queries
// total regardless of how many clients have blog_dependent posts.
export async function releaseAll(admin: Admin): Promise<{
  released: number
  byClient: Record<string, number>
  flagged: number
  flaggedByClient: Record<string, number>
}> {
  const { data: pendingClients, error: pcErr } = await admin
    .from('mkt_content_queue')
    .select('client_id')
    .eq('status', 'draft')
    .eq('review_status', 'blog_dependent')
  if (pcErr) throw new Error(`load blog_dependent client list: ${pcErr.message}`)
  const clientIds: string[] = Array.from(new Set((pendingClients || []).map((r: { client_id: string }) => r.client_id)))
  if (!clientIds.length) return { released: 0, byClient: {}, flagged: 0, flaggedByClient: {} }

  const { data: blogs, error: bErr } = await admin
    .from('mkt_blog_posts')
    .select('id, client_id, status, created_at')
    .in('client_id', clientIds)
    .order('created_at', { ascending: false })
  if (bErr) throw new Error(`load blogs for sweep: ${bErr.message}`)
  const blogsByClient = new Map<string, BlogRow[]>()
  for (const b of (blogs || []) as BlogRow[]) {
    const list = blogsByClient.get(b.client_id) ?? []
    list.push(b)
    blogsByClient.set(b.client_id, list)
  }

  let released = 0
  let flagged = 0
  const byClient: Record<string, number> = {}
  const flaggedByClient: Record<string, number> = {}
  for (const clientId of clientIds) {
    const result = await releaseForBlogs(admin, clientId, blogsByClient.get(clientId) ?? [])
    if (result.released) {
      released += result.released
      byClient[clientId] = result.released
    }
    if (result.flagged) {
      flagged += result.flagged
      flaggedByClient[clientId] = result.flagged
    }
  }
  return { released, byClient, flagged, flaggedByClient }
}
