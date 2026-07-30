-- 68_crhq_visual_style_no_faces.sql
--
-- Replaces CRHQ's visual_style with a stricter no-faces brief. The previous
-- brief (migration 61 — documentary/photojournalism, black and white or
-- desaturated, Magnum Photos aesthetic) still allowed human subjects and
-- faces to appear; this version explicitly forbids faces, eyes, or any
-- identifiable human feature, restricting acceptable subjects to hands,
-- equipment, screens, maps, and from-behind silhouettes.
--
-- Same enforcement as migration 61 notes: this string is checked verbatim at
-- image time by passesStylePrefixCheck (_shared/image.ts) — the prompt sent
-- to Stability must contain it exactly, so it must not be reformatted here.
--
-- Scope note: visual_style is a single per-client field, shared by both of
-- CRHQ's image-enabled platforms (instagram and facebook — see migration 61,
-- part 3, and the file-level comment in crhq-nightly-content/index.ts: "Both
-- use the same Stability pipeline and the same mkt_clients.visual_style").
-- There is no per-platform override in the current schema, so this change
-- affects CRHQ's Facebook images too, not Instagram alone.
--
-- Also clears any CRHQ Instagram posts sitting in pending/approved with an
-- AI-generated image already attached, so nothing generated under the old
-- (faces-allowed) brief reaches the feed under the new one. Confirmed 0 rows
-- matched when this was applied — CRHQ's Instagram queue was 1 draft
-- (no image) and 5 already-scheduled posts (out of scope, untouched).
--
-- Idempotent, scoped by slug/client_id — a re-run cannot touch any other
-- brand or any CRHQ post outside the exact platform/status/image_url filter.
--
-- Apply via `supabase db query -f ... --linked` — NOT `supabase db push`.

UPDATE public.mkt_clients
SET visual_style = 'High contrast black and white or dark toned photography style. Military or intelligence operations environment. No human faces under any circumstances — hands, equipment, screens, maps, and silhouettes from behind only. Close-up details preferred over wide scenes. Acceptable subjects: hands on a tactical map, multiple screens displaying data in a dark room, military equipment close-up, a figure seen only from behind at a terminal, coffee cup beside handwritten intelligence notes, empty operations room with active screens. Never generate faces, eyes, or identifiable human features. Photorealistic. No AI tells. No posed or staged compositions.'
WHERE slug = 'crhq';

DELETE FROM public.mkt_content_queue
WHERE client_id = (SELECT id FROM public.mkt_clients WHERE slug = 'crhq')
  AND platform = 'instagram'
  AND status IN ('pending', 'approved')
  AND image_url IS NOT NULL;
