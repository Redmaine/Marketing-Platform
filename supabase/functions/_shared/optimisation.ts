// Shared lookup for the content-optimisation loop — reads the most recent
// mkt_client_optimisation row for a client and returns just the
// content_notes string that buildSystemPrompt (prompts.ts) folds into
// generation. Written by monthly-performance-pull at the end of each
// month's run; read here by fill.ts and crhq-nightly-content before
// generating. Returns null (not an error) when no row exists yet — a
// client's first month of operation generates with no notes, per spec.
// deno-lint-ignore no-explicit-any
type Admin = any

export async function latestOptimisationNotes(admin: Admin, clientId: string): Promise<string | null> {
  try {
    const { data } = await admin
      .from('mkt_client_optimisation')
      .select('content_notes, month_year')
      .eq('client_id', clientId)
      .order('month_year', { ascending: false })
      .limit(1)
      .maybeSingle()
    const notes = data?.content_notes
    return typeof notes === 'string' && notes.trim() ? notes.trim() : null
  } catch (e) {
    console.error(`[optimisation] lookup failed for client ${clientId} — ${String((e as Error)?.message ?? e)}`)
    return null
  }
}
