// Shared cron/service authorisation check — mirrors yca-platform's
// _shared/cronAuth.ts exactly (same shared Supabase project, same failure
// class already found there and here independently).
//
// Accepts EITHER the shared cron secret (as x-cron-secret) or a bearer
// token equal to this project's own service_role key (auto-injected into
// every edge function's env — not a separately-configured secret). The
// anon key is deliberately never accepted.
//
// Why a cron secret matters, not just the service-role check: this project's
// service_role key changed representation (legacy JWT -> new opaque
// format) at the platform level after migration 85 hardcoded a
// then-current copy of the legacy JWT into several cron.job rows — those
// copies silently went stale the moment the format changed, with nothing
// to catch it (a 401 from Supabase's own gateway never reaches this
// function's code, so nothing ever gets logged). The cron secret is a value
// *we* control and rotate deliberately, independent of Supabase's own key
// management — pairing it as a fallback means a future service-role format
// change degrades to "one working path" instead of "totally broken", and
// is far more likely to be caught by the fingerprint check in the log line
// below than by silence.
//
// SOURCE OF TRUTH CHANGED (16 Aug 2026): the expected cron secret is now read
// from Supabase Vault via the service_role-only public.get_cron_secret() RPC,
// not from a CRON_SECRET env var.
//
// The reason is specific. The secret was previously stored as literal text
// inside every cron.job.command, so any SELECT on cron.job printed it — that
// happened three times in a single session. Rotating it required the new
// plaintext to exist in two places at once (Vault for the cron jobs, an env
// var for this check), and getting it into that env var meant the value had
// to pass through a shell command or a query result to be typed in at all —
// i.e. the act of rotating re-exposed it. Reading from Vault removes the env
// var entirely, so a rotation can be generated inside Postgres and never
// leave it.
//
// Env CRON_SECRET is still honoured if set, purely so a deploy of this file
// can land before/after the cron jobs are re-pointed without a window where
// neither value works. Once rollout is complete that env var is unset, at
// which point this branch is inert.
//
// Fails CLOSED: neither an unset env var nor a failed Vault read is treated
// as "no check" — a request still needs the real service_role key to pass.

// Cached for the lifetime of the warm instance: one RPC per cold start, not
// one per request. A null result is cached as null and retried on the next
// cold start rather than hammering the RPC on every call during an outage.
let cachedVaultSecret: string | null = null
let vaultLookupAttempted = false

async function vaultCronSecret(fnName: string): Promise<string> {
  if (vaultLookupAttempted) return cachedVaultSecret ?? ''
  vaultLookupAttempted = true

  const url = (Deno.env.get('SUPABASE_URL') ?? '').trim()
  const serviceKey = (Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '').trim()
  if (!url || !serviceKey) return ''

  try {
    const res = await fetch(`${url}/rest/v1/rpc/get_cron_secret`, {
      method: 'POST',
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        'Content-Type': 'application/json',
      },
      body: '{}',
    })
    if (!res.ok) {
      console.error(`[${fnName}] cron secret Vault lookup failed: HTTP ${res.status}`)
      return ''
    }
    // The RPC returns a bare JSON string (or null when the secret is absent).
    const value = await res.json()
    cachedVaultSecret = typeof value === 'string' && value.length ? value : null
    if (!cachedVaultSecret) console.error(`[${fnName}] cron secret Vault lookup returned no value`)
    return cachedVaultSecret ?? ''
  } catch (e) {
    console.error(`[${fnName}] cron secret Vault lookup threw: ${String((e as Error)?.message ?? e)}`)
    return ''
  }
}

async function fingerprint(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 12)
}

export async function checkCronAuth(req: Request, fnName: string): Promise<{ authorised: boolean; response?: Response }> {
  const envSecret = (Deno.env.get('CRON_SECRET') ?? '').trim()
  const vaultSecret = (await vaultCronSecret(fnName)).trim()
  const providedSecret = (req.headers.get('x-cron-secret') ?? '').trim()
  const bearer = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '').trim()
  const serviceKey = (Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '').trim()

  // Both sources are accepted while rollout is in flight; each comparison is
  // still gated on the expected value being non-empty, so an unset/failed
  // source can never make an empty header match.
  const vaultSecretMatch = !!vaultSecret && providedSecret === vaultSecret
  const envSecretMatch = !!envSecret && providedSecret === envSecret
  const cronSecretMatch = vaultSecretMatch || envSecretMatch
  const bearerMatchesServiceKey = !!serviceKey && bearer === serviceKey
  const authorised = cronSecretMatch || bearerMatchesServiceKey

  console.log(`[${fnName}] auth check — cronSecretSource=${vaultSecret ? 'vault' : envSecret ? 'env' : 'none'} vaultSecretMatch=${vaultSecretMatch} envSecretMatch=${envSecretMatch} cronSecretHeaderPresent=${!!providedSecret} bearerHeaderPresent=${!!bearer} bearerMatchesServiceKey=${bearerMatchesServiceKey} authorised=${authorised}`)

  if (authorised) return { authorised: true }

  const [expectedServiceFp, receivedBearerFp, expectedCronFp, receivedCronFp] = await Promise.all([
    fingerprint(serviceKey || '(unset)'),
    fingerprint(bearer || '(empty)'),
    fingerprint(vaultSecret || envSecret || '(unset)'),
    fingerprint(providedSecret || '(empty)'),
  ])
  console.error(`[${fnName}] auth REJECTED — fingerprints (sha256, first 12 hex chars — NOT the secrets) expected_service_role=${expectedServiceFp} received_bearer=${receivedBearerFp} expected_cron_secret=${expectedCronFp} received_x-cron-secret=${receivedCronFp}`)

  const reason = !bearer && !providedSecret
    ? 'no credentials supplied — send either an x-cron-secret header or an Authorization: Bearer <service_role_key> header'
    : 'credentials supplied did not match the configured cron secret or this project\'s service_role key'

  return {
    authorised: false,
    response: new Response(JSON.stringify({ ok: false, error: 'not authorised', reason }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    }),
  }
}
