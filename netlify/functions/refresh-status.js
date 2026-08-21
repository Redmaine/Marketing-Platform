// GET /api/refresh-status?secret=...
//
// On-demand regeneration of the daily status JSON, so Quill can refresh it
// without waiting for the morning cron. Invokes the generate-daily-status
// Supabase edge function (the same one pg_cron calls — see migration 48) and
// waits for it to finish, then returns the real generated_at it reports.
//
// The refreshed JSON is served from /api/daily-status, which proxies straight
// to the ops-exports storage object — so a successful refresh here is
// immediately visible there.

const EDGE_FUNCTION_URL =
  'https://fvyvtdwsomxfkpxwygpk.supabase.co/functions/v1/generate-daily-status'

// Netlify's synchronous function budget is ~10s. Abort a shade before that so
// a slow run returns clean JSON rather than Netlify's own timeout page.
const TIMEOUT_MS = 9000

function json(statusCode, body) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      // The request URL carries the secret; make sure no cache or CDN keeps
      // this response around keyed on it.
      'Cache-Control': 'no-store',
    },
    body: JSON.stringify(body),
  }
}

export async function handler(event) {
  if (event.httpMethod !== 'GET' && event.httpMethod !== 'POST') {
    return json(405, { success: false, error: 'Method not allowed' })
  }

  // Name the missing variable in the response. The original generic
  // "Server not configured" was ambiguous between the two env vars below and
  // made this endpoint's first live failure hard to diagnose without digging
  // into function logs. Nothing sensitive is disclosed — this only reveals
  // that a variable is unset, and while it is unset the endpoint returns 500
  // to everyone regardless.
  const expected = process.env.INTERNAL_SECRET
  if (!expected) {
    console.error('[refresh-status] INTERNAL_SECRET is not set')
    return json(500, { success: false, error: 'Server not configured: INTERNAL_SECRET is not set on this Netlify site' })
  }

  // Secret via query param (as specified). A header is also accepted so
  // callers that can send one avoid putting the secret in a URL — see the
  // note in the README/commit about query-string exposure.
  const fromQuery = event.queryStringParameters?.secret
  const authHeader = event.headers?.authorization || event.headers?.Authorization || ''
  const fromBearer = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : ''
  const fromHeader = event.headers?.['x-admin-secret'] || event.headers?.['X-Admin-Secret'] || ''
  const supplied = fromQuery || fromBearer || fromHeader

  if (!supplied || supplied !== expected) {
    // Deliberately vague, and never echoes back what was supplied.
    return json(401, { success: false, error: 'Unauthorised' })
  }

  const serviceKey = process.env.SUPABASE_SERVICE_KEY
  if (!serviceKey) {
    console.error('[refresh-status] SUPABASE_SERVICE_KEY is not set')
    return json(500, { success: false, error: 'Server not configured: SUPABASE_SERVICE_KEY is not set on this Netlify site' })
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)

  try {
    const res = await fetch(EDGE_FUNCTION_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${serviceKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ trigger: 'refresh-status' }),
      signal: controller.signal,
    })

    const raw = await res.text()
    if (!res.ok) {
      console.error(`[refresh-status] edge function ${res.status}: ${raw.slice(0, 300)}`)
      return json(502, {
        success: false,
        error: `Status generation failed (${res.status}): ${raw.slice(0, 200)}`,
      })
    }

    let parsed = null
    try { parsed = JSON.parse(raw) } catch { /* non-JSON success body */ }

    // generate-daily-status returns { ok: true, generated_at,
    // generated_at_utc }. Surface its real timestamps rather than stamping
    // one here, so the values always match what actually landed in the JSON
    // file. generated_at is the human-readable UK-local string ("21 Aug
    // 2026, 22:00 BST"), generated_at_utc the same instant as UTC ISO for
    // anything machine-readable. Both are relayed verbatim: this function
    // deliberately formats nothing itself, so exactly one place (the edge
    // function, via _shared/ukTime.ts) decides how a timestamp reads. Note
    // the Netlify runtime's own local timezone is UTC, so formatting here
    // would have reintroduced the very bug this fixes.
    if (parsed && parsed.ok === false) {
      return json(502, { success: false, error: parsed.error || 'Status generation reported failure' })
    }

    return json(200, {
      success: true,
      generated_at: parsed?.generated_at ?? null,
      generated_at_utc: parsed?.generated_at_utc ?? null,
      message: 'Status refreshed',
    })
  } catch (e) {
    if (e.name === 'AbortError') {
      // The refresh may still finish server-side — say so rather than
      // implying nothing happened.
      return json(504, {
        success: false,
        error: 'Timed out waiting for status generation; it may still complete — re-check /api/daily-status shortly.',
      })
    }
    console.error('[refresh-status] unexpected error:', e.message)
    return json(500, { success: false, error: e.message })
  } finally {
    clearTimeout(timer)
  }
}
