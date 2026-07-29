// Metricool API v2 client — REAL, empirically-verified endpoints only.
//
// This is a separate module from _shared/metricool.ts on purpose:
// metricool.ts's /analytics/posts and /analytics/{network} paths were
// confirmed 404 against the live API (guessed paths that were never
// verified). Do not merge these files or route metricool-weekly-pull
// through the old one.
//
// Verified 2026-07 against the live API using Quill (blogId 6469945):
//   - Base URL is https://app.metricool.com/api  (NOT .../api/v2 alone —
//     that bare path 404s to Metricool's own frontend SPA shell)
//   - Auth: `X-Mc-Auth: <key>` header, PLUS userId + blogId as query params
//     on every call (empirically required; not listed in the swagger spec's
//     parameter docs, which are incomplete)
//   - `subject` is REQUIRED on /analytics/timelines and /analytics/aggregation
//     despite the spec marking it optional (both 400 with "Invalid field
//     'null'" when omitted)
//   - A 403 with detail "There is no {network} connection for blog: {id}"
//     is Metricool's genuine response for an unconnected platform — not an
//     endpoint error. Callers must handle this per-brand-per-platform.

const BASE = 'https://app.metricool.com/api'

export interface McError {
  status: number
  body: string
}

export class MetricoolNoConnectionError extends Error {
  constructor(public network: string, public blogId: string) {
    super(`No ${network} connection for blog ${blogId}`)
  }
}

function authHeader(): string {
  const key = Deno.env.get('METRICOOL_API_KEY')
  if (!key) throw new Error('METRICOOL_API_KEY not configured')
  return key
}

async function mcGet(path: string, params: Record<string, string>): Promise<unknown> {
  const url = new URL(`${BASE}${path}`)
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)

  const res = await fetch(url.toString(), {
    headers: { 'X-Mc-Auth': authHeader(), Accept: 'application/json' },
  })

  if (res.status === 403) {
    const text = await res.text()
    if (/no .* connection for blog/i.test(text)) {
      throw new MetricoolNoConnectionError(params.network ?? params.blogId ?? '', params.blogId ?? '')
    }
    throw new Error(`Metricool 403: ${text}`)
  }
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Metricool ${res.status} on ${path}: ${text.slice(0, 500)}`)
  }
  return res.json()
}

const USER_ID = '4984082'

// GET /v2/analytics/posts/{network} — post-level metrics for a date window.
// network: facebook | instagram | linkedin | tiktok | pinterest | threads | bluesky
export async function fetchPosts(
  network: string,
  blogId: string,
  fromISO: string,
  toISO: string,
): Promise<Record<string, unknown>[]> {
  const posts: Record<string, unknown>[] = []
  let next: string | undefined
  for (let page = 0; page < 10; page++) {
    const params: Record<string, string> = {
      userId: USER_ID,
      blogId,
      network,
      from: fromISO,
      to: toISO,
    }
    if (next) params.page = next
    const json = (await mcGet(`/v2/analytics/posts/${network}`, params)) as {
      data?: Record<string, unknown>[]
      page?: { next?: string }
    }
    posts.push(...(json.data ?? []))
    next = json.page?.next
    if (!next) break
  }
  return posts
}

// GET /v2/analytics/timelines — subject is empirically required.
export async function fetchTimeline(
  network: string,
  metric: string,
  subject: string,
  blogId: string,
  fromISO: string,
  toISO: string,
): Promise<{ dateTime: string; value: number }[]> {
  const json = (await mcGet('/v2/analytics/timelines', {
    userId: USER_ID,
    blogId,
    network,
    metric,
    subject,
    from: fromISO,
    to: toISO,
  })) as { data?: { metric: string; values?: { dateTime: string; value: number }[] }[] }
  return json.data?.[0]?.values ?? []
}

// GET /explore/followers/{blogId} — current follower counts per network.
export async function fetchFollowers(blogId: string): Promise<Record<string, number>> {
  const json = (await mcGet(`/explore/followers/${blogId}`, { userId: USER_ID, blogId })) as Record<
    string,
    number
  >
  return json
}
