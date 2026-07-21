// Shared Metricool ANALYTICS calls for monthly-performance-pull.
//
// ⚠️ UNCONFIRMED AGAINST A REAL RESPONSE — READ BEFORE TRUSTING THE NUMBERS.
// Every other Metricool call in this repo (schedule-to-metricool,
// delete-post) only talks to the /v2/scheduler/posts resource — nothing in
// this codebase has ever called an analytics endpoint, and Metricool's API
// docs weren't reachable from this environment to confirm the exact
// endpoint path or response field names (the same limitation
// schedule-to-metricool's own header comment already flags for the `media`
// field on the scheduler call). The auth pattern below (X-Mc-Auth header,
// userId + blogId query params, https://app.metricool.com/api/v2/... base)
// IS proven — it's copied from schedule-to-metricool, which works in
// production. The endpoint PATHS below are a best-effort match to
// Metricool's documented v2 analytics API shape and are NOT verified
// against a real response from this account. Parsing is written
// defensively (multiple possible field names tried per metric, same
// pattern schedule-to-metricool already uses for extracting a post id) so a
// wrong guess degrades to "no data for that field" rather than a crash —
// but if monthly-performance-pull's numbers look wrong or empty, this file
// is the first place to check, ideally against a real logged response body
// (see the console.log calls below).
const METRICOOL_USER_ID = '4984082'
const BASE = 'https://app.metricool.com/api/v2'

function authHeaders(apiKey: string): Record<string, string> {
  return { 'X-Mc-Auth': apiKey, 'Content-Type': 'application/json' }
}

// Metricool's documented date format for analytics query params.
function ymd(d: Date): string {
  return d.toISOString().slice(0, 10).replace(/-/g, '')
}

export interface MetricoolPostStat {
  metricool_post_id: string
  published_at: string | null
  reach: number | null
  impressions: number | null
  likes: number | null
  comments: number | null
  shares: number | null
}

// First number found under any of `keys` on `obj`, else null. Metricool
// metric field names are not confirmed (see file header) — trying several
// plausible names per metric is the same defensive strategy
// schedule-to-metricool already uses for the post-id field.
function firstNumber(obj: Record<string, any>, keys: string[]): number | null {
  for (const k of keys) {
    const v = obj?.[k]
    if (typeof v === 'number' && Number.isFinite(v)) return v
    if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v)
  }
  return null
}

function firstString(obj: Record<string, any>, keys: string[]): string | null {
  for (const k of keys) {
    const v = obj?.[k]
    if (typeof v === 'string' && v.trim()) return v
  }
  return null
}

// Post-level engagement for one brand + network over a date range. Returns
// [] (not a throw) on any failure — a Metricool problem for one client must
// never abort the whole monthly run for every other client. Callers should
// log the returned `error` field themselves for visibility.
export async function fetchMetricoolPostStats(
  apiKey: string,
  brandId: string,
  network: string,
  start: Date,
  end: Date,
): Promise<{ posts: MetricoolPostStat[]; error: string | null }> {
  const url = `${BASE}/analytics/posts?userId=${METRICOOL_USER_ID}&blogId=${brandId}&network=${network}&start=${ymd(start)}&end=${ymd(end)}`
  try {
    const res = await fetch(url, { headers: authHeaders(apiKey) })
    const raw = await res.text()
    let data: unknown
    try { data = JSON.parse(raw) } catch { data = raw }

    if (!res.ok) {
      const detail = typeof data === 'string' ? data : JSON.stringify(data)
      return { posts: [], error: `Metricool analytics/posts ${res.status} (${network}): ${detail.slice(0, 300)}` }
    }

    // Response shape not confirmed — try the plausible container fields
    // before giving up, same defensive style as the post-id extraction in
    // schedule-to-metricool.
    const list: unknown[] = Array.isArray(data)
      ? data
      : Array.isArray((data as Record<string, any>)?.data) ? (data as Record<string, any>).data
      : Array.isArray((data as Record<string, any>)?.posts) ? (data as Record<string, any>).posts
      : []

    if (!list.length) {
      console.log(`[metricool] analytics/posts (${network}, blogId=${brandId}): 0 posts parsed from response — raw keys: ${data && typeof data === 'object' ? Object.keys(data as object).join(',') : typeof data}`)
    }

    const posts: MetricoolPostStat[] = list
      .filter((p): p is Record<string, any> => !!p && typeof p === 'object')
      .map((p) => ({
        metricool_post_id: String(firstString(p, ['id', 'postId', 'post_id']) ?? ''),
        published_at: firstString(p, ['publishedAt', 'published_at', 'date', 'publicationDate']),
        reach: firstNumber(p, ['reach', 'reachOrganic', 'reach_organic']),
        impressions: firstNumber(p, ['impressions', 'impressionOrganic', 'impressions_organic']),
        likes: firstNumber(p, ['likes', 'likeCount', 'like_count']),
        comments: firstNumber(p, ['comments', 'commentCount', 'comment_count']),
        shares: firstNumber(p, ['shares', 'shareCount', 'share_count', 'retweets']),
      }))
      .filter((p) => p.metricool_post_id)

    return { posts, error: null }
  } catch (e) {
    return { posts: [], error: `Metricool analytics/posts network error (${network}): ${String((e as Error)?.message ?? e)}` }
  }
}

// Follower count for one brand + network, as close as possible to `atDate`.
// Used twice per brand+platform (start and end of the reporting month) to
// derive follower_change. Returns null (not a throw) on any failure.
export async function fetchMetricoolFollowerCount(
  apiKey: string,
  brandId: string,
  network: string,
  atDate: Date,
): Promise<{ followers: number | null; error: string | null }> {
  const url = `${BASE}/analytics/${network}?userId=${METRICOOL_USER_ID}&blogId=${brandId}&start=${ymd(atDate)}&end=${ymd(atDate)}`
  try {
    const res = await fetch(url, { headers: authHeaders(apiKey) })
    const raw = await res.text()
    let data: unknown
    try { data = JSON.parse(raw) } catch { data = raw }

    if (!res.ok) {
      const detail = typeof data === 'string' ? data : JSON.stringify(data)
      return { followers: null, error: `Metricool analytics/${network} ${res.status}: ${detail.slice(0, 300)}` }
    }

    const container = Array.isArray(data)
      ? (data[data.length - 1] as Record<string, any> | undefined) ?? {}
      : Array.isArray((data as Record<string, any>)?.data)
        ? ((data as Record<string, any>).data[(data as Record<string, any>).data.length - 1] as Record<string, any> | undefined) ?? {}
        : (data as Record<string, any>) ?? {}

    const followers = firstNumber(container, ['followers', 'followerCount', 'follower_count', 'fans', 'fanCount'])
    if (followers == null) {
      console.log(`[metricool] analytics/${network} follower lookup (blogId=${brandId}): no follower field parsed — raw keys: ${container ? Object.keys(container).join(',') : typeof container}`)
    }
    return { followers, error: null }
  } catch (e) {
    return { followers: null, error: `Metricool analytics/${network} network error: ${String((e as Error)?.message ?? e)}` }
  }
}
