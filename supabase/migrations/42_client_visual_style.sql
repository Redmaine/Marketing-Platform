-- =============================================================================
-- 42_client_visual_style.sql — mkt_clients.visual_style
--
-- Free-text visual brief folded into every AI-generated post's image prompt
-- alongside a summary of the post copy — see generatePostImage in
-- _shared/image.ts, called from fill.ts after each post is queued.
--
-- Apply via `supabase db query --linked`, not `db push` (see migration 35's
-- history — the schema_migrations ledger has a pre-existing gap).
-- =============================================================================

ALTER TABLE public.mkt_clients ADD COLUMN IF NOT EXISTS visual_style text;

UPDATE public.mkt_clients SET visual_style =
  'dark navy background, ember orange accent, clean professional, phone or mobile device imagery, no people, geometric and minimal'
  WHERE slug = 'yca';

UPDATE public.mkt_clients SET visual_style =
  'black background, crimson red accent, bold and direct, abstract problem or solution imagery, no people'
  WHERE slug = 'ps';

UPDATE public.mkt_clients SET visual_style =
  'dark slate background, ember orange accent, bold typographic style, agency and content creation themes, no people'
  WHERE slug = 'quill';

UPDATE public.mkt_clients SET visual_style =
  'warm cream and teal, soft and natural, abstract body or botanical imagery, warm lighting, no clinical imagery, no people'
  WHERE slug = 'hormonely';

UPDATE public.mkt_clients SET visual_style =
  'forest green and gold, illustrated storybook aesthetic, warm and magical, abstract children''s book imagery, no specific children'
  WHERE slug = 'ouay';

UPDATE public.mkt_clients SET visual_style =
  'dark charcoal, steel blue accent, industrial and precise, metal texture or fabrication imagery, no people'
  WHERE slug = 'riverside';

UPDATE public.mkt_clients SET visual_style =
  'near black background, military tactical aesthetic, map or intelligence imagery, dark and authoritative, no people'
  WHERE slug = 'crhq';

UPDATE public.mkt_clients SET visual_style =
  'dark navy, blue accent, calm and supportive, abstract habit or wellness imagery, clean and minimal, no medical imagery'
  WHERE slug = 'steady';

UPDATE public.mkt_clients SET visual_style =
  'deep teal background, amber accent, calm and clear, abstract neural or connection imagery, never clinical, warm and approachable'
  WHERE slug = 'neuro-decoded';
