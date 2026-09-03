// Verification for Google Places matches against outreach_prospects.
//
// WHY THIS IS PURE, RULE-BASED CODE AND NOT AN LLM CALL.
// The brief allowed escalating this to a judgement-calling model if the
// matching turned out to need genuine judgement. It doesn't. Every one of the
// three real failures from the manual test is caught by a flat rule, and each
// by a DIFFERENT one:
//
//   "real UK company matched to a same-named business in Kingston, Jamaica"
//        -> the name matched perfectly. COUNTRY rule catches it.
//   "matched to unrelated retailers in the same shopping centre"
//        -> the location matched perfectly. NAME rule catches it.
//   "solar panel installer and an eye clinic under a 'Vision' prospect"
//        -> name and country both matched. TYPE rule catches it.
//
// Three independent gates, three independent failure modes. Adding a model
// here would make the decisions non-deterministic, unauditable, un-unit-
// testable, and would introduce fabrication risk into the one step whose
// entire job is to say "no". Rules can be proven against fixtures offline —
// which matters, because the pilot cannot run without an API key and this is
// the part that actually carries the risk.
//
// Every threshold below is a named constant so the pilot's real numbers can
// retune them without touching logic.

// ── Tunables ───────────────────────────────────────────────────────────────
// Coverage: what fraction of the prospect's DISTINCTIVE name tokens must
// appear in the Places name. 1.0 = all of them. Deliberately strict: the
// shopping-centre failure was a match that "shared a word".
export const NAME_COVERAGE_MIN = 1.0;
// Fallback for names that survive normalisation as a single blob (or where
// token coverage just misses): Dice coefficient over character bigrams.
export const NAME_SIMILARITY_MIN = 0.85;

// Legal-form suffixes. Companies House names carry these; Places trading
// names essentially never do, so they are noise on both sides.
const LEGAL_SUFFIXES = new Set([
  'ltd', 'limited', 'llp', 'lp', 'plc', 'cic', 'cio', 'co', 'company',
  'holdings', 'group', 'uk', 'gb',
]);

// Words so common in this industry that sharing one proves nothing. Used ONLY
// to decide which tokens are distinctive; they are still matched on when
// present. Note 'aesthetics'/'aesthetic' are deliberately NOT here — in a
// company name they carry real identifying weight.
const GENERIC_TOKENS = new Set([
  'hair', 'hairdressing', 'hairdressers', 'hairdresser', 'haircare',
  'beauty', 'salon', 'salons', 'studio', 'studios', 'spa', 'spas',
  'nails', 'nail', 'barber', 'barbers', 'barbershop', 'boutique',
  'the', 'and', 'of', 'for', 'by', 'at', 'on', 'in', 'a', 'an', '&',
]);

// Place types that are plausible for "Hairdressing and beauty".
export const PLAUSIBLE_TYPES = new Set([
  'beauty_salon', 'hair_salon', 'hair_care', 'barber_shop', 'nail_salon',
  'spa', 'day_spa', 'skin_care_clinic', 'massage', 'wellness_center',
  'tanning_studio', 'makeup_artist', 'health_and_beauty',
]);

// Types that actively contradict the industry. Presence of one of these AND
// absence of any plausible type is a reject — this is the rule that kills the
// solar-installer and eye-clinic matches under a "Vision" prospect.
export const CONTRADICTORY_TYPES = new Set([
  'solar_panel_installer', 'electrician', 'plumber', 'roofing_contractor',
  'general_contractor', 'car_repair', 'car_dealer', 'gas_station',
  'doctor', 'hospital', 'dentist', 'optometrist', 'ophthalmologist',
  'eye_care_clinic', 'pharmacy', 'veterinary_care', 'physiotherapist',
  'restaurant', 'cafe', 'bar', 'meal_takeaway', 'bakery', 'supermarket',
  'grocery_store', 'convenience_store', 'clothing_store', 'shoe_store',
  'jewelry_store', 'furniture_store', 'hardware_store', 'book_store',
  'bank', 'atm', 'insurance_agency', 'real_estate_agency', 'lawyer',
  'accounting', 'school', 'university', 'church', 'gym', 'fitness_center',
  'lodging', 'hotel', 'travel_agency', 'moving_company', 'storage',
]);

