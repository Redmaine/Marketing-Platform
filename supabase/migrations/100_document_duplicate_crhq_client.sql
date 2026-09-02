-- 100_document_duplicate_crhq_client.sql
--
-- Two "Combat Ready HQ" rows exist in mkt_clients. This migration DELIBERATELY
-- DELETES NEITHER, and records why, because the obvious cleanup would have
-- destroyed real client data.
--
--   c14ccad0-21f8-44f0-9464-24f321bea37b  slug 'crhq'  active=true
--     Created 1 Jul 2026. The live brand: 41 mkt_content_queue rows, the blogs,
--     the schedule. Everything that references CRHQ references this one.
--
--   31a5fb2e-8eee-4a85-bf5d-0191c1154e6d  slug NULL    active=false
--     Created 29 Aug 2026 12:40:14. Holds ZERO content rows — but it is NOT
--     unreferenced, which is the point of this file. It carries:
--       * quill_onboarding_invites  46ce2f1f… (created 12:40:19, used 12:40:26)
--       * quill_onboarding_completions e6c30da9… (31 Aug 13:05), the saved
--         output of a REAL client onboarding interview, already emailed to the
--         client and internally (client_emailed / internal_emailed both true)
--
-- Deleting the duplicate would not have been a no-op. quill_onboarding_invites
-- is ON DELETE CASCADE, so the invite would have gone; quill_onboarding_completions
-- is ON DELETE SET NULL, so the completion would have survived as an orphan with
-- no brand attached. Verified against all 21 FK constraints referencing
-- mkt_clients on 2 Sep 2026 — those two tables are the only non-zero ones.
--
-- HOW IT GOT CREATED. Nothing in the tracked codebase inserts
-- quill_onboarding_invites rows, and the onboarding app never creates clients —
-- resolveInvite() only ever reads mkt_clients by the invite's client_id
-- (quill-onboarding/netlify/functions/_shared/supabase.js). The Add-client form
-- in Clients.jsx sets active=true and short_name=name, and this row has
-- active=false and short_name NULL, so it did not come from there either. The
-- row and its invite were created five seconds apart by hand (SQL/dashboard) to
-- issue an onboarding link, pointing at a NEW client row instead of the existing
-- 'crhq' one.
--
-- ⚠️ STILL OPEN, and the reason this is documented rather than quietly tidied:
-- the onboarding interview wrote its master_prompt to the DUPLICATE
-- (mkt_clients.master_prompt on 31a5fb2e, 6,202 chars — the full brand brief,
-- voice, proof points and commercial goal captured from the client). The LIVE
-- CRHQ row is still on its original 1 July master_prompt (2,651 chars), so every
-- post generated for CRHQ since 31 Aug has used the OLD brief and the client's
-- onboarding answers have never reached production. Moving it is a content
-- decision for a live brand, not a migration's call — flagged for a human.
--
-- Both rows are left in place. The duplicate is inert for content purposes
-- (active=false, and every generator filters on active=true); it is visible in
-- the Clients list only because Clients.jsx loads all rows unfiltered.

insert into public.mkt_client_notes (client_id, note)
select
  '31a5fb2e-8eee-4a85-bf5d-0191c1154e6d'::uuid,
  'DUPLICATE / DO NOT DELETE. Onboarding-only record for Combat Ready HQ, created 29 Aug 2026 to issue an onboarding invite. The live CRHQ brand is c14ccad0-21f8-44f0-9464-24f321bea37b (slug crhq). This row holds the 31 Aug onboarding invite and completion, so deleting it would cascade away the invite and orphan the completion. Its master_prompt (6202 chars) is the brief captured in that interview and has NOT been applied to the live CRHQ row, which still uses the shorter 1 Jul prompt. See migration 100.'
where not exists (
  select 1 from public.mkt_client_notes
  where client_id = '31a5fb2e-8eee-4a85-bf5d-0191c1154e6d'::uuid
    and note like 'DUPLICATE / DO NOT DELETE.%'
);
