// Supabase Edge Function: setup-resend-webhook  (Deno) — admin-only, run by
// hand, not scheduled.
//
// Registers (or re-registers, if run again) this project's Resend webhook
// endpoint against Resend's own API, then stores the signing secret Resend
// returns straight into Postgres Vault via set_resend_webhook_secret() —
// see migration 100_resend_webhook_secret_vault.sql. The plaintext secret
// is never returned in this function's own HTTP response, never printed to
// a log, and never has to be typed into `supabase secrets set` by a human —
// it goes directly from Resend's API response to Vault inside this one
// request, mirroring how CRON_SECRET moved into Vault (see
// _shared/cronAuth.ts's header for that rationale in full).
//
// resend-webhook/index.ts reads the secret back via get_resend_webhook_secret(),
// the same Vault-RPC-with-module-scope-cache shape cronAuth.ts already uses.
//
// Kept in the repo (not deployed-then-deleted) as a real admin utility: if
// the webhook secret is ever rotated or the endpoint re-registered, this is
// how — matches outreach-platform's scripts/gmail-auth.js convention of
// keeping one-off credential-setup tools as permanent, documented utilities
// rather than throwaway scripts.
//
// Registers exactly the two events resend-webhook/index.ts actually handles
// (see that file's own header) — email.bounced and email.complained.
//
// Deploy: supabase functions deploy setup-resend-webhook
// Run by hand: POST with x-cron-secret or Authorization: Bearer <service_role_key>
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { checkCronAuth } from '../_shared/cronAuth.ts'

const WEBHOOK_ENDPOINT = 'https://fvyvtdwsomxfkpxwygpk.supabase.co/functions/v1/resend-webhook'
const EVENTS = ['email.bounced', 'email.complained']

