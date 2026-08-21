-- Closes a real gap in opportunity_scanner_seen_items (migration
-- 20260816093813 / 100_opportunity_scanner_seen_items.sql), found while
-- investigating a report that legislation items kept reappearing ~20 times
-- after that migration's fix had supposedly landed.
--
-- Investigation found the fix WAS genuinely deployed (Netlify deploy
-- ff247999bc2d... at 2026-08-16T11:39 UTC, "ready", and every deploy since),
-- and it does work for what it was built to catch: 16 legislation sends
-- before the fix had zero dedup at all (the actual root cause of the
-- reported repeats), and the 2 legislation sends since (18 & 20 Aug) show
-- zero overlapping items, confirmed against the real opportunity_scanner_
-- seen_items rows.
--
-- But two real gaps remained, both in the exclusion table's own design:
--
-- 1. times_seen was declared with a default and a comment claiming the
--    worker's upsert "bumps last_seen_at/times_seen" on a repeat sighting —
--    but the upsert payload never actually included times_seen, so every
--    row in production sits at times_seen = 1 forever, however many times
--    that item is genuinely re-sent. Confirmed against the live table: all
--    9 real rows are times_seen = 1. There was no working send-count at all.
--
-- 2. loadSeenItems only ever looks back SEEN_LOOKBACK_DAYS (365), so once a
--    year passes since an item's last send, it silently drops out of the
--    exclusion list and is eligible to be reported as "new" again — and
--    under the old logic, once re-sent, it would drop out again after
--    another year, indefinitely. "Permanently excluded" was never actually
--    permanent for anything with a rolling window.
--
-- record_opportunity_scanner_seen_item makes the increment atomic and
-- correct (single upsert with times_seen = times_seen + 1, avoiding the
-- read-then-write race a manual increment in the worker would have). The
-- worker's loadSeenItems is updated separately to select
-- "times_seen >= 2 OR last_seen_at >= <lookback>" so an item that has
-- already been sent twice stays excluded forever, closing the loophole —
-- while an item sent only once still ages out of the *soft* window after a
-- year, unchanged from the existing design.
create or replace function public.record_opportunity_scanner_seen_item(
  p_section text,
  p_item_key text,
  p_title text
) returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_times_seen integer;
begin
  insert into public.opportunity_scanner_seen_items
    (section, item_key, title, first_seen_at, last_seen_at, times_seen)
  values
    (p_section, p_item_key, p_title, now(), now(), 1)
  on conflict (section, item_key)
  do update set
    last_seen_at = now(),
    title         = excluded.title,
    times_seen    = public.opportunity_scanner_seen_items.times_seen + 1
  returning times_seen into v_times_seen;

  return v_times_seen;
end;
$$;

-- Service-role only, matching the table's own RLS (worker is the sole
-- reader/writer via SUPABASE_SERVICE_KEY).
revoke all on function public.record_opportunity_scanner_seen_item(text, text, text) from public;
grant execute on function public.record_opportunity_scanner_seen_item(text, text, text) to service_role;
