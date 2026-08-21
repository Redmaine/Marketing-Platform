// UK-local DISPLAY formatting for the ops UI — the browser-side twin of
// supabase/functions/_shared/ukTime.ts.
//
// Why this exists even though the browser already formats in local time:
// every timestamp this app renders comes out of Postgres as UTC, and a bare
// toLocaleString() renders it in whatever timezone the VIEWER's machine is
// set to. That happens to be right when the machine is in the UK and silently
// wrong the moment it isn't — on a laptop abroad, a post scheduled 22:00 UK
// reads as some other hour with nothing on screen to say so. Everything this
// platform schedules is UK-local by definition (mkt_content_schedule.time_uk
// and mkt_clients.post_time are UK wall-clock strings), so the UI pins the
// display to Europe/London and SAYS which zone it means.
//
// The offset is never hardcoded to +1. Intl reads Europe/London from tzdata,
// so these are automatically correct on both sides of the late-October
// BST -> GMT transition, and timeZoneName:'short' renders the live "BST" or
// "GMT" abbreviation rather than leaving the reader to work it out.
//
// STRICTLY FOR DISPLAY. Never feed the output of these back into a Supabase
// filter, a sort comparator, or a date-bucketing key — those stay on the raw
// UTC value / Date object exactly as they are today.

function toDate(input) {
  if (input === null || input === undefined || input === '') return null
  const d = input instanceof Date ? input : new Date(input)
  return isNaN(d.getTime()) ? null : d
}

// "BST" or "GMT" for the given instant, read from tzdata rather than assumed.
export function ukZoneLabel(input) {
  const d = toDate(input) ?? new Date()
  return (
    new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', timeZoneName: 'short' })
      .formatToParts(d)
      .find((p) => p.type === 'timeZoneName')?.value ?? 'GMT'
  )
}

// Date only, UK calendar day. Takes the same options object the call sites
// already passed to toLocaleDateString, with the timeZone pinned.
export function ukDate(input, opts = { day: 'numeric', month: 'short', year: 'numeric' }, fallback = '—') {
  const d = toDate(input)
  if (!d) return fallback
  return new Intl.DateTimeFormat('en-GB', { ...opts, timeZone: 'Europe/London' }).format(d)
}

// "22:00 BST" — time of day with its zone, for lists that show the date
// separately. This is the one that actually removes ambiguity: an unlabelled
// "22:00" is the whole problem.
export function ukTime(input, fallback = '—') {
  const d = toDate(input)
  if (!d) return fallback
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London',
    hour: '2-digit', minute: '2-digit', hour12: false,
    timeZoneName: 'short',
  }).format(d)
}

// "21 Aug 2026, 22:00 BST"
export function ukDateTime(input, fallback = '—') {
  const d = toDate(input)
  if (!d) return fallback
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London',
    day: 'numeric', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: false,
    timeZoneName: 'short',
  }).format(d)
}
