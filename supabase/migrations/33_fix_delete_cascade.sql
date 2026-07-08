-- Item 8a — the content-queue Delete button "did nothing" for any post that
-- had already been scheduled: mkt_scheduled_posts.content_queue_id referenced
-- the queue with the default NO ACTION rule, so the delete failed on a foreign
-- key violation (and the client swallowed the error). Recreate it ON DELETE
-- CASCADE so deleting a queue row also clears its transient scheduling mirror.
alter table mkt_scheduled_posts drop constraint if exists mkt_scheduled_posts_content_queue_id_fkey;
alter table mkt_scheduled_posts
  add constraint mkt_scheduled_posts_content_queue_id_fkey
  foreign key (content_queue_id) references mkt_content_queue(id) on delete cascade;
