-- =============================================================================
-- 95_quill_linkedin_image_prompt.sql
--
-- Sets the exact on-brand image generation prompt for Quill's dedicated
-- LinkedIn company-page client (mkt_clients.slug = 'quill-linkedin',
-- metricool_brand_id 6469945) — read by buildImagePrompt
-- (_shared/image.ts) via client.visual_style.
--
-- Paired with a code change (same commit) adding post-by-post image
-- alternation for this client specifically: odd-numbered posts in the
-- schedule get an image, even-numbered don't. See
-- _shared/image.ts's quillLinkedInWantsImage / isQuillLinkedIn, gated by
-- slug exactly like the existing wantsHeadlineOverlay (CRHQ) pattern.
--
-- Caveat (flagged, not solved by this migration): Stability AI cannot
-- reliably render legible text, and _shared/image.ts always appends a
-- NO_TEXT_INSTRUCTION to every prompt for exactly that reason. This
-- prompt's explicit ask for a rendered text statement and a "Quill
-- wordmark" will likely need CRHQ's compositing approach
-- (applyForcedBWAndHeadline) extended to this client if the text needs to
-- render reliably rather than being left to chance — not built here, as
-- it's a materially bigger change than "update the image prompt".
--
-- Applied directly against the live row and read back to confirm. This
-- migration documents that same change as an idempotent UPDATE.
-- =============================================================================

UPDATE public.mkt_clients
SET visual_style = 'Clean minimal graphic. Dark slate background #1C1C2E. Single bold statement in white text, maximum 8 words, taken directly from the post copy. Small Quill wordmark bottom right in ember orange #E8410A. No people, no stock imagery, no generic business illustrations, no AI-generated faces or figures. Typography only. Professional and distinctive.'
WHERE slug = 'quill-linkedin';
