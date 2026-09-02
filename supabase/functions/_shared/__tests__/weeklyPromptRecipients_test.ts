// Run: deno test supabase/functions/_shared/__tests__/weeklyPromptRecipients_test.ts
//
// Pins the recipient-routing decision against every ACTIVE client slug that
// existed in production on 2 Sep 2026 (queried directly from mkt_clients
// before this change — see the commit message). Content generation in
// weekly-content-prompt/index.ts (querying mkt_content_queue, building
// themeLines/subject/text) is entirely untouched by this change and isn't
// re-tested here; this file exists solely to prove the routing table
// matches what was actually asked for, brand by brand, so a typo'd slug or
// an accidental extra suppression fails loudly instead of shipping
// silently. Imports the plain, side-effect-free module directly — NOT
// index.ts, which calls serve() at top level and would start a real HTTP
// listener as an import side effect.
import { assertEquals } from 'https://deno.land/std@0.168.0/testing/asserts.ts'
import { CLIENT_RECIPIENTS, SUPPRESSED_SLUGS, AGENCY_RECIPIENT, recipientFor } from '../weeklyPromptRecipients.ts'

Deno.test('riverside now goes to Stephanie, not the agency inbox', () => {
  assertEquals(recipientFor('riverside'), 'info@riversidesheetmetal.co.uk')
})

Deno.test('crhq now goes to Craig, not the agency inbox', () => {
  assertEquals(recipientFor('crhq'), 'craighollman7@outlook.com')
})

// The five brands explicitly named to stop entirely. Each checked
// individually (not in a loop) so a failure names the exact brand, and each
// is asserted BOTH suppressed AND, if it somehow weren't, that it would fall
// back to the agency inbox rather than leaking to some other client's
// address — belt and braces on the one mistake that would actually matter
// here (Brand A's plan reaching Brand B).
for (const slug of ['quill', 'steady', 'ouay', 'hormonely', 'ps']) {
  Deno.test(`${slug}: suppressed entirely (weekly prompt stops)`, () => {
    assertEquals(SUPPRESSED_SLUGS.has(slug), true)
  })
  Deno.test(`${slug}: has no per-client override lingering behind the suppression`, () => {
    assertEquals(CLIENT_RECIPIENTS[slug], undefined)
  })
}

// Every OTHER active brand that existed on 2 Sep 2026 and was not named in
// the task is deliberately left untouched — still reaching the agency
// inbox, exactly as before. Listed explicitly so a future brand added to
// CLIENT_RECIPIENTS/SUPPRESSED_SLUGS without a matching entry here is
// caught by a failing test, not silently assumed correct.
for (const slug of ['yca', 'neuro-decoded', 'quill-linkedin', 'adrian-linkedin']) {
  Deno.test(`${slug}: unmentioned brand keeps going to the agency inbox unchanged`, () => {
    assertEquals(SUPPRESSED_SLUGS.has(slug), false)
    assertEquals(recipientFor(slug), AGENCY_RECIPIENT)
  })
}

Deno.test('CLIENT_RECIPIENTS has exactly the two entries this task asked for — nothing extra', () => {
  assertEquals(Object.keys(CLIENT_RECIPIENTS).sort(), ['crhq', 'riverside'])
})

Deno.test('SUPPRESSED_SLUGS has exactly the five brands named — nothing extra, nothing missing', () => {
  assertEquals([...SUPPRESSED_SLUGS].sort(), ['hormonely', 'ouay', 'ps', 'quill', 'steady'])
})

Deno.test('an entirely unknown slug (a future brand) falls back to the agency inbox, not blank/undefined', () => {
  assertEquals(recipientFor('some-brand-added-next-month'), AGENCY_RECIPIENT)
})

Deno.test('null/undefined slug falls back to the agency inbox rather than throwing', () => {
  assertEquals(recipientFor(null), AGENCY_RECIPIENT)
  assertEquals(recipientFor(undefined), AGENCY_RECIPIENT)
})
