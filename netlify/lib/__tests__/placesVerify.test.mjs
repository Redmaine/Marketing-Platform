// Proof for netlify/lib/placesVerify.mjs.
//
// Every fixture below is shaped exactly like a Google Places API (New)
// searchText result — displayName.text, formattedAddress, addressComponents
// with types[]/shortText/longText, types[], rating, userRatingCount — so the
// logic is exercised against the real response shape, not a convenient one.
//
// The three headline cases are the three real failures from Adrian's manual
// test, reconstructed: the Kingston-Jamaica name twin, the same-shopping-
// centre retailer, and the "Vision" prospect matched to a solar installer and
// an eye clinic. Prospect names are real rows from outreach_prospects.
//
// Run: node netlify/lib/__tests__/placesVerify.test.mjs
import {
  verifyCandidate, pickMatch, extractPostcode, checkName, checkTypes, checkCity,
} from '../placesVerify.mjs';

let pass = 0, fail = 0;
const ok = (cond, label, extra = '') => {
  if (cond) { pass++; console.log(`PASS  ${label}`); }
  else { fail++; console.log(`FAIL  ${label}${extra ? `\n        ${extra}` : ''}`); }
};

// Helper: build a Places-shaped result.
const place = ({ id = 'p1', name, address, country = 'GB', town = null, postcode = null,
                 types = [], rating = undefined, count = undefined }) => {
  const components = [];
  if (town) components.push({ longText: town, shortText: town, types: ['postal_town'] });
  if (postcode) components.push({ longText: postcode, shortText: postcode, types: ['postal_code'] });
  components.push({ longText: country === 'GB' ? 'United Kingdom' : country, shortText: country, types: ['country'] });
  return {
    id, displayName: { text: name }, formattedAddress: address,
    addressComponents: components, types,
    ...(rating !== undefined ? { rating } : {}),
    ...(count !== undefined ? { userRatingCount: count } : {}),
  };
};

console.log('── The three real failures from the manual test ──');

// 1. Kingston, Jamaica. Name matches PERFECTLY. Only the country saves us.
{
  const prospect = { company_name: 'JIMINY SNIPPIT LTD', city: 'Fleet' };
  const v = verifyCandidate(prospect, place({
    name: 'Jiminy Snippit', address: '14 Harbour St, Kingston, Jamaica',
    country: 'JM', town: 'Kingston', types: ['hair_salon'],
  }));
  ok(v.decision === 'reject' && v.gate === 'country',
    'Kingston Jamaica twin -> reject on COUNTRY (name matched perfectly)', JSON.stringify(v));
}

// 2. Same shopping centre, unrelated retailer. Location matches perfectly.
{
  const prospect = { company_name: 'COCO BEACH NAIL BAR LTD', city: 'Nantwich' };
  const v = verifyCandidate(prospect, place({
    name: 'Vodafone', address: 'Unit 12, Market Centre, Nantwich CW5 5DG, UK',
    town: 'Nantwich', postcode: 'CW5 5DG', types: ['cell_phone_store'],
  }));
  ok(v.decision === 'reject' && v.gate === 'name',
    'same-shopping-centre retailer -> reject on NAME (city matched perfectly)', JSON.stringify(v));
}

// 3. "Vision" prospect -> solar installer AND eye clinic. Name token and
//    country both match; only the type contradicts.
{
  const prospect = { company_name: 'VISION HAIR AND BEAUTY LTD', city: 'Leeds' };
  const solar = place({ id: 's1', name: 'Vision Solar', address: '2 Mill Rd, Leeds LS1 4AB, UK',
    town: 'Leeds', postcode: 'LS1 4AB', types: ['solar_panel_installer'] });
  const eye = place({ id: 's2', name: 'Vision Eye Clinic', address: '9 High St, Leeds LS1 2BC, UK',
    town: 'Leeds', postcode: 'LS1 2BC', types: ['ophthalmologist', 'doctor'] });
  const vs = verifyCandidate(prospect, solar);
  const ve = verifyCandidate(prospect, eye);
  ok(vs.decision === 'reject' && vs.gate === 'type', 'Vision -> solar installer rejected on TYPE', JSON.stringify(vs));
  ok(ve.decision === 'reject' && ve.gate === 'type', 'Vision -> eye clinic rejected on TYPE', JSON.stringify(ve));
  const m = pickMatch(prospect, [solar, eye]);
  ok(m.decision === 'rejected' && m.candidates.length === 2,
    'Vision -> BOTH rejected, nothing accepted, both logged as candidates', JSON.stringify(m.decision));
}

console.log('\n── Accepting a genuine match ──');
{
  const prospect = { company_name: "STYLE'D UP LTD", city: 'Sheffield' };
  const good = place({ name: "Style'd Up Hair Studio", address: "45 Ecclesall Rd, Sheffield S11 8PN, UK",
    town: 'Sheffield', postcode: 'S11 8PN', types: ['hair_salon', 'beauty_salon'], rating: 4.9, count: 75 });
  const v = verifyCandidate(prospect, good);
  ok(v.decision === 'accept', "STYLE'D UP LTD -> Style'd Up Hair Studio accepted", JSON.stringify(v));
  ok(extractPostcode(good) === 'S11 8PN', 'postcode read from addressComponents', extractPostcode(good));
  ok(good.rating === 4.9 && good.userRatingCount === 75, 'rating + count available on the same response');
}

