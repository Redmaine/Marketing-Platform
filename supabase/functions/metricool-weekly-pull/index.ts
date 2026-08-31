// Supabase Edge Function: metricool-weekly-pull  (Deno)
//
// Weekly Metricool analytics pull. For every active brand in mkt_clients,
// pulls post-level and account-level performance from the real, verified
// Metricool v2 endpoints (see _shared/metricool-v2.ts — NOT the older
// _shared/metricool.ts, whose guessed paths are confirmed 404) and writes
// into metricool_post_performance, metricool_account_performance and
// metricool_top_posts (schema: supabase/migrations/62_metricool_weekly_pull_schema.sql).
//
// Design notes (no schedule/window was specified in the originating brief,
// so these are the choices made building this function — flagged for
// visibility rather than decided silently):
//   - Brand roster is read dynamically from mkt_clients (active=true), the
//     same pattern monthly-performance-pull already uses, rather than a
//     hardcoded brand list — mkt_clients currently has 9 active brands
//     including "Steady" (metricool_brand_id 6513580, facebook only).
//   - Post-performance pull window is a rolling 30 days so metrics on
//     already-published posts keep accruing (Metricool's numbers change
//     after publish); the unique(post_id, platform) constraint makes this
//     an upsert, not a duplicate-insert.
//   - reach_7d / impressions_7d / engagements_7d and avg_engagement_rate_30d
//     are derived client-side from the same 30-day post pull rather than a
//     separate /v2/analytics/aggregation call per metric per brand — one
//     endpoint call gets everything instead of ~4x more requests.
//   - follower_change_7d/30d uses the `pageFollows` timeline metric
//     (subject=account), confirmed live for Facebook. No equivalent
//     followers metric exists in Metricool's documented Instagram
//     account-level timeline metrics, so Instagram's follower_change
//     fields are left at 0 (current followers count is still accurate,
//     from /explore/followers).
//   - CURRENT FOLLOWERS, Facebook specifically (root-cause fix, 31 Aug
//     2026): /explore/followers's `facebookFollowers` field returns 0 for
//     every brand — confirmed live against CRHQ (real: 58, via its own
//     Metricool PDF) and Riverside (real, stable at 28 all month via the
//     timeline below) — a genuine gap in that Metricool endpoint for
//     Facebook, not a wrong field name; `instagramFollowers` from the same
//     endpoint is correct (confirmed exact match, 4363, against CRHQ's
//     same PDF). Facebook's `followers` now comes from the most recent
//     value of the SAME pageFollows timeline already being fetched here for
//     follower_change — proven accurate, and no extra API call needed.
//     /explore/followers is kept as the fallback if that timeline fetch
//     fails or returns no data, same as before.
//   - A platform with no connection for a brand (Metricool 403 "no X
//     connection for blog") is skipped for that brand, not treated as a
//     failure — same per-client error isolation as monthly-performance-pull.
//
// Deploy:  supabase functions deploy metricool-weekly-pull
// Secrets: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY (auto-injected),
//          METRICOOL_API_KEY (Supabase → Edge Functions → Secrets)
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { fetchPosts, fetchTimeline, fetchFollowers, MetricoolNoConnectionError } from '../_shared/metricool-v2.ts'
import { checkCronAuth } from '../_shared/cronAuth.ts'

// deno-lint-ignore no-explicit-any
type Admin = any

const ANALYTICS_PLATFORMS = ['facebook', 'instagram', 'linkedin']
const POST_WINDOW_DAYS = 30
const TOP_POSTS_PER_BRAND_PLATFORM = 5

function isoDaysAgo(days: number): string {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() - days)
  return d.toISOString().slice(0, 19)
}

// Metricool's `engagement` field is a percentage (e.g. 22.22), not a raw
// interaction count — confirmed live (fractional values on every brand
// tested). It maps to the numeric engagement_rate column, never the
// integer engagements column. `engagements` (a count) is derived instead
// from the platform's own raw interaction fields.
function mapFacebookPost(p: Record<string, unknown>) {
  const impressions = Number(p.impressions ?? 0)
  const engagementRate = Number(p.engagement ?? 0)
  return {
    post_id: String(p.postId ?? ''),
    published_at: (p.created as { dateTime?: string } | undefined)?.dateTime ?? null,
    reach: Number(p.impressionsUnique ?? 0),
    impressions,
    engagements: Math.round(Number(p.reactions ?? 0) + Number(p.comments ?? 0) + Number(p.shares ?? 0)),
    likes: Number(p.like ?? 0),
    comments: Number(p.comments ?? 0),
    shares: Number(p.shares ?? 0),
    clicks: Math.round(Number(p.linkclicks ?? p.clicks ?? 0)),
    engagement_rate: engagementRate,
  }
}

