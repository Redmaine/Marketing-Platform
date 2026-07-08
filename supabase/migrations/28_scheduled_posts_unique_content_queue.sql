-- schedule-to-metricool upserts mkt_scheduled_posts with
-- `onConflict: 'content_queue_id'`, but no unique constraint existed on
-- that column — every upsert silently failed (PostgREST error, only
-- console.error'd, never surfaced). Result: mkt_scheduled_posts had only 4
-- rows total despite 27+ posts actually scheduled via mkt_content_queue,
-- and one content_queue_id had 3 duplicate rows from repeated failed
-- attempts. This is why "posts are not scheduling automatically" looked
-- worse than it was — content_queue_id was updating fine, but this
-- secondary tracking table (used by the dashboard's "Posts Today" view)
-- was silently not being kept in sync.

-- Dedupe: keep the most recent row per content_queue_id.
delete from mkt_scheduled_posts a
using mkt_scheduled_posts b
where a.content_queue_id = b.content_queue_id
  and a.created_at < b.created_at;

alter table mkt_scheduled_posts
  add constraint mkt_scheduled_posts_content_queue_id_key unique (content_queue_id);
