-- =============================================================================
-- 07_seed.sql — admin + first two clients + sample tasks/performance
-- Run last. Safe to re-run (guarded by NOT EXISTS).
-- =============================================================================

-- AGENCY ADMIN — the email Adrian logs in with (magic link).
-- Add more admin emails here if needed.
insert into public.mkt_admins (email) values ('adrian@yourcompanyai.co.uk')
on conflict (email) do nothing;

-- ---- Client 1: Your Company AI ----
insert into public.mkt_clients (name, short_name, industry, location, website, contact_name, contact_email,
  tier, monthly_fee, billing_day, tone_of_voice, key_services, target_customer,
  content_pillars, post_days, post_time, google_rating, review_count, traffic_light, next_task,
  brand_primary_color, brand_secondary_color, website_score, website_score_breakdown, active)
select 'Your Company AI', 'YCA', 'Marketing & Software', 'Littlehampton, West Sussex', 'https://yourcompanyai.co.uk',
  'Adrian Fielding', 'adrian@yourcompanyai.co.uk', 'accelerate', 1500, 1,
  'Direct, plain-spoken, confident. No corporate fluff.',
  'Marketing automation, websites, AI tools for small UK businesses',
  'Small UK trades and service businesses who want more customers without the agency price tag',
  array['Behind the scenes','Customer wins','Practical tips','Local'],
  array['Monday','Wednesday','Friday'], '09:00', 4.9, 27, 'green', 'Approve 3 posts',
  '#E84B35', '#1C2B3A', 86, '{"mobile":90,"copy":88,"cta":80,"trust":86}'::jsonb, true
where not exists (select 1 from public.mkt_clients where name = 'Your Company AI');

-- ---- Client 2: Problem. Solution. ----
insert into public.mkt_clients (name, short_name, industry, location, website, contact_name, contact_email,
  tier, monthly_fee, billing_day, tone_of_voice, key_services, target_customer,
  content_pillars, post_days, post_time, google_rating, review_count, traffic_light, next_task,
  brand_primary_color, brand_secondary_color, website_score, website_score_breakdown, active)
select 'Problem. Solution.', 'Problem. Solution.', 'Business Consultancy', 'Brighton, East Sussex', 'https://problemsolution.co.uk',
  'Sam Reed', 'sam@problemsolution.co.uk', 'growth', 750, 15,
  'Warm, sharp, a little witty. Speaks human.',
  'Operations consultancy and process fixes for growing SMEs',
  'Founders of 10–50 person businesses feeling the growing pains',
  array['Problems we solve','Client stories','Frameworks','Hot takes'],
  array['Tuesday','Thursday'], '08:30', 4.7, 14, 'amber', 'Reply to 2 reviews',
  '#2E4057', '#F59E0B', 72, '{"mobile":74,"copy":80,"cta":62,"trust":70}'::jsonb, true
where not exists (select 1 from public.mkt_clients where name = 'Problem. Solution.');

-- ---- Sample tasks (today) ----
insert into public.mkt_tasks (client_id, task, task_type, priority, overdue, due_date, completed)
select c.id, 'Approve 3 Facebook posts', 'generate_posts', 1, false, current_date, false
from public.mkt_clients c where c.short_name = 'YCA'
and not exists (select 1 from public.mkt_tasks t where t.client_id = c.id and t.task = 'Approve 3 Facebook posts');

insert into public.mkt_tasks (client_id, task, task_type, priority, overdue, due_date, completed)
select c.id, 'Reply to 2 new Google reviews', 'review_response', 1, true, current_date - 1, false
from public.mkt_clients c where c.name = 'Problem. Solution.'
and not exists (select 1 from public.mkt_tasks t where t.client_id = c.id and t.task = 'Reply to 2 new Google reviews');

insert into public.mkt_tasks (client_id, task, task_type, priority, overdue, due_date, completed)
select c.id, 'June report due', 'report_due', 2, false, current_date + 2, false
from public.mkt_clients c where c.short_name = 'YCA'
and not exists (select 1 from public.mkt_tasks t where t.client_id = c.id and t.task = 'June report due');

-- ---- Sample performance (last 6 weeks per client) ----
insert into public.mkt_performance (client_id, week_start, reach, impressions, engagement, new_reviews, avg_rating, posts_published, ad_spend)
select c.id, (current_date - (w * 7))::date,
  (2000 + w*350)::int, (5200 + w*600)::int, (180 + w*22)::int, (w % 3), 4.8, 3, 0
from public.mkt_clients c
cross join generate_series(0,5) as w
where c.active = true
and not exists (
  select 1 from public.mkt_performance p
  where p.client_id = c.id and p.week_start = (current_date - (w * 7))::date
);