console.log('\n── Postcode parsing fallback (no discrete component) ──');
{
  const p = { id: 'x', displayName: { text: 'Therapy Hair' },
    formattedAddress: '3 Mutley Plain, Plymouth PL4 6JQ, United Kingdom',
    addressComponents: [{ longText: 'United Kingdom', shortText: 'GB', types: ['country'] }],
    types: ['hair_salon'] };
  ok(extractPostcode(p) === 'PL4 6JQ', 'postcode parsed out of formatted address', String(extractPostcode(p)));
}
{
  // Must not pick a house number or a street-name digit run.
  const p = { formattedAddress: '221 Baker Street, London, United Kingdom', addressComponents: [] };
  ok(extractPostcode(p) === null, 'no false postcode from a house number', String(extractPostcode(p)));
}

console.log('\n── Right country, wrong town -> unverified (not accepted, not binned) ──');
{
  const prospect = { company_name: 'HAIRXPERTS LTD', city: 'Walton-On-Thames' };
  const v = verifyCandidate(prospect, place({
    name: 'HairXperts', address: '8 Deansgate, Manchester M3 2BW, UK',
    town: 'Manchester', postcode: 'M3 2BW', types: ['hair_salon'] }));
  ok(v.decision === 'unverified' && v.gate === 'city',
    'UK but wrong city -> unverified', JSON.stringify(v));
}

console.log('\n── Town spelling / punctuation tolerance ──');
{
  const prospect = { company_name: 'HAIRXPERTS LTD', city: 'Walton-On-Thames' };
  const v = verifyCandidate(prospect, place({
    name: 'HairXperts', address: '8 Bridge St, Walton on Thames KT12 1AA, UK',
    town: 'Walton on Thames', postcode: 'KT12 1AA', types: ['hair_salon'] }));
  ok(v.decision === 'accept', 'Walton-On-Thames == "Walton on Thames"', JSON.stringify(v));
}
{
  const prospect = { company_name: 'THERAPY HAIR LTD', city: 'Plymouth', location: 'Plymouth, Devon' };
  const v = verifyCandidate(prospect, place({
    name: 'Therapy Hair', address: '3 Mutley Plain, Plymouth PL4 6JQ, UK',
    town: 'Plymouth', postcode: 'PL4 6JQ', types: ['hair_salon'] }));
  ok(v.decision === 'accept', '"Plymouth, Devon" prospect matches Plymouth locality', JSON.stringify(v));
}

console.log('\n── Names that must NOT auto-accept ──');
{
  // Only generic words survive normalisation: nothing identifying to match on.
  const prospect = { company_name: 'THE HAIR SALON LTD', city: 'Leeds' };
  const v = verifyCandidate(prospect, place({
    name: 'The Hair Salon', address: '1 Briggate, Leeds LS1 6AA, UK',
    town: 'Leeds', postcode: 'LS1 6AA', types: ['hair_salon'] }));
  ok(v.decision === 'reject' && v.gate === 'name',
    'generic-only name is never auto-accepted, even on a perfect string match', JSON.stringify(v));
}
{
  // Shares one distinctive word but is a different business.
  const prospect = { company_name: 'SOPHIE MARIE AESTHETICS LTD', city: 'Sale' };
  const v = verifyCandidate(prospect, place({
    name: 'Sophie Nails', address: '2 School Rd, Sale M33 7XA, UK',
    town: 'Sale', postcode: 'M33 7XA', types: ['nail_salon'] }));
  ok(v.decision === 'reject' && v.gate === 'name',
    'partial distinctive-token overlap rejected ("shares a word" is not a match)', JSON.stringify(v));
}

console.log('\n── Neutral types -> unverified, never a silent accept ──');
{
  const prospect = { company_name: 'DERMA FACES LTD', city: 'Northampton' };
  const v = verifyCandidate(prospect, place({
    name: 'Derma Faces', address: '5 Gold St, Northampton NN1 1RA, UK',
    town: 'Northampton', postcode: 'NN1 1RA', types: ['establishment', 'point_of_interest'] }));
  ok(v.decision === 'unverified' && v.gate === 'type-neutral',
    'generic-only Places types -> unverified rather than accepted', JSON.stringify(v));
}

console.log('\n── Verified match with NO rating (the brief asks this be counted) ──');
{
  const prospect = { company_name: 'JARIYA THAI MASSAGE & SPA LTD', city: 'Bagshot' };
  const noRating = place({ name: 'Jariya Thai Massage & Spa', address: '11 High St, Bagshot GU19 5AH, UK',
    town: 'Bagshot', postcode: 'GU19 5AH', types: ['spa', 'massage'] });
  const v = verifyCandidate(prospect, noRating);
  ok(v.decision === 'accept', 'accepted match with no reviews at all', JSON.stringify(v));
  ok(noRating.rating === undefined && noRating.userRatingCount === undefined,
    'rating/count absent -> must be recorded as null, not 0');
}

console.log('\n── pickMatch picks the best accepted candidate and logs the rest ──');
{
  const prospect = { company_name: 'ALYS&CO HOUSE OF HAIR AND BEAUTY LTD', city: 'Haverfordwest' };
  const wrong = place({ id: 'w', name: 'Greggs', address: '2 High St, Haverfordwest SA61 2BW, UK',
    town: 'Haverfordwest', postcode: 'SA61 2BW', types: ['bakery'] });
  const right = place({ id: 'r', name: 'Alys & Co House of Hair and Beauty',
    address: '7 Bridge St, Haverfordwest SA61 2AA, UK', town: 'Haverfordwest',
    postcode: 'SA61 2AA', types: ['hair_salon'], rating: 4.7, count: 31 });
  const m = pickMatch(prospect, [wrong, right]);
  ok(m.decision === 'accept' && m.place.id === 'r', 'best accepted candidate chosen', JSON.stringify(m.decision));
  ok(m.candidates.length === 2 && m.candidates.some((c) => c.outcome === 'reject'),
    'rejected candidate still logged with its reason');
}

console.log(`\n═══ ${pass} passed, ${fail} failed ═══`);
process.exit(fail ? 1 : 0);
