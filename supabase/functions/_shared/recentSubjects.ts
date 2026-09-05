// What a brand has ALREADY SAID — and what it is currently over-saying.
//
// WHY THIS EXISTS (5 Sep 2026). Two brands were failing review for "repeat
// topic" while every structural rotation fix in the codebase was working as
// designed. The investigation found three separate reasons the GENERATOR was
// being asked to avoid material it had never been shown:
//
//   1. THE QUEUE WAS INVISIBLE. recentPublishedSummaries (generator) and
//      reviewPost's own lookup (reviewer) both read published_posts — rows
//      that only appear once a post has actually gone out via Metricool. A
//      post generated last night and sitting in the queue is not there yet.
//      Combat Ready HQ generated a NATO-nuclear post on 3 Sep while its
//      2 Sep Middle-East post was still queue-only (it reached
//      published_posts on 4 Sep); Quill — LinkedIn had 3 published posts and
//      33 unpublished ones in the queue at the time of writing. The pipeline
//      was reasoning about a tenth of its own output.
//
//   2. THE REPEAT-PREVENTION BLOCK NEVER FIRED, FOR ANY BRAND, EVER.
//      recentApprovedBodies filtered status='approved'. Approving a post sets
//      that status and then immediately calls schedule-to-metricool, which
//      moves it to 'scheduled' — so 'approved' is a state that exists for
//      seconds. Across all 595 rows of mkt_content_queue, every brand, all
//      time, there were ZERO rows at status='approved'. The query therefore
//      always returned [], repeatPreventionBlock([]) always returned '', and
//      `if (repeatBlock)` silently skipped it. The strongest anti-repeat
//      signal in the system — 60 full post bodies, marked NON-NEGOTIABLE —
//      had never once reached a prompt. It failed silently because an empty
//      list and a disabled feature are indistinguishable to that check.
//
//   3. THE GENERATOR'S WINDOW WAS A FIFTH OF THE REVIEWER'S. The generator
//      saw 6 posts truncated to 140 chars; the reviewer judged against 30 at
//      200. CRHQ's 24 Aug "Nuclear strike risk to UK" post sat at position 7
//      — outside what the generator was shown, inside what the reviewer
//      compared against. The post was rejected for repeating something it was
//      never given.
//
// So this module answers "what has this brand actually committed to lately",
// from the QUEUE (the real pipeline) unioned with published_posts (history),
// and derives the themes currently being over-used so the generator can be
// told to steer off them — which is the part pillar rotation alone cannot do.
// Pillar rotation moves between CATEGORIES; when the news cycle keeps handing
// a brand the same story, three posts can sit in three different pillars and
// still all be about Russia.

// deno-lint-ignore no-explicit-any
type Admin = any

// Whitespace/case-insensitive key for spotting the same copy in both tables.
function dedupeKey(s: string): string {
  return String(s ?? '').toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 200)
}

export interface RecentPost {
  body: string
  source: 'queue' | 'published'
  at: string
}

