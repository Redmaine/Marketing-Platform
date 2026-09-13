// Anomaly detection for the daily status. 13 Sep 2026.
//
// WHY THIS EXISTS. The daily status already carried the raw facts that would
// have shown every one of the problems below — edge_function_errors in a
// table, per-brand counts, review events — and nobody saw them, because a
// fact in a table is not an alert. Two real cases this week: Riverside's
// image_gen_platforms named a platform it had no connection to, so it could
// never generate an image, and that sat in mkt_clients unnoticed until
// Adrian found it by hand; and the Anthropic monthly cap was hit on the
// 13th, silently stopping every generation on the platform, with the only
// trace a 400 in an error table. This module turns those into loud flags at
// the TOP of the status, before anything else.
//
// EVERY RULE IS PURE. detectAnomalies() does the reads; each rule below is a
// function of plain data, so the tests pin real shapes from the live tables
// without a database. Severity means:
//   critical — something is not running, or cannot run. Act today.
//   warning  — something is misconfigured or degrading. Act this week.
//
// A rule that cannot evaluate (a read failed) reports THAT as a warning
// rather than staying silent — a detector failing quietly is the exact
// failure mode this replaces.

// deno-lint-ignore no-explicit-any
type Admin = any

export type Severity = 'critical' | 'warning'

export interface Alert {
  severity: Severity
  code: string
  title: string
  detail: string
  brand?: string | null
}

// ── Rule 1: the Metricool pull has gone quiet, or covered too few brands ──
//
// The pull is WEEKLY — cron `0 6 * * 1`, Monday 06:00 UTC, metricool-weekly-
// pull. So "silent for 48 hours" is not the test; every Wednesday would
// alarm. The test is cadence-aware: silent means no row since the most
// recent expected slot, plus a grace period. Six days stale on a Sunday is
// the design working; nine days stale is a missed Monday.
export const METRICOOL_PULL_CADENCE_HOURS = 7 * 24
export const METRICOOL_PULL_GRACE_HOURS = 6

export function metricsPullAlerts(input: {
  now: Date
  latestPulledAt: string | null
  // Distinct brands in the most recent pull DAY, and the brands expected
  // (active clients with a Metricool brand id).
  brandsInLatestPull: string[]
  expectedBrands: string[]
}): Alert[] {
  const out: Alert[] = []
  if (!input.latestPulledAt) {
    out.push({ severity: 'critical', code: 'metrics_pull_silent', title: 'Metricool metrics have NEVER been pulled', detail: 'metricool_account_performance is empty.' })
    return out
  }
  const hours = (input.now.getTime() - new Date(input.latestPulledAt).getTime()) / 36e5
  const limit = METRICOOL_PULL_CADENCE_HOURS + METRICOOL_PULL_GRACE_HOURS
  if (hours > limit) {
    out.push({
      severity: 'critical',
      code: 'metrics_pull_silent',
      title: `Metricool metrics pull has gone silent — ${Math.round(hours / 24)} days since the last pull`,
      detail: `Last row in metricool_account_performance at ${input.latestPulledAt}. The pull runs weekly (Monday 06:00 UTC); anything over ${limit}h means a Monday was missed. Check cron.job "metricool-weekly-pull" and edge_function_errors.`,
    })
  }
  const missing = input.expectedBrands.filter((b) => !input.brandsInLatestPull.includes(b))
  if (input.expectedBrands.length && missing.length) {
    out.push({
      severity: 'warning',
      code: 'metrics_pull_partial',
      title: `Last Metricool pull covered ${input.brandsInLatestPull.length} of ${input.expectedBrands.length} brands`,
      detail: `Missing: ${missing.join(', ')}. A brand with a Metricool id but no row in the latest pull usually means its Metricool connection failed or its brand id is wrong.`,
    })
  }
  return out
}