// ── Name handling ──────────────────────────────────────────────────────────
export function normaliseName(raw) {
  return String(raw ?? '')
    .toLowerCase()
    // Curly apostrophes and hyphens become nothing/space so "STYLE'D UP" and
    // "Style'd-Up" reduce to the same tokens.
    .replace(/[''`]/g, '')
    .replace(/[^a-z0-9&]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function nameTokens(raw) {
  return normaliseName(raw)
    .split(' ')
    .filter((t) => t && !LEGAL_SUFFIXES.has(t));
}

export function distinctiveTokens(raw) {
  return nameTokens(raw).filter((t) => !GENERIC_TOKENS.has(t) && t.length > 1);
}

// Dice coefficient over character bigrams — a similarity that degrades
// gracefully on word-order changes and small spelling differences, unlike
// exact equality, and needs no dependency.
export function similarity(a, b) {
  const bigrams = (s) => {
    const t = normaliseName(s).replace(/\s/g, '');
    const out = new Map();
    for (let i = 0; i < t.length - 1; i++) {
      const g = t.slice(i, i + 2);
      out.set(g, (out.get(g) ?? 0) + 1);
    }
    return out;
  };
  const A = bigrams(a); const B = bigrams(b);
  if (!A.size || !B.size) return 0;
  let shared = 0;
  for (const [g, n] of A) shared += Math.min(n, B.get(g) ?? 0);
  return (2 * shared) / (
    [...A.values()].reduce((s, n) => s + n, 0) +
    [...B.values()].reduce((s, n) => s + n, 0)
  );
}

// Does the Places name genuinely correspond to the prospect name?
export function checkName(prospectName, placeName) {
  const wanted = distinctiveTokens(prospectName);
  const haveTokens = new Set(nameTokens(placeName));
  const sim = similarity(prospectName, placeName);

  if (!wanted.length) {
    // e.g. "THE HAIR SALON LTD" — nothing identifying survives. Cannot be
    // verified by name at all; never auto-accept on a generic-only name.
    return { ok: false, weak: true, coverage: 0, similarity: sim,
      reason: `prospect name has no distinctive tokens (all generic/legal): "${prospectName}"` };
  }
  const hit = wanted.filter((t) => haveTokens.has(t));
  const coverage = hit.length / wanted.length;

  if (coverage >= NAME_COVERAGE_MIN) {
    return { ok: true, weak: false, coverage, similarity: sim,
      reason: `all ${wanted.length} distinctive token(s) present [${wanted.join(', ')}]` };
  }
  if (sim >= NAME_SIMILARITY_MIN) {
    return { ok: true, weak: false, coverage, similarity: sim,
      reason: `token coverage ${coverage.toFixed(2)} but string similarity ${sim.toFixed(2)} >= ${NAME_SIMILARITY_MIN}` };
  }
  return { ok: false, weak: false, coverage, similarity: sim,
    reason: `only ${hit.length}/${wanted.length} distinctive token(s) matched [want: ${wanted.join(', ')}], similarity ${sim.toFixed(2)}` };
}

// ── Location handling ──────────────────────────────────────────────────────
// Places (New) returns addressComponents[]; each has types[] and short/longText.
export function componentOf(place, type) {
  const c = (place?.addressComponents ?? []).find((x) => (x.types ?? []).includes(type));
  return c ? { short: c.shortText ?? null, long: c.longText ?? null } : null;
}

export function countryCode(place) {
  const c = componentOf(place, 'country');
  if (c?.short) return c.short.toUpperCase();
  // Fallback for a response without components: trailing country in the
  // formatted address. Deliberately conservative — unknown is NOT treated as
  // UK, because "assume UK" is exactly how a Kingston, Jamaica match lands.
  const f = String(place?.formattedAddress ?? '').toLowerCase();
  if (/\b(united kingdom|uk)\s*$/.test(f)) return 'GB';
  return null;
}

// UK postcode, full form. Anchored to a word boundary so it does not pick a
// house number out of the middle of a street name.
export const UK_POSTCODE_RE = /\b([A-Z]{1,2}\d[A-Z\d]?)\s*(\d[A-Z]{2})\b/i;

export function extractPostcode(place) {
  const c = componentOf(place, 'postal_code');
  if (c?.long) return c.long.toUpperCase().replace(/\s+/g, ' ').trim();
  const m = UK_POSTCODE_RE.exec(String(place?.formattedAddress ?? ''));
  return m ? `${m[1].toUpperCase()} ${m[2].toUpperCase()}` : null;
}

const normTown = (s) => String(s ?? '')
  .toLowerCase().replace(/[^a-z\s]/g, ' ').replace(/\s+/g, ' ').trim();

// Compare the prospect's Companies House town against the Places locality /
// postal town. Returns 'match' | 'mismatch' | 'unknown'.
export function checkCity(prospectCity, place) {
  const want = normTown(prospectCity);
  if (!want) return { verdict: 'unknown', reason: 'prospect has no city' };
  const candidates = ['locality', 'postal_town', 'administrative_area_level_2', 'administrative_area_level_1']
    .map((t) => componentOf(place, t)?.long)
    .filter(Boolean).map(normTown);
  const formatted = normTown(place?.formattedAddress);
  if (!candidates.length && !formatted) return { verdict: 'unknown', reason: 'no locality on place' };
  // Substring both ways handles "Walton-On-Thames" vs "Walton on Thames" and
  // "Plymouth, Devon" vs "Plymouth" once punctuation is stripped.
  const hit = candidates.find((c) => c === want || c.includes(want) || want.includes(c));
  if (hit) return { verdict: 'match', reason: `locality "${hit}" matches prospect city "${want}"` };
  if (formatted.includes(want)) return { verdict: 'match', reason: `prospect city "${want}" present in formatted address` };
  return { verdict: 'mismatch', reason: `prospect city "${want}" not found in [${candidates.join(' | ') || 'none'}]` };
}

// ── Type handling ──────────────────────────────────────────────────────────
// 'plausible' | 'contradictory' | 'neutral'
export function checkTypes(place) {
  const types = (place?.types ?? []).map((t) => String(t).toLowerCase());
  const good = types.filter((t) => PLAUSIBLE_TYPES.has(t));
  if (good.length) return { verdict: 'plausible', reason: `type(s) [${good.join(', ')}]` };
  const bad = types.filter((t) => CONTRADICTORY_TYPES.has(t));
  if (bad.length) return { verdict: 'contradictory', reason: `type(s) [${bad.join(', ')}] contradict hairdressing/beauty` };
  return { verdict: 'neutral', reason: `no beauty type and no contradicting type [${types.join(', ') || 'none'}]` };
}

// ── The decision ───────────────────────────────────────────────────────────
// 'accept' | 'unverified' | 'reject', with the reason that decided it.
// Order matters: cheapest and most absolute disqualifiers first, so the
// recorded reason is the REAL one rather than whichever gate ran last.
export function verifyCandidate(prospect, place) {
  const cc = countryCode(place);
  if (cc !== 'GB') {
    return { decision: 'reject', reason: `outside the UK — country ${cc ?? 'unknown'}, expected GB`, gate: 'country' };
  }
  const name = checkName(prospect.company_name, place.displayName?.text ?? place.displayName ?? '');
  if (!name.ok) {
    return { decision: 'reject', reason: `name does not correspond — ${name.reason}`, gate: 'name', name };
  }
  const types = checkTypes(place);
  if (types.verdict === 'contradictory') {
    return { decision: 'reject', reason: `wrong kind of business — ${types.reason}`, gate: 'type', name, types };
  }
  const city = checkCity(prospect.city || prospect.location, place);
  if (city.verdict === 'mismatch') {
    // In the UK but the wrong town: explicitly NOT accepted, and explicitly
    // not discarded either — the brief calls for this to be visible.
    return { decision: 'unverified', reason: `right country, wrong place — ${city.reason}`, gate: 'city', name, types, city };
  }
  if (types.verdict === 'neutral') {
    return { decision: 'unverified', reason: `name and location fit but ${types.reason}`, gate: 'type-neutral', name, types, city };
  }
  if (city.verdict === 'unknown') {
    return { decision: 'unverified', reason: `name and type fit but city could not be confirmed — ${city.reason}`, gate: 'city-unknown', name, types, city };
  }
  return {
    decision: 'accept',
    reason: `name (${name.reason}); ${city.reason}; ${types.reason}`,
    gate: 'all', name, types, city,
  };
}

// Evaluate every returned place and pick the single best ACCEPTED one.
// Returns the decision plus a per-candidate trail for the attempts row, so a
// rejection records what was considered and why each was turned down.
export function pickMatch(prospect, places) {
  const trail = [];
  let best = null;
  for (const p of places ?? []) {
    const v = verifyCandidate(prospect, p);
    trail.push({
      place_id: p.id ?? null,
      name: p.displayName?.text ?? p.displayName ?? null,
      address: p.formattedAddress ?? null,
      outcome: v.decision,
      detail: v.reason,
    });
    if (v.decision === 'accept') {
      const score = (v.name?.similarity ?? 0) + (v.name?.coverage ?? 0);
      if (!best || score > best.score) best = { place: p, verdict: v, score };
    }
  }
  if (best) return { decision: 'accept', place: best.place, verdict: best.verdict, candidates: trail };
  // Nothing accepted. Prefer reporting an 'unverified' near-miss over a flat
  // "not found" — a wrong-town match is a different and more useful fact.
  const near = trail.find((t) => t.outcome === 'unverified');
  if (near) return { decision: 'unverified', place: null, verdict: null, candidates: trail };
  if (trail.length) return { decision: 'rejected', place: null, verdict: null, candidates: trail };
  return { decision: 'not_found', place: null, verdict: null, candidates: trail };
}