// Everything this brand has committed to recently, most recent first.
//
// STATUS FILTER, stated explicitly because point 2 above was caused by
// guessing at one: 'rejected' is excluded (it was thrown away and will never
// run). EVERYTHING else counts — draft, approved, scheduled, published —
// because a draft awaiting approval is content this brand is about to say,
// and writing the same thing again tonight is precisely the failure being
// prevented. Deliberately NOT an allow-list of known-good statuses: that is
// the shape of bug that produced the silent no-op above, where a status
// nobody had thought about made the whole feature vanish without a trace.
export async function recentBrandPosts(
  admin: Admin,
  clientId: string,
  { days = 60, limit = 30 }: { days?: number; limit?: number } = {},
): Promise<RecentPost[]> {
  const since = new Date(Date.now() - days * 86400000).toISOString()

  const [queueRes, pubRes] = await Promise.all([
    admin.from('mkt_content_queue')
      .select('body, created_at, status')
      .eq('client_id', clientId)
      .neq('status', 'rejected')
      .not('body', 'is', null)
      .gte('created_at', since)
      .order('created_at', { ascending: false })
      .limit(limit),
    admin.from('published_posts')
      .select('post_copy, date_sent')
      .eq('client_id', clientId)
      .gte('date_sent', since)
      .lte('date_sent', new Date().toISOString())
      .order('date_sent', { ascending: false })
      .limit(limit),
  ])

  const rows: RecentPost[] = []
  for (const r of queueRes.data ?? []) {
    const body = String(r.body ?? '').trim()
    if (body) rows.push({ body, source: 'queue', at: r.created_at })
  }
  for (const r of pubRes.data ?? []) {
    const body = String(r.post_copy ?? '').trim()
    if (body) rows.push({ body, source: 'published', at: r.date_sent })
  }

  // A post exists in BOTH tables once it has gone out — the same copy, keyed
  // differently. Dedupe on the normalised body so it is not double-weighted
  // when themes are counted below (which would make anything already
  // published look twice as over-used as it is).
  const seen = new Set<string>()
  const deduped: RecentPost[] = []
  for (const r of rows.sort((a, b) => (a.at < b.at ? 1 : -1))) {
    const key = dedupeKey(r.body)
    if (seen.has(key)) continue
    seen.add(key)
    deduped.push(r)
  }
  return deduped.slice(0, limit)
}

// ── The steer ──────────────────────────────────────────────────────────────
//
// WHAT WAS TRIED FIRST, AND WHY IT IS NOT HERE. The obvious way to build
// "themes to avoid" without another model call is to extract salient terms
// from the recent bodies. That was written, unit-tested against the real
// posts, and DELETED, because it could not tell a subject from a common word:
// on the actual CRHQ posts it surfaced "operational", "beyond", "carry" and
// "commitments" while missing "nuclear" and "russia" entirely — the two terms
// the whole exercise existed to catch. Ranking by document frequency buries a
// word that dominates one recent post; ranking by concentration cannot
// separate "russia" from "beyond", because a bag of words has no notion of
// which nouns name a topic. Shipping it would have told a defence channel to
// avoid "carry" — actively degrading copy in the name of fixing it.
//
// The reviewer already reads every post in full and already returns structured
// output. Asking it to also name the subject in a few words costs no extra
// call, produces a real topic label ("NATO nuclear posture and UK deterrence")
// instead of keyword soup, and is stored so the next night can steer off it.
// That is what topicsToAvoid consumes.

// Recent subject labels for this brand, most recent first, deduplicated
// case-insensitively. Reads the QUEUE, for the reason in point 1 above: a post
// generated last night is the one most likely to be repeated tonight, and it
// will not reach published_posts for days.
export async function recentTopics(
  admin: Admin,
  clientId: string,
  { days = 30, limit = 12 }: { days?: number; limit?: number } = {},
): Promise<string[]> {
  const since = new Date(Date.now() - days * 86400000).toISOString()
  const { data } = await admin.from('mkt_content_queue')
    .select('topic, created_at')
    .eq('client_id', clientId)
    .neq('status', 'rejected')
    .not('topic', 'is', null)
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(limit * 2)

  const seen = new Set<string>()
  const out: string[] = []
  for (const r of data ?? []) {
    const t = String(r.topic ?? '').trim()
    if (!t) continue
    const key = t.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(t)
    if (out.length >= limit) break
  }
  return out
}

// The prompt fragment naming subjects to steer off.
//
// Returns '' when there is nothing to say. Unlike repeatPreventionBlock —
// whose silent empty return is what hid a dead feature for weeks (point 2
// above) — every caller of this logs when it comes back empty, so "no topics
// yet" can never again be mistaken for "working".
export function topicsToAvoidBlock(topics: string[]): string {
  if (!topics.length) return ''
  return `SUBJECT MATTER ALREADY COVERED — these are the subjects of this brand's recent and currently-queued posts, most recent first. Do NOT build this post around any of them, and do not re-angle one of them. Pick genuinely different subject matter:
${topics.map((t) => `- ${t}`).join('\n')}
If the source material available to you points at one of the subjects above, cover a different aspect of the brand's remit rather than repeating it. Repeating the most recent one or two is the worst case — those are the freshest in the audience's feed.`
}
