-- Queryable record of every generated-image safety review.
--
-- The face/text backstop rejects and regenerates images that render an
-- identifiable face or legible markings. Without a durable log the only
-- evidence it ran is console output, which Supabase drops after ~24h — so
-- "it's been quiet" would be indistinguishable from "it silently stopped
-- working". This is the table that makes the difference checkable:
--
--   -- how often is it firing, and on what?
--   select verdict, count(*) from image_review_events
--    where created_at > now() - interval '7 days' group by verdict;
--
--   -- what is actually being caught?
--   select client_name, attempt, reasons from image_review_events
--    where verdict = 'reject' order by created_at desc limit 50;
--
-- EVERY attempt is written, passes included, not just rejections. A rejection
-- count alone cannot distinguish "nothing is being caught because generation
-- got cleaner" from "nothing is being caught because the reviewer is erroring
-- out and defaulting to pass" — logging passes makes the denominator visible.
create table if not exists public.image_review_events (
  id                uuid        primary key default gen_random_uuid(),
  content_queue_id  uuid,
  client_id         uuid,
  client_name       text,
  platform          text,
  attempt           integer     not null,
  verdict           text        not null check (verdict in ('pass', 'reject', 'error', 'exhausted')),
  -- Human-readable threshold breaches, e.g.
  -- ["TEXT: \"B166\" (registration) legibility 0.55 (>=0.4)"]
  reasons           jsonb       not null default '[]'::jsonb,
  -- The raw measurement the verdict was computed from, kept so a threshold
  -- change can be re-evaluated against real history rather than guessed at.
  measurement       jsonb,
  created_at        timestamptz not null default now()
);

-- content_queue_id is intentionally NOT a foreign key: a rejected attempt is
-- worth keeping even if the post it belonged to is later deleted, and image
-- review also needs to be loggable for a generation that never produced a
-- queue row at all.
create index if not exists image_review_events_created_idx
  on public.image_review_events (created_at desc);

create index if not exists image_review_events_verdict_idx
  on public.image_review_events (verdict, created_at desc);

create index if not exists image_review_events_queue_idx
  on public.image_review_events (content_queue_id);

-- Service-role only, same as the other ops tables in this project — written
-- by the image pipeline, read by whoever is checking on it. Nothing in a
-- browser touches this.
alter table public.image_review_events enable row level security;
