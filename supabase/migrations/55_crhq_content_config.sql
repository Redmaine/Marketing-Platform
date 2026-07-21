-- 55 — Combat Ready HQ per-platform content configuration
--
-- DO NOT RUN THIS UNTIL THE fill.ts CHANGE IN THIS COMMIT IS DEPLOYED.
-- Before that deploy, fill.ts ignores mkt_content_schedule entirely and drives
-- every platform off mkt_clients.post_days / post_time. Running this first
-- would insert rows that nothing reads, and the connected_platforms update
-- would start generating Instagram posts on CRHQ's Facebook schedule.
--
-- Deploy order:
--   1. supabase functions deploy midnight-cron  (and any other function that
--      imports _shared/fill.ts)
--   2. run this file in the Supabase SQL editor
--
-- Facebook:  Tue/Thu/Sat 18:00  (3 posts/week, long-form analysis)
-- Instagram: Mon/Tue/Thu/Fri 07:30  (4 posts/week, 20-40 word hooks + image)
--
-- time_uk is the correct column on mkt_content_schedule (text, NOT NULL) —
-- post_time exists on mkt_clients, not here. See migration 12.

-- Remove existing CRHQ schedule rows
DELETE FROM mkt_content_schedule WHERE client_id = (
  SELECT id FROM mkt_clients WHERE slug = 'crhq'
);

-- Facebook: Tuesday, Thursday, Saturday at 18:00
INSERT INTO mkt_content_schedule
  (client_id, platform, day_of_week, time_uk, active)
SELECT id, 'facebook', unnest(ARRAY[2,4,6]), '18:00', true
FROM mkt_clients WHERE slug = 'crhq';

-- Instagram: Monday, Tuesday, Thursday, Friday at 07:30
INSERT INTO mkt_content_schedule
  (client_id, platform, day_of_week, time_uk, active)
SELECT id, 'instagram', unnest(ARRAY[1,2,4,5]), '07:30', true
FROM mkt_clients WHERE slug = 'crhq';

-- Ensure connected_platforms includes instagram, and that images are generated
-- for Instagram only (image_gen_platforms is an allow-list — see migration 51).
UPDATE mkt_clients
SET connected_platforms = '{facebook,instagram}',
    image_gen_platforms = '{instagram}'
WHERE slug = 'crhq';

-- Verification — expect 7 rows: 3 facebook @ 18:00, 4 instagram @ 07:30.
SELECT s.platform, s.day_of_week, s.time_uk, s.active
FROM mkt_content_schedule s
JOIN mkt_clients c ON c.id = s.client_id
WHERE c.slug = 'crhq'
ORDER BY s.platform, s.day_of_week;

SELECT slug, connected_platforms, image_gen_platforms
FROM mkt_clients WHERE slug = 'crhq';
