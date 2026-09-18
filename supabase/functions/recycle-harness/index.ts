// Verification harness for CRHQ slot recycling. NOT part of the pipeline, not
// called by any cron, DELIBERATELY LEFT UNDEPLOYED — deployed by hand for a
// verification run and removed straight after (same pattern as image-harness).
// { dryRun: true } decides and reports without writing; { dryRun: false }
// performs the real recycle through the SAME exported function the nightly
// run calls (recycleMissedSlots), in the project's own environment.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { recycleMissedSlots } from '../_shared/crhqRecycle.ts'

const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)

Deno.serve(async (req: Request) => {
  try {
    const b = await req.json().catch(() => ({}))
    const { data: client, error } = await admin.from('mkt_clients').select('*').eq('slug', 'crhq').eq('active', true).maybeSingle()
    if (error || !client) return new Response(JSON.stringify({ error: error?.message ?? 'no crhq client' }), { status: 500 })
    const out = await recycleMissedSlots(admin, client, new Date(), { dryRun: b.dryRun !== false })
    return new Response(JSON.stringify({ dryRun: b.dryRun !== false, ...out }), { headers: { 'Content-Type': 'application/json' } })
  } catch (e) {
    return new Response(JSON.stringify({ error: String((e as Error)?.message ?? e) }), { status: 500 })
  }
})
