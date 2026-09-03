// Netlify Background Function: outreach-places-worker-background
//
// Google Places enrichment for outreach_prospects. Starts with the
// salon/hair/beauty slice: 17,154 rows, of which 16,937 have no website_url
// and ALL 17,154 have no postcode (counted against the live table).
//
// Background function (the `-background` suffix is what tells Netlify) for
// the same reason as opportunity-scanner-worker-background: a 15-minute
// budget rather than a request timeout. At the ~1.1s/lookup this paces to,
// one invocation covers roughly 700-800 prospects, so the full slice is
// ~22 runs. Resumable by design — see UNATTEMPTED below — so re-invoking
// simply continues; there is no cursor to keep or corrupt.
//
// NOTHING IS ACCEPTED ON THE STRENGTH OF BEING THE TOP RESULT. Every
// candidate goes through netlify/lib/placesVerify.mjs, which is pure,
// dependency-free, and unit-tested against the three real failures from the
// manual test (Kingston-Jamaica name twin, same-shopping-centre retailer,
// "Vision" prospect matched to a solar installer and an eye clinic). Run
// `node netlify/lib/__tests__/placesVerify.test.mjs`.
//
// EVERY prospect gets a row in outreach_enrichment_attempts — accepted,
// unverified, rejected or not_found — reusing the exact stage/outcome/detail/
// candidates shape the email pilot established. A prospect this worker could
// not match is a visible logged reason, never an absence of data.
//
// Required Netlify site env vars:
//   SUPABASE_URL, SUPABASE_SERVICE_KEY, INTERNAL_SECRET, GOOGLE_PLACES_API_KEY
// Optional:
//   PLACES_COST_PER_CALL_USD  (see COST, below — no default is invented)
import { createClient } from '@supabase/supabase-js';
import { pickMatch, extractPostcode } from '../lib/placesVerify.mjs';

const PLACES_ENDPOINT = 'https://places.googleapis.com/v1/places:searchText';

// FIELD MASK AND BILLING. Places API (New) bills by the most expensive field
// class requested, not per field. id/displayName/formattedAddress/
// addressComponents/types sit in the Pro tier; rating and userRatingCount are
// Enterprise. Asking for the ratings therefore moves EVERY call in this
// worker up a pricing tier — which is a real, deliberate trade, because the
// ratings are the entire point of the personalisation line. It is called out
// here so the cost is a decision on the record rather than a surprise on a
// bill. The tier is reported in the run summary.
const FIELD_MASK = [
  'places.id',
  'places.displayName',
  'places.formattedAddress',
  'places.addressComponents',
  'places.types',
  'places.rating',            // Enterprise SKU
  'places.userRatingCount',   // Enterprise SKU
].join(',');
const BILLING_TIER = 'Text Search — Enterprise (ratings requested)';