// ── Rule 2: image platform configuration that can never produce an image ──
//
// The Riverside bug, generalised. image_gen_platforms is an ALLOW-list of
// platforms images may be generated for (empty = no restriction).
// connected_platforms is where the brand actually posts. If the allow-list
// names only platforms the brand is not connected to, image generation is
// permitted nowhere it posts — silently. Same outcome if every connected
// platform is in image_gen_disabled_platforms while the allow-list still
// expects images there.
export function imagePlatformMismatchAlerts(clients: Array<{
  name: string
  connected_platforms?: string[] | null
  image_gen_platforms?: string[] | null
  image_gen_disabled_platforms?: string[] | null
  visual_style?: string | null
}>): Alert[] {
  const out: Alert[] = []
  for (const c of clients) {
    const connected = (c.connected_platforms ?? []).map(String)
    const allowed = (c.image_gen_platforms ?? []).map(String)
    const disabled = (c.image_gen_disabled_platforms ?? []).map(String)
    if (!connected.length) continue
    if (allowed.length && !allowed.some((p) => connected.includes(p))) {
      out.push({
        severity: 'warning',
        code: 'image_platform_mismatch',
        brand: c.name,
        title: `${c.name}: images allowed only on ${allowed.join('/')}, but only ${connected.join('/')} is connected — no image can ever be generated`,
        detail: `mkt_clients.image_gen_platforms = [${allowed.join(', ')}], connected_platforms = [${connected.join(', ')}]. Either add the connected platform to image_gen_platforms, or clear it to mean "no restriction". This is the Riverside bug of 12 Sep.`,
      })
      continue
    }
    // A brand with no visual_style is deliberately dormant for images — the
    // pipeline refuses to generate for it regardless (image.ts, 22 Aug) — so
    // its kill-switch being set is the intended state, not an anomaly.
    // adrian-linkedin is the live case; flagging it daily would only teach
    // people to ignore the banner.
    if (!String(c.visual_style ?? '').trim()) continue
    const reachable = (allowed.length ? allowed.filter((p) => connected.includes(p)) : connected)
    if (reachable.length && reachable.every((p) => disabled.includes(p))) {
      out.push({
        severity: 'warning',
        code: 'image_generation_disabled_everywhere',
        brand: c.name,
        title: `${c.name}: image generation is disabled on every platform it posts to`,
        detail: `image_gen_disabled_platforms = [${disabled.join(', ')}] covers ${reachable.join('/')}. This is the kill-switch the pipeline sets itself after a provider error — check edge_function_errors for why, and clear it when the cause is fixed.`,
      })
    }
  }
  return out
}

// ── Rule 3: a brand's recent posts have no images where images are expected ──
export const ZERO_IMAGE_STREAK = 3

export function zeroImageAlerts(input: {
  clients: Array<{ id: string; name: string; connected_platforms?: string[] | null; image_gen_platforms?: string[] | null; image_gen_disabled_platforms?: string[] | null }>
  // Most recent posts per client, newest first, already filtered to real
  // posts on platforms where an image is expected.
  recentPosts: Array<{ client_id: string; platform: string; image_url: string | null; created_at: string }>
}): Alert[] {
  const out: Alert[] = []
  for (const c of input.clients) {
    const connected = (c.connected_platforms ?? []).map(String)
    const allowed = (c.image_gen_platforms ?? []).map(String)
    const disabled = (c.image_gen_disabled_platforms ?? []).map(String)
    const expecting = (allowed.length ? allowed.filter((p) => connected.includes(p)) : connected).filter((p) => !disabled.includes(p))
    if (!expecting.length) continue // rule 2 covers the misconfigured case
    const posts = input.recentPosts
      .filter((p) => p.client_id === c.id && expecting.includes(String(p.platform)))
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .slice(0, ZERO_IMAGE_STREAK)
    if (posts.length < ZERO_IMAGE_STREAK) continue
    if (posts.every((p) => !p.image_url)) {
      out.push({
        severity: 'warning',
        code: 'brand_zero_images',
        brand: c.name,
        title: `${c.name}: last ${ZERO_IMAGE_STREAK} posts on ${expecting.join('/')} have no image`,
        detail: `Images are expected there (allow-list/connections agree, nothing disabled) yet none of the ${ZERO_IMAGE_STREAK} most recent posts has an image_url. Check image_review_events for exhausted runs and edge_function_errors for provider errors.`,
      })
    }
  }
  return out
}

// ── Rule 4: an Anthropic usage cap, or a cron job the healthcheck says is stale ──
//
// Both are already written to edge_function_errors by the code that hits
// them. Surfacing them here is what makes them unmissable. The cap is the
// most important line in this file: when it fires, NOTHING on the platform
// generates until the date in the message.
export function errorLogAlerts(errors: Array<{ function_name: string; error_message: string; created_at: string }>): Alert[] {
  const out: Alert[] = []
  const cap = errors.find((e) => /usage limits|regain access/i.test(e.error_message))
  if (cap) {
    const when = (cap.error_message.match(/regain access on ([0-9-]+)/i) || [])[1]
    out.push({
      severity: 'critical',
      code: 'anthropic_usage_cap',
      title: `Anthropic API usage cap reached — all AI generation is blocked${when ? ` until ${when}` : ''}`,
      detail: `Seen in ${cap.function_name} at ${cap.created_at}. Every content, concept, image-review and summary step on this platform uses this key. Raise the limit in the Anthropic console, or nothing generates${when ? ` before ${when}` : ''}.`,
    })
  }
  const seen = new Set<string>()
  for (const e of errors) {
    const m = e.error_message.match(/^\[cron-healthcheck\] "([^"]+)"/)
    if (!m || seen.has(m[1])) continue
    seen.add(m[1])
    out.push({
      severity: 'critical',
      code: 'cron_job_stale',
      title: `Scheduled job "${m[1]}" has not run when it should have`,
      detail: e.error_message.slice(0, 400),
    })
  }
  return out
}