function mapInstagramPost(p: Record<string, unknown>) {
  const impressions = Number(p.impressionsTotal ?? p.impressions ?? 0)
  const reach = Number(p.reach ?? 0)
  const engagementRate = Number(p.engagement ?? 0)
  return {
    post_id: String(p.postId ?? ''),
    published_at: (p.publishedAt as { dateTime?: string } | undefined)?.dateTime ?? null,
    reach,
    impressions,
    engagements: Math.round(Number(p.interactions ?? 0)),
    likes: Number(p.likes ?? 0),
    comments: Number(p.comments ?? 0),
    shares: Number(p.shares ?? 0),
    clicks: Math.round(Number(p.clicks ?? 0)),
    engagement_rate: engagementRate,
  }
}

// UNVERIFIED — unlike mapFacebookPost/mapInstagramPost (empirically confirmed
// against the live API per this file's header), no live LinkedIn post has
// been pulled through /v2/analytics/posts/linkedin yet, so these field names
// are a best-effort guess from Metricool's documented vocabulary, not a
// confirmed shape. Defensive fallback chains (?? ) so an unrecognised field
// name degrades to 0 rather than throwing. Spot-check metricool_post_
// performance rows with platform='linkedin' after the first real run and
// correct any field names found wrong.
function mapLinkedInPost(p: Record<string, unknown>) {
  const impressions = Number(p.impressions ?? p.impressionsTotal ?? 0)
  const engagementRate = Number(p.engagement ?? 0)
  return {
    post_id: String(p.postId ?? ''),
    published_at: (p.publishedAt as { dateTime?: string } | undefined)?.dateTime
      ?? (p.created as { dateTime?: string } | undefined)?.dateTime ?? null,
    // LinkedIn's analytics don't expose a distinct "reach" figure in
    // Metricool's documented fields the way Facebook/Instagram do —
    // impressions is the closest available figure until verified otherwise.
    reach: impressions,
    impressions,
    engagements: Math.round(Number(p.interactions ?? p.engagements ?? 0)),
    likes: Number(p.likes ?? p.like ?? 0),
    comments: Number(p.comments ?? 0),
    shares: Number(p.shares ?? 0),
    clicks: Math.round(Number(p.clicks ?? p.linkclicks ?? 0)),
    engagement_rate: engagementRate,
  }
}

async function pullBrandPlatform(
  admin: Admin,
  brand: string,
  blogId: string,
  platform: string,
  from: string,
  to: string,
) {
  let rawPosts: Record<string, unknown>[]
  try {
    rawPosts = await fetchPosts(platform, blogId, from, to)
  } catch (e) {
    if (e instanceof MetricoolNoConnectionError) {
      console.log(`[metricool-weekly-pull] ${brand}/${platform}: not connected, skipping`)
      return
    }
    throw e
  }

  const mapper = platform === 'facebook' ? mapFacebookPost : platform === 'linkedin' ? mapLinkedInPost : mapInstagramPost
  const mapped = rawPosts
    .map(mapper)
    .filter((p) => p.post_id)

  if (mapped.length > 0) {
    const rows = mapped.map((p) => ({
      brand,
      blog_id: blogId,
      platform,
      ...p,
      pulled_at: new Date().toISOString(),
    }))
    const { error } = await admin.from('metricool_post_performance').upsert(rows, { onConflict: 'post_id,platform' })
    if (error) throw new Error(`upsert metricool_post_performance failed: ${error.message}`)
  }

  const sevenDaysAgo = isoDaysAgo(7)
  const last7 = mapped.filter((p) => p.published_at && p.published_at >= sevenDaysAgo)
  const reach_7d = last7.reduce((s, p) => s + p.reach, 0)
  const impressions_7d = last7.reduce((s, p) => s + p.impressions, 0)
  const engagements_7d = last7.reduce((s, p) => s + p.engagements, 0)
  const avg_engagement_rate_30d =
    mapped.length > 0
      ? Number((mapped.reduce((s, p) => s + p.engagement_rate, 0) / mapped.length).toFixed(2))
      : 0

  let followers = 0
  try {
    const followerCounts = await fetchFollowers(blogId)
    followers = Number(followerCounts[`${platform}Followers`] ?? 0)
  } catch (e) {
    console.error(`[metricool-weekly-pull] ${brand}/${platform}: followers lookup failed:`, String((e as Error)?.message ?? e))
  }

  let follower_change_7d = 0
  let follower_change_30d = 0
  if (platform === 'facebook') {
    try {
      const values30 = await fetchTimeline('facebook', 'pageFollows', 'account', blogId, isoDaysAgo(30), to)
      if (values30.length > 0) {
        const first = values30[0].value
        const last = values30[values30.length - 1].value
        follower_change_30d = last - first
        const idx7 = values30.findIndex((v) => v.dateTime >= sevenDaysAgo)
        follower_change_7d = idx7 >= 0 ? last - values30[idx7].value : 0
        // Root-cause fix (31 Aug 2026) — see the header comment's "CURRENT
        // FOLLOWERS, Facebook specifically" note. /explore/followers's
        // facebookFollowers is broken (always 0); this timeline's own most
        // recent value is the real, current count — confirmed against
        // CRHQ's real Metricool PDF (58, exact match).
        followers = last
      }
    } catch (e) {
      console.error(`[metricool-weekly-pull] ${brand}/${platform}: follower timeline failed:`, String((e as Error)?.message ?? e))
    }
  }

  const { error: acctError } = await admin.from('metricool_account_performance').insert({
    brand,
    blog_id: blogId,
    platform,
    followers,
    follower_change_7d,
    follower_change_30d,
    reach_7d,
    impressions_7d,
    engagements_7d,
    avg_engagement_rate_30d,
    pulled_at: new Date().toISOString(),
  })
  if (acctError) throw new Error(`insert metricool_account_performance failed: ${acctError.message}`)

  const top = [...mapped].sort((a, b) => b.engagement_rate - a.engagement_rate).slice(0, TOP_POSTS_PER_BRAND_PLATFORM)
  if (top.length > 0) {
    const { error: topError } = await admin.from('metricool_top_posts').insert(
      top.map((p) => ({
        brand,
        platform,
        post_preview: p.post_id,
        engagement_rate: p.engagement_rate,
        published_at: p.published_at,
      })),
    )
    if (topError) throw new Error(`insert metricool_top_posts failed: ${topError.message}`)
  }
}

