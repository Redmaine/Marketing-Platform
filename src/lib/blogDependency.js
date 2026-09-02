// When a queued social post is genuinely waiting on a blog — and when it
// only looks like it is.
//
// WHY THIS IS ITS OWN FILE. The rule has to agree with outcomeFor() in
// supabase/functions/_shared/blogDependentRelease.ts, because a post can be
// evaluated by either path depending on which runs first, and if they
// disagree the post's state flips depending on who looked at it last. That
// had already happened twice by 2 Sep 2026 (see blogOutcome and
// isBlogLinked below), both times because the rule lived inline in
// ContentQueue.jsx where nothing could test it against real rows. Same
// reasoning as lib/awaitingApproval.js, which exists for exactly this.
//
// The Deno edge function still cannot import across the src/ boundary, so
// that copy stays a copy — but this one is now importable and testable, and
// both carry a pointer to the other.

// Phrases that suggest a post is teasing a blog. Detection only — see
// mentionsBlogWithoutLink; these must never gate approval on their own.
export const BLOG_KEYWORDS = ['blog', 'latest post', 'we wrote', 'read more']

export const BLOG_WAIT_MESSAGE = 'Waiting for blog to publish before this post can be approved.'
export const BLOG_REJECTED_MESSAGE = 'The blog this post references was rejected, so it will never publish. Rewrite this post without the reference, or reject it.'
export const BLOG_UNLINKED_MESSAGE = "This copy mentions a blog but isn't linked to one, so it can't be checked automatically — make sure any link in it is live before approving."

// A blog only ever leaves the approval queue two ways — it publishes, or it
// is rejected.
//   'pass'      — nothing left to wait on (no blog, or it published)
//   'attention' — the blog was rejected; a human has to decide
//   'wait'      — genuinely still in the approval queue
//
// MUST stay in agreement with outcomeFor() in
// supabase/functions/_shared/blogDependentRelease.ts.
export function blogOutcome(blog) {
  if (!blog) return 'pass'
  // 'publish_unverified' passes too. This was live drift: the server has
  // treated it as 'pass' since 30 Aug 2026 and the client copy never did, so
  // a post whose blog reached publish_unverified was released by the sweep
  // and then still shown as "waiting for blog" by the queue page. CRHQ has a
  // publish_unverified blog right now, so this was not hypothetical.
  if (blog.status === 'published' || blog.status === 'publish_unverified') return 'pass'
  if (blog.status === 'rejected') return 'attention'
  return 'wait'
}

// Is this post ACTUALLY tied to a blog? Only two things create that tie, and
// both are durable facts written by the pipeline, not guesses:
//   - blog_id      — approve-blog sets it on the posts it generates
//   - review_status === 'blog_dependent' — stamped by the same path
//
// This replaces a referencesBlog() that ALSO returned true on a
// BLOG_KEYWORDS match in the body. That heuristic could not work, because it
// established that *a* blog was mentioned but never *which* one — so the
// related-blog lookup fell back to "this client's most recent unpublished
// blog" and gated the post against a blog it had no relationship with. Every
// brand keeps a draft blog in flight, so that fallback always found
// something and the post was blocked indefinitely.
//
// Measured on 2 Sep 2026, before this change: 38 unlinked posts across 8
// brands matched a keyword, and 19 of those were in the approval queue
// (status draft/pending) and therefore actually blocked from approval — none
// of them linked to any blog. After this change 2 remain blocked, both
// genuinely linked via blog_id to a blog that is approved but not yet
// published, which is the case the gate is for.
//
// The post that surfaced it: CRHQ Instagram 79cad7e5, due 3 Sept, blog_id
// NULL, whose copy read "...or read more at combatreadyhq.co.uk" — a
// HOMEPAGE link. That matched 'read more', so the fallback gated it against
// a CRHQ blog from 1 July that had been rejected, and the card announced
// "the blog this post references was rejected" about a post that references
// no blog at all. Nothing was stale and nothing had failed to be cleared:
// the message was recomputed from scratch on every render.
//
// It also matches the server, which only ever considers rows already
// stamped 'blog_dependent'; the keyword branch was client-side-only
// behaviour the server never agreed with.
export function isBlogLinked(item) {
  return !!item?.blog_id || item?.review_status === 'blog_dependent'
}

// The copy talks about a blog but nothing links it to one. Advisory only:
// with no blog_id there is no way to know which blog is meant, so the honest
// thing is to tell the reviewer to check the link, not to guess a blog and
// refuse approval.
export function mentionsBlogWithoutLink(item) {
  if (isBlogLinked(item)) return false
  const body = (item?.body || '').toLowerCase()
  return BLOG_KEYWORDS.some((k) => body.includes(k))
}

// The blog a post is waiting on, given the client's blogs newest-first.
// Returns null when the post isn't blog-linked at all.
export function pickRelatedBlog(item, blogs = []) {
  if (item?.blog_id) return blogs.find((b) => b.id === item.blog_id) || null
  // Fallback ONLY for rows the pipeline itself stamped 'blog_dependent'.
  // Those really were generated from a blog, so "most recent unpublished" is
  // a reasonable stand-in for a missing blog_id — and it is what
  // releaseForBlogs() does server-side, deliberately including rejected
  // blogs (see its comment). For anything else there is no blog to find.
  if (item?.review_status === 'blog_dependent') {
    return blogs.filter((b) => b.client_id === item.client_id && b.status !== 'published')[0] || null
  }
  return null
}

// Render/approval state for one post.
export function blogBlockStateFor(item, blogs = []) {
  if (!isBlogLinked(item)) {
    return { dependent: false, blocked: false, dead: false, unlinkedMention: mentionsBlogWithoutLink(item) }
  }
  const outcome = blogOutcome(pickRelatedBlog(item, blogs))
  return {
    dependent: true,
    blocked: outcome === 'wait' || outcome === 'attention',
    dead: outcome === 'attention',
    unlinkedMention: false,
  }
}

// Soonest scheduled_for first. Posts with no scheduled_for sort to the
// bottom rather than the top — matching the nullsFirst:false the queue's
// own query already uses, so the client-side order agrees with the server's
// instead of quietly contradicting it. Ties break on id purely so the order
// is deterministic across renders.
export function byScheduledFor(a, b) {
  const at = a?.scheduled_for ? new Date(a.scheduled_for).getTime() : Infinity
  const bt = b?.scheduled_for ? new Date(b.scheduled_for).getTime() : Infinity
  if (at !== bt) return at - bt
  return String(a?.id ?? '').localeCompare(String(b?.id ?? ''))
}
