-- Record WHAT the image was asked to depict alongside every review verdict.
--
-- image_review_events already stored the verdict, the reasons and the
-- measurement, but nothing anywhere stored the visual concept the prompt was
-- built from. That made the "image isn't about the post" defect unanswerable
-- from the data: the concepts behind the 19/20 Aug 2026 failures had to be
-- re-derived by re-running the concept model against the archived post bodies,
-- because they were never persisted anywhere.
--
-- Nullable and written best-effort by _shared/image.ts's logImageReview — a
-- missing concept must never cost an otherwise-good image.
alter table public.image_review_events
  add column if not exists concept text;

comment on column public.image_review_events.concept is
  'The visual scene description (from summariseToVisualConcept) that the image prompt for this attempt was built around. Null for rows written before 21 Aug 2026.';