serve(async (req) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  }
  const json = (b: unknown, s = 200) =>
    new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } })
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })

  const auth = await checkCronAuth(req, 'metricool-weekly-pull')
  if (!auth.authorised) return auth.response!

  const startedAt = Date.now()

  const SUPABASE_URL = Deno.env.get('SUPABASE_URL')
  const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (!SUPABASE_URL || !SERVICE_KEY) {
    return json({ ok: false, error: 'SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not configured' }, 500)
  }
  const admin: Admin = createClient(SUPABASE_URL, SERVICE_KEY)

  const { data: clients, error: clientsError } = await admin
    .from('mkt_clients')
    .select('id, name, connected_platforms, metricool_brand_id, active')
    .eq('active', true)

  if (clientsError) {
    console.error('[metricool-weekly-pull] failed to load mkt_clients:', clientsError.message)
    return json({ ok: false, error: clientsError.message }, 500)
  }

  const from = isoDaysAgo(POST_WINDOW_DAYS)
  const to = new Date().toISOString().slice(0, 19)

  const results: { brand: string; platform: string; ok: boolean; error?: string }[] = []
  const brandsProcessed = new Set<string>()

  for (const client of clients ?? []) {
    if (!client.metricool_brand_id) continue
    const platforms: string[] = (client.connected_platforms ?? []).filter((p: string) =>
      ANALYTICS_PLATFORMS.includes(p),
    )
    for (const platform of platforms) {
      brandsProcessed.add(client.name)
      try {
        await pullBrandPlatform(admin, client.name, String(client.metricool_brand_id), platform, from, to)
        results.push({ brand: client.name, platform, ok: true })
      } catch (e) {
        const message = String((e as Error)?.message ?? e)
        console.error(`[metricool-weekly-pull] ${client.name}/${platform} failed:`, message)
        results.push({ brand: client.name, platform, ok: false, error: message })
        await admin.from('edge_function_errors').insert({
          function_name: 'metricool-weekly-pull',
          error_message: `${client.name}/${platform}: ${message}`,
        })
      }
    }
  }

  const failed = results.filter((r) => !r.ok)
  await admin.from('mkt_cron_log').insert({
    job_name: 'metricool-weekly-pull',
    clients_processed: brandsProcessed.size,
    posts_generated: 0,
    errors: failed.map((r) => `${r.brand}/${r.platform}: ${r.error}`),
    duration_ms: Date.now() - startedAt,
    notes: results.map((r) => `${r.brand}/${r.platform}: ${r.ok ? 'ok' : 'failed'}`),
  })

  console.log(`[metricool-weekly-pull] done: ${results.length - failed.length}/${results.length} brand/platform pulls succeeded`)
  return json({ ok: true, results })
})
