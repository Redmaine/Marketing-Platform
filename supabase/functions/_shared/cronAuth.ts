// Shared cron/service authorisation check — mirrors yca-platform's
// _shared/cronAuth.ts exactly (same shared Supabase project, same failure
// class already found there and here independently).
//
// Accepts EITHER the shared CRON_SECRET (as x-cron-secret) or a bearer
// token equal to this project's own service_role key (auto-injected into
// every edge function's env — not a separately-configured secret). The
// anon key is deliberately never accepted.
//
// Why CRON_SECRET matters, not just the service-role check: this project's
// service_role key changed representation (legacy JWT -> new opaque
// format) at the platform level after migration 85 hardcoded a
// then-current copy of the legacy JWT into several cron.job rows — those
// copies silently went stale the moment the format changed, with nothing
// to catch it (a 401 from Supabase's own gateway never reaches this
// function's code, so nothing ever gets logged). CRON_SECRET is a value
// *we* control and rotate deliberately, independent of Supabase's own key
// management — pairing it as a fallback means a future service-role format
// change degrades to "one working path" instead of "totally broken", and
// is far more likely to be caught by the fingerprint check in the log line
// below than by silence.
//
// Fails CLOSED: an unset CRON_SECRET is not treated as "no check" — a
// request still needs the real service_role key to pass.
async function fingerprint(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 12)
}

export async function checkCronAuth(req: Request, fnName: string): Promise<{ authorised: boolean; response?: Response }> {
  const cronSecret = (Deno.env.get('CRON_SECRET') ?? '').trim()
  const providedSecret = (req.headers.get('x-cron-secret') ?? '').trim()
  const bearer = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '').trim()
  const serviceKey = (Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '').trim()

  const cronSecretMatch = !!cronSecret && providedSecret === cronSecret
  const bearerMatchesServiceKey = !!serviceKey && bearer === serviceKey
  const authorised = cronSecretMatch || bearerMatchesServiceKey

  console.log(`[${fnName}] auth check — cronSecretConfigured=${!!cronSecret} cronSecretHeaderPresent=${!!providedSecret} cronSecretMatch=${cronSecretMatch} bearerHeaderPresent=${!!bearer} bearerMatchesServiceKey=${bearerMatchesServiceKey} authorised=${authorised}`)

  if (authorised) return { authorised: true }

  const [expectedServiceFp, receivedBearerFp, expectedCronFp, receivedCronFp] = await Promise.all([
    fingerprint(serviceKey || '(unset)'),
    fingerprint(bearer || '(empty)'),
    fingerprint(cronSecret || '(unset)'),
    fingerprint(providedSecret || '(empty)'),
  ])
  console.error(`[${fnName}] auth REJECTED — fingerprints (sha256, first 12 hex chars — NOT the secrets) expected_service_role=${expectedServiceFp} received_bearer=${receivedBearerFp} expected_cron_secret=${expectedCronFp} received_x-cron-secret=${receivedCronFp}`)

  const reason = !bearer && !providedSecret
    ? 'no credentials supplied — send either an x-cron-secret header or an Authorization: Bearer <service_role_key> header'
    : 'credentials supplied did not match the configured CRON_SECRET or this project\'s service_role key'

  return {
    authorised: false,
    response: new Response(JSON.stringify({ ok: false, error: 'not authorised', reason }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    }),
  }
}