const DEFAULT_LIMIT = 100;      // the pilot size
const PACE_MS = 1100;           // stay well inside Places' QPS budget
const MAX_RUN_MS = 13 * 60_000; // leave headroom inside Netlify's 15 min

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export default async (req) => {
  const started = Date.now();

  // Public Netlify URL — same shared-secret gate as
  // opportunity-scanner-worker-background, because an open endpoint here
  // would let anyone burn real, paid Places calls.
  const auth = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '').trim();
  if (!process.env.INTERNAL_SECRET || auth !== process.env.INTERNAL_SECRET) {
    return new Response(JSON.stringify({ ok: false, error: 'unauthorised' }), { status: 401 });
  }

  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) {
    // Fail loudly and immediately rather than logging 100 identical failures.
    return new Response(JSON.stringify({
      ok: false,
      error: 'GOOGLE_PLACES_API_KEY is not set — nothing was attempted and no prospect was touched.',
    }), { status: 500 });
  }

  let body = {};
  try { body = await req.json(); } catch { /* defaults below */ }
  const limit = Math.max(1, Math.min(Number(body.limit) || DEFAULT_LIMIT, 1000));
  const industry = body.industry ?? 'Hairdressing and beauty';
  // dry_run exercises selection, the API call and the full verification, and
  // writes the attempts rows — but never touches outreach_prospects. Used to
  // see what a run WOULD accept before letting it write.
  const dryRun = body.dry_run === true;

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

  // UNATTEMPTED: places_status IS NULL is the whole resume condition. A row
  // is stamped the moment it is decided — including on reject/not_found — so
  // a re-run never re-pays for a prospect it has already answered.
  const { data: prospects, error: selErr } = await supabase
    .from('outreach_prospects')
    .select('id, company_name, location, city, country')
    .eq('industry', industry)
    .is('places_status', null)
    .eq('do_not_contact', false)
    .order('created_at', { ascending: true })
    .limit(limit);

  if (selErr) {
    return new Response(JSON.stringify({ ok: false, error: `select failed: ${selErr.message}` }), { status: 500 });
  }

  const { data: runRow } = await supabase
    .from('outreach_enrichment_runs')
    .insert({
      triggered_by: body.triggered_by ?? 'outreach-places-worker',
      filter_industry: industry, stages: 'places', attempted: 0,
    })
    .select('id').single();
  const runId = runRow?.id ?? null;

  const tally = { attempted: 0, accepted: 0, unverified: 0, rejected: 0, not_found: 0, api_error: 0,
                  with_rating: 0, without_rating: 0, api_calls: 0 };
  const errors = [];

  for (const p of prospects ?? []) {
    if (Date.now() - started > MAX_RUN_MS) {
      errors.push(`time budget reached after ${tally.attempted} prospects — re-invoke to continue`);
      break;
    }
    tally.attempted++;
    const t0 = Date.now();

    // company_name + the Companies House town. Country is pinned in the query
    // text as well as checked afterwards: it narrows the search rather than
    // relying solely on the post-hoc country gate.
    const where = [p.city || p.location, 'United Kingdom'].filter(Boolean).join(', ');
    const query = `${p.company_name}, ${where}`;

    let places = [], httpStatus = null, apiError = null;
    try {
      const res = await fetch(PLACES_ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': apiKey,
          'X-Goog-FieldMask': FIELD_MASK,
        },
        body: JSON.stringify({
          textQuery: query,
          regionCode: 'GB',       // bias, not a guarantee — still gated below
          languageCode: 'en-GB',
          maxResultCount: 5,      // enough to see rivals; every one is verified
        }),
      });
      tally.api_calls++;
      httpStatus = res.status;
      const json = await res.json().catch(() => ({}));
      if (!res.ok) apiError = json?.error?.message || `HTTP ${res.status}`;
      else places = json.places ?? [];
    } catch (e) {
      apiError = String(e?.message ?? e);
    }

    const attempt = {
      prospect_id: p.id, run_id: runId, stage: 'places',
      url_tried: `${PLACES_ENDPOINT}?q=${encodeURIComponent(query)}`,
      http_status: httpStatus, duration_ms: Date.now() - t0,
    };

    if (apiError) {
      tally.api_error++;
      errors.push(`${p.company_name}: ${apiError}`);
      await supabase.from('outreach_enrichment_attempts').insert({
        ...attempt, outcome: 'blocked', detail: `Places API error: ${apiError}`, candidates: [],
      });
      // Deliberately NOT stamped on the prospect: an API failure is not a
      // decision about the business, and must stay eligible for a re-run.
      await sleep(PACE_MS);
      continue;
    }

    const m = pickMatch(p, places);
    const outcome = m.decision === 'accept' ? 'found'
      : m.decision === 'unverified' ? 'unverified'
      : m.decision === 'rejected' ? 'rejected' : 'not_found';

    let valueFound = null, detail = null;
    let update = { places_status: null, places_confidence: null, places_checked_at: new Date().toISOString() };

    if (m.decision === 'accept') {
      const pl = m.place;
      const rating = typeof pl.rating === 'number' ? pl.rating : null;
      const ratingCount = typeof pl.userRatingCount === 'number' ? pl.userRatingCount : null;
      if (rating !== null && ratingCount !== null) tally.with_rating++; else tally.without_rating++;
      tally.accepted++;
      valueFound = pl.formattedAddress ?? null;
      detail = m.verdict.reason;
      update = {
        ...update,
        places_status: 'accepted',
        places_confidence: m.verdict.reason,
        address: pl.formattedAddress ?? null,
        postcode: extractPostcode(pl),
        google_place_id: pl.id ?? null,
        // Null, never 0 — "no reviews yet" and "rated 0" are different facts,
        // and the outreach copy must be able to tell them apart.
        google_rating: rating,
        google_rating_count: ratingCount,
      };
    } else {
      tally[m.decision === 'unverified' ? 'unverified' : m.decision === 'rejected' ? 'rejected' : 'not_found']++;
      detail = m.candidates.length
        ? `no confident match from ${m.candidates.length} candidate(s): ` +
          m.candidates.map((c) => `"${c.name}" -> ${c.outcome} (${c.detail})`).join(' ; ')
        : 'Places returned no results for this query';
      update = { ...update, places_status: m.decision === 'unverified' ? 'unverified'
        : m.decision === 'rejected' ? 'rejected' : 'not_found', places_confidence: detail.slice(0, 500) };
    }

    await supabase.from('outreach_enrichment_attempts').insert({
      ...attempt, outcome, value_found: valueFound,
      detail: detail?.slice(0, 2000) ?? null, candidates: m.candidates,
    });

    if (!dryRun) {
      const { error: updErr } = await supabase.from('outreach_prospects').update(update).eq('id', p.id);
      if (updErr) errors.push(`${p.company_name}: prospect update failed — ${updErr.message}`);
    }

    await sleep(PACE_MS);
  }

  // COST. The call COUNT is a hard fact; the money is only as good as the
  // rate supplied. PLACES_COST_PER_CALL_USD must be set from Google's current
  // pricing for the tier named in BILLING_TIER — no rate is invented here,
  // because a made-up unit price is worse than an explicit null at 17,154
  // scale. Google's free monthly allowance is NOT modelled: it would make the
  // marginal cost look like zero right up until it isn't.
  const rate = Number(process.env.PLACES_COST_PER_CALL_USD);
  const cost = Number.isFinite(rate) && rate > 0
    ? { api_calls: tally.api_calls, usd_per_call: rate,
        estimated_usd: Number((tally.api_calls * rate).toFixed(4)), tier: BILLING_TIER }
    : { api_calls: tally.api_calls, usd_per_call: null, estimated_usd: null, tier: BILLING_TIER,
        note: 'PLACES_COST_PER_CALL_USD not set — call count is exact, money not computed' };

  if (runId) {
    await supabase.from('outreach_enrichment_runs').update({
      completed_at: new Date().toISOString(),
      attempted: tally.attempted,
      duration_ms: Date.now() - started,
      errors: errors.length ? errors.slice(0, 50) : null,
    }).eq('id', runId);
  }

  return new Response(JSON.stringify({
    ok: true, run_id: runId, dry_run: dryRun, industry, limit,
    tally, cost, errors: errors.slice(0, 20),
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
};
