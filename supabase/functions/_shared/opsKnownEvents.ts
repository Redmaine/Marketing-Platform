// Insert helper for ops_known_events (see migration 20260829120000).
//
// Call this to mark a window as "explained" BEFORE daily-ops-check next
// runs against it — a platform restart/incident just resolved, or Code (or
// anyone) is about to deliberately exercise a real production function in a
// way that could log a real edge_function_errors row that isn't a genuine
// problem. daily-ops-check reads this table and stops surfacing any
// edge_function_errors row whose timestamp falls inside a matching window
// as something Adrian needs to act on.
//
// deno-lint-ignore no-explicit-any
type Admin = any

export async function recordOpsKnownEvent(
  admin: Admin,
  opts: { startsAt: string; endsAt: string; functionName?: string | null; reason: string },
): Promise<void> {
  const { error } = await admin.from('ops_known_events').insert({
    starts_at: opts.startsAt,
    ends_at: opts.endsAt,
    function_name: opts.functionName ?? null,
    reason: opts.reason,
  })
  if (error) console.error(`[opsKnownEvents] failed to record: ${error.message}`)
}
