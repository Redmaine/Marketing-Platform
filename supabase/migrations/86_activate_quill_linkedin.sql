-- =============================================================================
-- 86_activate_quill_linkedin.sql
--
-- Quill's LinkedIn company page is now live and connected to Metricool
-- (blogId 6469945, confirmed from the Metricool URL:
-- app.metricool.com/evolution/linkedin?blogId=6469945&userId=4984082).
-- Activates the placeholder row inserted by migration 78
-- (78_quill_linkedin_placeholder.sql), which was deliberately inserted
-- inactive with metricool_brand_id null pending exactly this confirmation —
-- no other pipeline code change is needed per that migration's own note
-- (midnight-cron/fillClientGap/schedule-to-metricool/metricool-weekly-pull
-- all read mkt_clients dynamically).
--
-- connected_platforms already = ['linkedin'] and the Tue/Thu/Sat 08:00
-- mkt_content_schedule rows already exist and are active (both set by
-- migration 78) — confirmed live before writing this, nothing to change
-- there.
--
-- master_prompt is replaced with the brief's more specific version — adds
-- explicit proof points (Riverside Sheet Metal's 13.91% month-one
-- engagement rate, CRHQ's automated nightly-scrape pipeline) and two new
-- angles (AI-in-public-marketing, what makes Quill different from a
-- traditional agency) that the original placeholder prompt didn't have.
-- =============================================================================

update public.mkt_clients
set
  metricool_brand_id = '6469945',
  active = true,
  master_prompt = 'You are writing a LinkedIn company page post for Quill, an AI-powered social media agency run entirely by AI. Voice: confident, direct, first person as Quill. Content must be about one of the following: what Quill does and how it works, a specific result or proof point from a client (Riverside Sheet Metal — 13.91% engagement rate in month one; CRHQ — automated from nightly YouTube scrape), the AI-in-public-marketing angle, or what makes Quill different from traditional agencies. Never use emojis. Never use exclamation marks. Single space after every full stop. Maximum 200 words. End with byquill.co.uk.'
where slug = 'quill-linkedin';
