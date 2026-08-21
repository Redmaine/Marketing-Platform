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

// ── Machine direction: UTC instant -> UK wall-clock, as an ISO-like string ─
//
// The exact inverse of ukTimeSlotToUtc, and deliberately NOT one of the
// display helpers below: this is for an API that wants a *local* datetime in
// one field and its timezone in another, so it must stay machine-parseable
// ("YYYY-MM-DDTHH:mm:ss", no zone suffix, no prettifying).
//
// It exists for Metricool's publicationDate: { dateTime, timezone }. That
// payload was previously built with slot.toISOString().slice(0, 19) — the
// UTC wall-clock reading — while declaring timezone 'Europe/London', so
// Metricool interpreted the UTC reading as a London time.
//
// That mislabelling was invisible for a long time because it cancelled out
// an equal-and-opposite storage bug: pre-ukTimeSlotToUtc, an intended 07:30
// UK was stored as 07:30 UTC, and sending "07:30" labelled London happened to
// publish at exactly the right moment. Once storage was fixed (5a2faac) the
// stored instant became 06:30 UTC, and the same mislabelling started
// scheduling posts a full hour EARLY. Confirmed live 21 Aug 2026 against the
// real Metricool account. Anything building that payload must use this, not
// toISOString().
export function ukWallClockIso(d: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/London',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  }).formatToParts(d)
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '00'
  // Some runtimes render midnight as hour "24" under hour12:false; normalise.
  const hh = get('hour') === '24' ? '00' : get('hour')
  return `${get('year')}-${get('month')}-${get('day')}T${hh}:${get('minute')}:${get('second')}`
}

// ── Display direction: UTC instant -> UK-local formatted string ───────────
//
// ukTimeSlotToUtc above solves the STORAGE direction (a UK wall-clock time
// in, the correct UTC instant out). Everything below is the other direction,
// and it exists because the storage fix left a matching read-side gap:
// timestamps are stored correctly in UTC, but every place a human actually
// READS one was rendering the raw UTC value. The Supabase Edge runtime's own
// local timezone is UTC (see the note at the top of this file), and so is
// Netlify's, so a bare toISOString() — or a toLocaleString() with no
// timeZone option — renders UTC, not UK. During BST that is an hour early:
// a 22:00 UK post read back as "21:00", and generate-daily-status's
// generated_at said 21:00 for a file written at 22:00 UK.
//
// The offset is NEVER hardcoded to +1. These use Intl with
// timeZone: 'Europe/London', the same tzdata authority ukTimeSlotToUtc's
// shortOffset lookup uses, so they are correct on both sides of the
// late-October BST->GMT transition without any code change. timeZoneName:
// 'short' additionally renders the live abbreviation ("BST" or "GMT"), so
// the rendered string says which one it is rather than leaving the reader
// to work it out.
//
// STRICTLY FOR DISPLAY. Never feed the output of these back into a query,
// a sort, a comparison, or an API payload — those must stay UTC ISO.

type TimeInput = Date | string | number | null | undefined

function toDate(input: TimeInput): Date | null {
  if (input === null || input === undefined || input === '') return null
  const d = input instanceof Date ? input : new Date(input)
  return isNaN(d.getTime()) ? null : d
}

// "BST" during British Summer Time, "GMT" the rest of the year — read from
// tzdata for the given instant, not assumed.
export function ukZoneLabel(input: TimeInput): string {
  const d = toDate(input) ?? new Date()
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', timeZoneName: 'short' })
    .formatToParts(d)
    .find((p) => p.type === 'timeZoneName')?.value ?? 'GMT'
}

// "21 Aug 2026, 22:00 BST" / "15 Dec 2026, 22:00 GMT"
export function formatUkDateTime(input: TimeInput, fallback = '—'): string {
  const d = toDate(input)
  if (!d) return fallback
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London',
    day: 'numeric', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: false,
    timeZoneName: 'short',
  }).format(d)
}

// "22:00 BST" — time of day only, for lists that already show the date.
export function formatUkTime(input: TimeInput, fallback = '—'): string {
  const d = toDate(input)
  if (!d) return fallback
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London',
    hour: '2-digit', minute: '2-digit', hour12: false,
    timeZoneName: 'short',
  }).format(d)
}

// Date only, UK-local calendar day — "21 August 2026". Takes the same
// Intl options object every existing date label in this codebase uses, just
// with the timeZone pinned so the UK's day is used rather than the
// runtime's. A timestamp of 23:30 UTC in BST is 00:30 the NEXT day in the
// UK, which is the day a reader would name; without the pin these labels
// silently print yesterday.
export function formatUkDate(
  input: TimeInput,
  opts: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'long', year: 'numeric' },
  fallback = '—',
): string {
  const d = toDate(input)
  if (!d) return fallback
  return new Intl.DateTimeFormat('en-GB', { ...opts, timeZone: 'Europe/London' }).format(d)
}
