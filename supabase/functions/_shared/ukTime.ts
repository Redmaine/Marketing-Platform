// Converts a UK-local wall-clock time ("HH:MM", as stored in
// mkt_content_schedule.time_uk and mkt_clients.post_time) into the correct
// UTC instant on a given day — accounting for BST/GMT, not just adding a
// fixed offset.
//
// Bug this fixes (found 18 Aug 2026): every scheduling call site built the
// slot with `new Date(day); slot.setHours(hh, mm, 0, 0)`. setHours() sets
// the hour/minute in the RUNTIME's own local timezone — and the Supabase
// Edge Function runtime's local timezone is UTC (confirmed directly against
// a deployed function: Intl.DateTimeFormat().resolvedOptions().timeZone ===
// "UTC"), not Europe/London. So "07:30" was being written as 07:30 UTC, not
// 07:30 UK — during BST (UTC+1) that is 08:30 UK, an hour late. Confirmed
// live: CRHQ's Instagram slot is configured 07:30 UK and was firing 08:30 UK.
//
// This affects EVERY brand doing server-side scheduling, not just ones with
// mkt_content_schedule rows — mkt_clients.post_time funnels through the
// exact same setHours() call as a fallback, so a post_time-only brand hits
// the identical bug via a different code path.
//
// The existing dayOfWeekUK()/ukDateStr() helpers (_shared/generate.ts) solve
// the adjacent problem — reading UK-local day/weekday OUT of a Date — using
// Intl.DateTimeFormat(..., { timeZone: 'Europe/London' }). Nothing in the
// codebase did the reverse: building a UTC instant FROM a UK-local time.
// That is what this file adds.
//
// dayOfWeekUK is duplicated below rather than imported from generate.ts —
// same call already made three times elsewhere in this codebase
// (generate-daily-status, weekly-content-prompt, generate-graphics all keep
// a local copy). generate.ts pulls in prompts.ts's whole prompt-template
// chain, which schedule-to-metricool (a dispatch function) has no business
// depending on just to get a same weekday check platformSchedule.ts already
// had to solve the same way.

// 0 = Sunday .. 6 = Saturday, UK-local. Identical to generate.ts's own copy.
export function dayOfWeekUK(d: Date): number {
  return Number(
    new Intl.DateTimeFormat('en-GB', { weekday: 'short', timeZone: 'Europe/London' })
      .format(d)
      .replace(/Sun/, '0').replace(/Mon/, '1').replace(/Tue/, '2').replace(/Wed/, '3')
      .replace(/Thu/, '4').replace(/Fri/, '5').replace(/Sat/, '6'),
  )
}

// Given `day` (any Date that falls on the intended calendar day — its own
// time-of-day is ignored) and a UK-local "HH:MM", returns the Date
// representing that wall-clock time in Europe/London on that day, correctly
// adjusted for whichever of BST/GMT is in effect.
//
// The UK calendar date is read via Intl, not via day's own UTC getters —
// deliberately, so a `day` sitting near a UTC/UK midnight mismatch (the
// runtime's own "today" can differ from the UK's "today" for up to an hour
// around midnight during BST) still resolves to the UK date a human would
// actually call "today", matching what dayOfWeekUK(day) would independently
// agree is the current UK weekday.
export function ukTimeSlotToUtc(day: Date, hhmm: string): Date {
  const [hh, mm] = String(hhmm || '09:00').split(':').map((n) => Number(n) || 0)

  const dateParts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(day)
  const y = Number(dateParts.find((p) => p.type === 'year')?.value)
  const mo = Number(dateParts.find((p) => p.type === 'month')?.value) - 1
  const d = Number(dateParts.find((p) => p.type === 'day')?.value)

  // Naive guess: treat Y/M/D/H/M as if they were already UTC.
  const guess = new Date(Date.UTC(y, mo, d, hh, mm, 0, 0))

  // What UK UTC-offset is actually in effect at that guessed instant?
  // shortOffset gives "GMT" or "GMT+1" — date-specific, so this is correct
  // on both sides of the BST/GMT transition rather than a hardcoded +1.
  const offsetParts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London', timeZoneName: 'shortOffset',
  }).formatToParts(guess)
  const offsetLabel = offsetParts.find((p) => p.type === 'timeZoneName')?.value ?? 'GMT'
  const offsetHours = Number(offsetLabel.match(/GMT([+-]\d+)?/)?.[1] ?? 0)

  // The guess assumed UTC+0; the real UK offset is offsetHours, so shift by
  // that amount to land on the correct UTC instant.
  return new Date(guess.getTime() - offsetHours * 3600_000)
}