// ── Rule 5: image generation exhausting all attempts, repeatedly ──
export function exhaustedImageAlerts(events: Array<{ client_name: string | null; verdict: string }>): Alert[] {
  const counts = new Map<string, number>()
  for (const e of events) {
    if (e.verdict !== 'exhausted') continue
    const k = e.client_name ?? 'unknown'
    counts.set(k, (counts.get(k) ?? 0) + 1)
  }
  const out: Alert[] = []
  for (const [brand, n] of counts) {
    if (n < 2) continue
    out.push({
      severity: 'warning',
      code: 'image_generation_exhausted',
      brand,
      title: `${brand}: ${n} posts burned every image attempt in the last 24h`,
      detail: 'Each was rejected on every attempt and went out with no image. The reasons are in image_review_events — a run of these on one brand means a prompt or concept problem, not bad luck.',
    })
  }
  return out
}

export const SEVERITY_ORDER: Record<Severity, number> = { critical: 0, warning: 1 }

export function sortAlerts(alerts: Alert[]): Alert[] {
  return [...alerts].sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || a.title.localeCompare(b.title))
}

export function alertHeadline(alerts: Alert[]): string {
  if (!alerts.length) return 'No anomalies detected.'
  const c = alerts.filter((a) => a.severity === 'critical').length
  const w = alerts.length - c
  const parts = []
  if (c) parts.push(`${c} CRITICAL`)
  if (w) parts.push(`${w} warning${w === 1 ? '' : 's'}`)
  return `${parts.join(', ')} — read these before anything else.`
}

// ── The reads, then the rules ────────────────────────────────────────────
export async function detectAnomalies(admin: Admin, now = new Date()): Promise<Alert[]> {
  const alerts: Alert[] = []
  const since24h = new Date(now.getTime() - 24 * 36e5).toISOString()
  const since14d = new Date(now.getTime() - 14 * 86400e3).toISOString()

  const [clientsRes, latestPullRes, errorsRes, eventsRes, postsRes] = await Promise.all([
    admin.from('mkt_clients').select('id, name, connected_platforms, image_gen_platforms, image_gen_disabled_platforms, metricool_brand_id, visual_style').eq('active', true),
    admin.from('metricool_account_performance').select('brand, pulled_at').order('pulled_at', { ascending: false }).limit(200),
    admin.from('edge_function_errors').select('function_name, error_message, created_at').gte('created_at', since24h).order('created_at', { ascending: false }).limit(500),
    admin.from('image_review_events').select('client_name, verdict').gte('created_at', since24h).limit(2000),
    admin.from('mkt_content_queue').select('client_id, platform, image_url, created_at')
      .gte('created_at', since14d).neq('status', 'rejected').or('content_type.eq.post,content_type.is.null').limit(2000),
  ])

  const readFailure = (what: string, err: { message?: string } | null) =>
    alerts.push({ severity: 'warning', code: 'detector_read_failed', title: `Anomaly detector could not read ${what}`, detail: String(err?.message ?? 'unknown error') })

  const clients = (clientsRes.data ?? []) as Array<Record<string, any>>
  if (clientsRes.error) readFailure('mkt_clients', clientsRes.error)

  if (latestPullRes.error) readFailure('metricool_account_performance', latestPullRes.error)
  else {
    const rows = (latestPullRes.data ?? []) as Array<{ brand: string; pulled_at: string }>
    const latest = rows[0]?.pulled_at ?? null
    const latestDay = latest ? latest.slice(0, 10) : null
    const brandsInLatestPull = [...new Set(rows.filter((r) => r.pulled_at.slice(0, 10) === latestDay).map((r) => r.brand))]
    const expectedBrands = clients.filter((c) => c.metricool_brand_id).map((c) => String(c.name))
    alerts.push(...metricsPullAlerts({ now, latestPulledAt: latest, brandsInLatestPull, expectedBrands }))
  }

  alerts.push(...imagePlatformMismatchAlerts(clients as any))

  if (postsRes.error) readFailure('mkt_content_queue', postsRes.error)
  else alerts.push(...zeroImageAlerts({ clients: clients as any, recentPosts: (postsRes.data ?? []) as any }))

  if (errorsRes.error) readFailure('edge_function_errors', errorsRes.error)
  else alerts.push(...errorLogAlerts((errorsRes.data ?? []) as any))

  if (eventsRes.error) readFailure('image_review_events', eventsRes.error)
  else alerts.push(...exhaustedImageAlerts((eventsRes.data ?? []) as any))

  return sortAlerts(alerts)
}
