// Who gets each brand's weekly content-planning prompt (2 Sep 2026).
//
// Split out of weekly-content-prompt/index.ts specifically so this can be
// unit-tested without importing that file — it calls serve() at module top
// level (Deno's std http server), so importing it directly in a test starts
// a real listener as a side effect. This module has no side effects at all:
// three plain values, safe to import anywhere.
//
// Every client used to send to AGENCY_RECIPIENT regardless — one inbox
// getting 11 separate emails every Monday, most of them for brands already
// being monitored directly. Two changes, both purely about ROUTING; the
// content itself (querying mkt_content_queue, building themeLines/subject/
// text in index.ts) is completely unaware of any of this and is unchanged.

export const AGENCY_RECIPIENT = 'hello@yourcompanyai.co.uk'

// 1. Send straight to the actual client instead of the agency inbox, so
//    THEY see what's planned and can reply with updates — the reply invite
//    already in the email body assumed this, it just used to reach the
//    wrong person. riverside's address is info@riversidesheetmetal.co.uk —
//    not a guess: it's the SAME address accounts.email holds for Riverside's
//    account, and the one that genuinely logged into the platform to record
//    a real payment on INV000245 (audit_log, 2 Sep 2026) — i.e. the address
//    Stephanie personally works from, not a generic unmonitored mailbox. If
//    that's wrong, this is the one line to change.
export const CLIENT_RECIPIENTS: Record<string, string> = {
  riverside: 'info@riversidesheetmetal.co.uk', // Stephanie
  crhq: 'craighollman7@outlook.com', // Craig
}

// 2. These brands are already being watched directly, so the prompt is
//    dropped entirely rather than sent anywhere. Named explicitly rather
//    than "everyone not in CLIENT_RECIPIENTS", so adding a brand later
//    defaults to reaching AGENCY_RECIPIENT (visible, if unwanted) instead of
//    silently going nowhere.
export const SUPPRESSED_SLUGS = new Set(['quill', 'steady', 'ouay', 'hormonely', 'ps'])

// The single decision point both the cron loop and the tests use: who does
// this client's prompt go to. Never returns undefined/blank — an unmapped
// slug always falls back to the agency inbox.
export function recipientFor(slug: string | null | undefined): string {
  return (slug && CLIENT_RECIPIENTS[slug]) ?? AGENCY_RECIPIENT
}
