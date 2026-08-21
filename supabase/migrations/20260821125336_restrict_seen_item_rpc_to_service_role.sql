-- `revoke all ... from public` in 20260821124845_legislation_permanent_send_cap.sql
-- only removes the blanket PUBLIC grant. This project's schema has default
-- privileges that separately grant EXECUTE on new public-schema functions
-- directly to `anon` and `authenticated` — confirmed via
-- get_advisors(security) immediately after that migration: it flagged
-- record_opportunity_scanner_seen_item as callable by both roles via
-- PostgREST (the same pre-existing pattern already flagged on several other
-- functions in this project, e.g. mkt_is_admin, current_account_id).
--
-- This function is SECURITY DEFINER and writes to
-- opportunity_scanner_seen_items, so anon/authenticated being able to call
-- it via /rest/v1/rpc/record_opportunity_scanner_seen_item contradicts the
-- "service-role only" intent stated in its own migration and table (RLS
-- comment: "the worker is the sole reader and writer, and nothing in any
-- browser-facing app touches this"). Revoked explicitly rather than relying
-- on the PUBLIC revoke to cascade, since it demonstrably doesn't.
revoke execute on function public.record_opportunity_scanner_seen_item(text, text, text) from anon;
revoke execute on function public.record_opportunity_scanner_seen_item(text, text, text) from authenticated;