serve(async (req) => {
  const auth = await checkCronAuth(req, 'setup-resend-webhook')
  if (!auth.authorised) return auth.response!

  const resendKey = Deno.env.get('RESEND_API_KEY')
  if (!resendKey) {
    return new Response(JSON.stringify({ ok: false, error: 'RESEND_API_KEY not configured' }), { status: 500, headers: { 'Content-Type': 'application/json' } })
  }

  // { action: 'test_bounce' } — fires a real send to Resend's own
  // bounced@resend.dev test address, which Resend's platform simulates a
  // real hard bounce for and delivers a real email.bounced webhook event
  // through, exactly like a genuine bounce would. Kept as a standing action
  // on this utility (not deployed-then-deleted) so the whole webhook path
  // can be re-verified after any future change without re-deriving this.
  let body: { action?: string } = {}
  try { body = await req.json() } catch { /* no body = normal register/update run */ }
  if (body.action === 'test_bounce') {
    const sendRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'Daily Ops Check <hello@yourcompanyai.co.uk>',
        to: 'bounced@resend.dev',
        subject: 'resend-webhook test bounce — setup-resend-webhook',
        text: 'Real test send to trigger a simulated hard bounce and verify resend-webhook processes it end to end.',
      }),
    })
    const sendBody = await sendRes.json().catch(() => ({}))
    if (!sendRes.ok) {
      return new Response(JSON.stringify({ ok: false, error: `test send failed (${sendRes.status})`, detail: sendBody }), { status: 502, headers: { 'Content-Type': 'application/json' } })
    }
    return new Response(JSON.stringify({ ok: true, resend_id: sendBody.id ?? null, to: 'bounced@resend.dev' }), { headers: { 'Content-Type': 'application/json' } })
  }

  // Idempotent: if an endpoint already exists for this URL, update its
  // events instead of creating a duplicate. Resend's list endpoint is the
  // only way to check — the create endpoint doesn't upsert on URL.
  const listRes = await fetch('https://api.resend.com/webhooks', {
    headers: { Authorization: `Bearer ${resendKey}` },
  })
  if (!listRes.ok) {
    const detail = await listRes.text()
    return new Response(JSON.stringify({ ok: false, error: `Resend list-webhooks failed (${listRes.status}): ${detail.slice(0, 300)}` }), { status: 502, headers: { 'Content-Type': 'application/json' } })
  }
  const listBody = await listRes.json().catch(() => ({}))
  const existing = (listBody.data ?? []).find((w: { endpoint?: string }) => w.endpoint === WEBHOOK_ENDPOINT)

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  const admin = createClient(supabaseUrl, serviceKey)

  // Resend only returns the signing secret on CREATE, never on update — so
  // an existing endpoint with nothing in Vault (this project never captured
  // its secret, e.g. an earlier run whose field-name guess was wrong) must
  // be deleted and recreated, not just PATCHed, or this can never actually
  // finish. Checked BEFORE doing anything else so this run's own branch
  // choice is based on real current state, not stale assumptions.
  const { data: vaultBefore } = await admin.rpc('get_resend_webhook_secret')
  const vaultHadSecret = typeof vaultBefore === 'string' && vaultBefore.length > 0

  let webhookId: string
  let secret: string | null = null
  let wasRecreated = false

  if (existing && vaultHadSecret) {
    webhookId = existing.id
    const updateRes = await fetch(`https://api.resend.com/webhooks/${webhookId}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ events: EVENTS, status: 'enabled' }),
    })
    if (!updateRes.ok) {
      const detail = await updateRes.text()
      return new Response(JSON.stringify({ ok: false, error: `Resend update-webhook failed (${updateRes.status}): ${detail.slice(0, 300)}` }), { status: 502, headers: { 'Content-Type': 'application/json' } })
    }
  } else {
    if (existing) {
      const delRes = await fetch(`https://api.resend.com/webhooks/${existing.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${resendKey}` },
      })
      if (!delRes.ok && delRes.status !== 404) {
        const detail = await delRes.text()
        return new Response(JSON.stringify({ ok: false, error: `Resend delete-webhook failed (${delRes.status}): ${detail.slice(0, 300)}` }), { status: 502, headers: { 'Content-Type': 'application/json' } })
      }
      wasRecreated = true
    }
    const createRes = await fetch('https://api.resend.com/webhooks', {
      method: 'POST',
      headers: { Authorization: `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ endpoint: WEBHOOK_ENDPOINT, events: EVENTS }),
    })
    if (!createRes.ok) {
      const detail = await createRes.text()
      return new Response(JSON.stringify({ ok: false, error: `Resend create-webhook failed (${createRes.status}): ${detail.slice(0, 300)}` }), { status: 502, headers: { 'Content-Type': 'application/json' } })
    }
    const createBody = await createRes.json()
    webhookId = createBody.id
    // Confirmed via a real create call (20 Aug 2026) — Resend's response
    // shape is {object, id, signing_secret}, not {secret} as some other
    // providers use.
    secret = createBody.signing_secret ?? null
  }

  let secretStored = false
  if (secret) {
    const { error } = await admin.rpc('set_resend_webhook_secret', { new_secret: secret })
    if (error) {
      return new Response(JSON.stringify({ ok: false, error: `Vault write failed: ${error.message}`, webhook_id: webhookId }), { status: 500, headers: { 'Content-Type': 'application/json' } })
    }
    secretStored = true
  }

  // Confirm Vault actually holds a usable secret now, regardless of which
  // branch ran above — the real thing that matters is "can resend-webhook
  // verify a real request", not "did this specific call return one".
  const { data: vaultCheck } = await admin.rpc('get_resend_webhook_secret')
  const vaultHasSecret = typeof vaultCheck === 'string' && vaultCheck.length > 0

  return new Response(JSON.stringify({
    ok: true,
    webhook_id: webhookId,
    endpoint: WEBHOOK_ENDPOINT,
    events: EVENTS,
    was_existing: !!existing,
    was_recreated: wasRecreated,
    secret_stored_this_run: secretStored,
    vault_has_secret: vaultHasSecret,
  }), { headers: { 'Content-Type': 'application/json' } })
})
