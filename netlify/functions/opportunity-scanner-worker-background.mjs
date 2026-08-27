// Netlify Background Function: opportunity-scanner-worker-background
//
// Ported from supabase/functions/opportunity-scanner-worker/index.ts (Deno).
// Moved here because that Supabase edge function kept timing out at 150s —
// the Anthropic call with web_search routinely runs longer than Supabase's
// execution budget allows, even after the odd/even-day section split cut
// the prompt size. Netlify background functions (the `-background` suffix
// in the filename is what tells Netlify to treat this one specially) get a
// 15-minute budget: Netlify returns 202 to the caller immediately and runs
// this handler in the background, unconstrained by any HTTP response
// window — the same "caller doesn't wait" shape the Supabase
// trigger/worker split was already built around, just with much more room.
//
// Invoked by the Supabase `opportunity-scanner` trigger function (still a
// Supabase edge function, still fired by pg_cron on its existing schedule —
// see supabase/functions/opportunity-scanner/index.ts in yca-platform) via
// a plain HTTPS POST to this function's URL. That trigger is fire-and-
// forget, exactly as it was when it called the Supabase worker directly —
// nothing about that part of the architecture changed, only where the real
// work runs.
//
// Auth: this is a public URL (unlike the old Supabase worker, which was
// gated by Supabase's own service-role bearer check) — anyone who finds it
// could otherwise trigger real, paid Anthropic API calls repeatedly. Reuses
// this repo's one existing precedent for exactly this exposure
// (netlify/functions/refresh-status.js's INTERNAL_SECRET check) rather than
// inventing a new pattern — same shared secret, checked via Bearer header
// here (this function is only ever called server-to-server, not from a
// browser, so no query-string/header fallback is needed the way
// refresh-status.js supports for convenience).
//
// Required Netlify site env vars (Site settings -> Environment):
//   ANTHROPIC_API_KEY, RESEND_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_KEY,
//   INTERNAL_SECRET (shared with refresh-status.js; the yca-platform
//   trigger must send this same value)
// Optional:
//   OPPORTUNITY_EMAIL_FROM, OPPORTUNITY_EMAIL_TO (fall back to the
//   defaults below, same as the Deno version)
import { createClient } from '@supabase/supabase-js'

const MODEL = 'claude-sonnet-4-6'
const FALLBACK_FROM = 'YCA Opportunity Scanner <hello@yourcompanyai.co.uk>'
const FALLBACK_TO = 'adrianfielding@me.com'

const RESEARCH_SYSTEM = `You are an opportunity analyst for a UK-based operator (Adrian). Your job is to find online businesses he can spin up, hand to a marketing team (Quill) to promote, and then run with minimal ongoing input.

You are looking for:
- Online businesses or product categories with PROVEN demand and consistent revenue.
- Businesses that can be built or improved with AI and require minimal ongoing input once built.
- Models that work as one of: digital downloads, print on demand, subscription, dropshipping, white label, or SaaS.
- Business models already proven in the US, Australia, or Canada that have NOT yet reached mainstream UK adoption — demand is validated but UK competition is still low. These are often the strongest opportunities.
- Light-touch to operate once built: marketing is handled separately, fulfilment is automated or outsourced.

You are NOT looking for:
- Businesses to market an agency (YCA) to.
- UK SMEs to target as agency clients.
Only businesses Adrian can build, market via Quill, and run hands-off.

THE BUILDABILITY BAR — APPLY THIS FIRST, BEFORE ANY OTHER ANALYSIS

Every single item you output, in every section, must first pass all three of these tests. This is a hard gate, not a preference. An item that is interesting, profitable, or well-researched but fails any one of these tests must be DROPPED, not included with a caveat. Surfacing fewer items — or none — is always the correct outcome when nothing clears this bar. Do not include anything for interest's sake.

TEST 1 — Could Redmaine actually build this?
It must be realistically buildable as a small SaaS product, web app, or digital product by a very small technical team. Drop it if it requires any of:
- Significant physical infrastructure (warehousing, manufacturing, fleet, premises, physical stock at scale)
- Regulated licensing or accreditation to operate (financial services licences, medical device approval, care/childcare registration, insurance underwriting, legal practice)
- Meaningful headcount to deliver the core product (staffed support desks, human-delivered consulting, field engineers, clinicians, installers)
- Proprietary IP, clinical validation, or long R&D before a first version can ship

TEST 2 — Could Quill run 100% of the marketing?
Once built, the entire go-to-market must be servable by content, organic social, SEO and email alone. Drop it if it needs:
- A dedicated sales team, outbound SDRs, account managers, or human demos to close
- Expensive paid acquisition to work at all, or a category where CAC is dominated by ad auctions
- Enterprise procurement cycles, tenders, RFPs, or named-account relationship selling
- Trade shows, field marketing, physical presence, or partner/reseller channels to reach buyers

TEST 3 — Is there a specific, concrete "1% better" angle?
There must be a named, articulable way this is better, cheaper, or faster than a specific named incumbent. "This market exists and makes money" is NOT an angle and is an automatic drop. The angle must be specific enough to state in one sentence, referencing what the incumbent actually does badly today — a concrete gap in their product, price, speed, or UX that you found evidence for during search.

For every item you output, include a "buildability" object recording how it cleared this bar:
"buildability": {"redmaine_can_build":"...why it's buildable without infrastructure/licensing/headcount...","quill_can_market":"...why content/social/email alone reaches these buyers...","one_percent_better":"...the specific angle over the specific named incumbent..."}

If you cannot write a genuine, specific sentence for all three, the item has not passed. Drop it.

Before scoring ANY opportunity, you must research its competitive landscape using web search. For each opportunity, identify:
- The top 3 named competitors already operating in this space (real, named businesses — not vague categories).
- An estimate of each competitor's revenue or scale: Small (under ~£1M), Medium (£1M–£10M), or Large (£10M+).
- Whether any of the 3 have VC, PE, or corporate backing.
- Whether the product/service itself is white-label or commodity — i.e. no formula, recipe, or IP exclusivity, so anyone could source and sell the same thing.
This competitor research must be completed and must appear in your output BEFORE you assign a score.

Once competitor research is complete, score the opportunity 0–10 on each of these 8 criteria:
1. Can it be run remotely from a laptop.
2. Has recurring revenue or repeat purchase potential.
3. Is automatable.
4. UK market with no geographic barrier.
5. Proven demand — people already paying for it.
6. Fragmented market — no competitor exceeds £10M revenue AND no VC/PE-backed player exists. If any named competitor exceeds £10M revenue or has institutional backing, this criterion scores maximum 4/10 regardless of other factors.
7. Good margin potential.
8. Barrier to differentiation — can this business be meaningfully differentiated from day one without significant R&D, clinical validation, or proprietary IP? White-label products with no formula exclusivity, commodity services, or markets where incumbents already offer AI personalisation score maximum 4/10 on this criterion.

Sum the 8 criteria scores into a total out of 80. A criterion counts as met "strongly" if it scores 7 or above. Only treat an opportunity as a pass if: the total is 45 or higher, AND at least 5 of the 8 criteria are met strongly, AND your competitor research shows no named incumbent above £10M revenue. Do not include an opportunity that fails this threshold just to fill a quota — it is fine to surface fewer than 3 opportunities, or zero, on a day when nothing clears the bar.

Use the web_search tool to research LIVE data before answering. Run searches across these angles:
1. Trending Etsy and Amazon bestseller categories with high volume and few dominant brands.
2. Rising Google Trends UK niches.
3. Business models succeeding in the US / Australia / Canada that are not yet mainstream in the UK.
4. Reddit r/Entrepreneur, r/passive_income and r/SideProject for businesses people are actually running successfully.

Then analyse everything against the competitor-research-and-scoring process above and surface only opportunities that pass the threshold — up to 5, ranked strongest first, and it is fine to surface fewer than 3 or none.

After your opportunity analysis, add a separate section titled "BUSINESSES TO REPLICATE".

Rebuilt 26 Aug 2026 to work in evidence-first order: find real, already-trading UK businesses with hard proof of traction FIRST, then evaluate each one — never start from a business idea and go looking for someone doing it. That backwards order is what produced this section's past failures: plausible-sounding ideas dressed up with a thin competitor check, not real businesses Adrian could act on.

THE EVIDENCE BAR — every candidate must clear ONE of these before you spend any more time on it:
- Companies House filed accounts showing turnover or profit (small company disclosure).
- Sustained review volume: 200+ genuine reviews spanning at least 2 years on Trustpilot, Google, or an industry-specific platform.
- Active hiring: real job postings live right now.
- Documented growth: LinkedIn headcount growth, press coverage, or an industry award/nomination.
A business with no verifiable signal is discarded, not included with a caveat.

ADRIAN'S THREE QUESTIONS — every surviving candidate must answer all three with a concrete, evidenced field, not prose colour:
- REPLICATE: the exact mechanism — the specific customer and the actual differentiator, not a category description.
- IMPROVE: a specific, evidenced gap — a real review complaint, a missing feature, a price gap, or a named UX problem. "We could do it better" is not an answer. Before finalising it, check whether your own cited evidence names a competitor that already offers the thing you're proposing — if it does, the gap is disproved, not supported. Drop or rewrite rather than ship it.
- LOW CAPITAL: the business model must be SaaS, service, marketplace, or content/subscription — never anything requiring inventory, manufacturing, or meaningful working capital before first revenue. State why THIS business's actual model qualifies, don't just assert it.

HARD REQUIREMENTS
- A named, real, currently-trading UK business with a working URL you found via search. Never a category, never a hypothetical.
- The evidence signal above must be a real figure, count, or fact you actually found via search, with its source — not an assertion that it's "popular" or "growing".
- ONE IDEA, ONE ENTRY. If two candidates are the same underlying business model aimed at different incumbents, keep the strongest and drop the other.

DO THE WORK BEFORE YOU JUDGE
This bar is a filter applied to real research, not a reason to skip the research. Search broadly for real candidates, check each one against the evidence bar, and only then evaluate the survivors against the three questions above. Concluding "nothing qualifies" without having searched is not a strict answer, it is an empty one. Expect to examine several candidates and discard most of them.

One rigorously evidenced entry beats three thin ones, and an honest empty section beats a padded list. But an empty section arrived at without searching is a failure, not a high standard.`

// Section A — scored opportunities + businesses to replicate. Runs on odd
// UTC days of the month. Everything below is Section A's own instructions
// only — the prospects/legislation instructions live in RESEARCH_USER_B.
//
// Now a builder rather than a flat string (26 Aug 2026 replicate rebuild) —
// the replicate section needs its own live exclusion list, injected the same
// way buildResearchUserB already does for legislation, backed by the same
// opportunity_scanner_seen_items table rather than the hand-maintained name
// list further down. That list still exists and still applies (it also
// covers Adrian's existing portfolio spaces, which are a permanent
// exclusion, not a "recently sent" one) — this is an addition, not a
// replacement.
function buildResearchUserA(recentReplicateNames = []) {
  const replicateExclusions = recentReplicateNames.length
    ? `
ALREADY SURFACED — DO NOT RETURN THESE AGAIN
The following businesses have already been sent as a "Businesses to Replicate" finding recently. Do not return any of them again, under any name variant:
${recentReplicateNames.map((n) => `- ${n}`).join('\n')}
`
    : ''

  return `Your job today is to find SPECIFIC NAMED BUSINESSES making money right now — not categories, not trends, not archetypes. Every opportunity and every business to replicate must be a real named company or seller with a real URL that you have searched for and verified exists.

EXCLUSION LIST — DO NOT RECOMMEND THESE
The following businesses have already been featured in recent emails. Do not recommend them, reference them as opportunities, or include them in the Businesses to Replicate section under any circumstances:
Crown & Paw, Paw & Glory, Wonderbly, Book by Anyone, Notion Everything, BookBolt, Legally Contented, Ivory Mix, Publisher Rocket, Zety, Vitl, Senja.io, Tiller Money, DIRTEA, PropertyWriter, SVGCuts, Mealime, PlannerKate1, Digital Planner Co, Passion Planner, Gridfiti, Easlo, Thomas Frank Productivity, Boss Project, Nishad Mubarak.

The following business categories are already covered by Adrian's existing portfolio — do not recommend anything in these spaces:
- Personalised children's books (OUAY already exists)
- Pet portrait print-on-demand (Framous already exists)
- Hormone/menopause supplements (Hormonely already exists)
- ADHD/neurodiversity assessment (Neuro Decoded already exists)
- GLP-1/weight loss companion app (Steady already exists)
- UK trade business SaaS (YCA already exists)
- AI marketing automation (Quill already exists)

If a business operates in any of these spaces, skip it entirely.

PRIORITY: UK BUSINESSES FIRST
Prioritise finding UK-registered businesses with verifiable UK revenue. Search specifically for:
- UK founders sharing revenue on Reddit, IndieHackers, Twitter/X
- UK Etsy shops with 5,000+ reviews in a niche
- UK SaaS tools with real paying customers
- UK Shopify stores with strong organic presence
- US/AU/CA businesses succeeding in a space with no UK equivalent yet

US and Australian businesses are acceptable for the scored-opportunities section above only, per the "not yet mainstream in the UK" model in your instructions. The Businesses to Replicate section below is UK-only — see its own instructions.

PHASE 1 — NAMED BUSINESS DISCOVERY (do this before anything else)

Run web searches to find real, specific, named businesses. Search for things like:
- "UK founder revenue" OR "I make £" site:reddit.com OR site:indiehackers.com 2025 2026
- "site:etsy.com [niche] UK" to find actual shops with high review counts
- "[niche] UK Shopify store making money 2025 2026"
- "[business model] succeeding Australia not UK yet"
- "[competitor name] UK alternative"
- "UK SaaS bootstrap profitable [vertical] 2025 2026"

You must find at least 8-10 specific named businesses or sellers before scoring anything. Each must have a real name, a real URL found via search, and evidence they are making money.

Do NOT proceed to scoring until you have this list.

PHASE 2 — COMPETITOR RESEARCH AND SCORING

For each opportunity, identify the top 3 named competitors already operating (real names and URLs). Then score against all 8 criteria as per your instructions.

PHASE 3 — OUTPUT

For each opportunity provide IN THIS ORDER:
- buildability: {"redmaine_can_build":"...","quill_can_market":"...","one_percent_better":"..."} — the three-test gate from your instructions. Only include opportunities that genuinely pass all three.
- competitor_research: {"competitors": [{"name":"...","scale":"Small|Medium|Large","estimated_revenue":"...","backed":"VC|PE|Corporate|None"}], "white_label_or_commodity": true|false, "white_label_notes":"..."}
- criteria_scores: {"laptop_remote":0,"recurring_revenue":0,"automatable":0,"uk_no_geo_barrier":0,"proven_demand":0,"fragmented_market":0,"margin_potential":0,"differentiation_barrier":0}
- total_score: sum out of 80
- criteria_met_strongly: count scoring 7+
- passes_threshold: true only if total_score >= 45 AND criteria_met_strongly >= 5 AND no named competitor exceeds £10M revenue
- name: the actual business name or specific niche with a real example (never a generic category)
- what_it_is: what this business does, referencing real examples found (1-2 sentences)
- proof_of_demand: MUST cite specific named businesses, review counts, revenues, or community posts — no generic market size statements
- margin_and_fulfilment: estimated margin and fulfilment route
- ai_angle: specifically how AI improves or automates it
- uk_readiness: whether UK-ready or needs adaptation
- verdict: exactly one of "Strong", "Worth investigating", or "Pass"

Output ONLY a JSON array wrapped in a \`\`\`json fenced block. Only include opportunities where passes_threshold is true AND all three buildability tests pass. Zero is fine if nothing qualifies — and after applying the buildability bar, zero or one will often be the honest answer. Do not pad the list.

---

BUSINESSES TO REPLICATE

Rebuilt 26 Aug 2026. The old version of this section worked backwards — generate a business idea, then search for competitors to see if it survives. That produced thin, unverifiable findings: an idea dressed up with a plausible-sounding competitor check, not a real business Adrian could act on. This section now works in the opposite direction: find real, already-proven UK businesses FIRST, using hard evidence of traction, THEN evaluate each one. If you catch yourself starting from a product idea and searching for someone doing it, stop — that is the old, broken direction.
${replicateExclusions}
PHASE 1 — FIND REAL BUSINESSES WITH PROVEN TRACTION
Search broadly for real, named, currently-trading UK businesses — SaaS, service, marketplace, content/subscription. Every candidate must clear ONE of these four evidence bars before you spend any more time on it. If you cannot find one of these signals for a candidate, drop it immediately and move to the next one — do not include it with a caveat like "seems to be doing well" or "appears popular":
- Companies House filed accounts showing turnover or profit (small company disclosure) — search "[business name] Companies House accounts", read the actual filed figures.
- Sustained review volume: 200+ genuine reviews spanning at least 2 years on Trustpilot, Google, or an industry-specific review platform — search "[business name] Trustpilot reviews" / "[business name] Google reviews".
- Active hiring: real job postings live right now, indicating real revenue being spent on headcount — search "[business name] jobs" / "[business name] careers hiring".
- Documented growth: LinkedIn headcount growth, press coverage, or an industry award/nomination — search "[business name] LinkedIn" / "[business name] press" / "[business name] award".

You must find at least 6-8 real candidate businesses this way, each with one of the four signals above actually found via search, before evaluating any of them in Phase 2.

PHASE 2 — EVALUATE EACH CANDIDATE AGAINST ADRIAN'S THREE QUESTIONS
For every candidate that cleared Phase 1, answer all three of these with a concrete evidenced field — not prose colour. A generic or vague answer to any one of them is an automatic drop for that candidate, not a reason to soften the wording:

REPLICATE — the exact mechanism. Who is the actual customer (the specific buyer, not "small businesses" or "consumers")? What specifically do they do — the real differentiator, not a category description. "Meal planning software" is a category. "Auto-generates a week of trainer-branded meal plans from a client's macros and syncs the shopping list to Tesco/Sainsbury's" is a mechanism.

IMPROVE — a specific, evidenced gap. Search the business's own reviews for a real, recurring complaint. Search their pricing page for a stateable price gap against what a comparable tool costs. Search their feature list or help docs for something a real competitor has that they don't. "We could do it better" is not an answer — the gap must be something a person could point to and start building against today.
    SELF-REFUTATION CHECK — before finalising improve, re-read your own evidence_source. If it names ANY competitor — including one you found purely to source the evidence, not as the main candidate — check whether that competitor already offers the exact thing you are proposing as the gap. If it does, the gap does not survive: either drop the candidate entirely, or find a different, still-genuinely-open gap for it. Do not ship an improve angle whose own cited source describes someone already doing it. Worked example of the failure this check exists to stop: a finding proposed "add Sage accounting-software support" as competitor X's fixable gap, and cited a comparison article as evidence — but that same article named competitor Y as already offering Sage support at a similar price. The finding still shipped the Sage gap as if open. That is exactly backwards: the cited evidence didn't support the gap, it disproved it.

LOW CAPITAL — the business model must be one of: SaaS, service, marketplace, or content/subscription. Explicitly EXCLUDE anything requiring inventory, manufacturing, warehousing, or meaningful working capital before first revenue — this rules out most print-on-demand, dropshipping needing stock financing, and any physical-product business. State WHY this specific business's actual model qualifies as low-capital to replicate — the real mechanism (e.g. "hosted SaaS, no physical component, a first customer can be onboarded with zero inventory"), not an assertion that it's software so it must be low-capital.

Only output a candidate that clears Phase 1's evidence bar AND gets a genuine, specific answer to all three questions above. If you cannot write a real, specific answer to any one of them, drop the candidate — do not include it with a caveat.

For each surviving entry, return:
- name: actual business name
- url: real URL verified via search today
- idea_key: short kebab-case slug for the underlying business MODEL, not the company — e.g. "trainer-meal-plan-saas", "b2b-invoice-chasing-saas". Two entries may never share one — if two candidates are the same underlying model aimed at different incumbents, keep the strongest and drop the other.
- traction_evidence: {"type":"companies_house"|"reviews"|"hiring"|"growth_signal","detail":"the actual figure, count, or fact found — a real number or real quote, never a description","source_url":"the specific page you found it on"}
- replicate: {"customer":"the specific real buyer","mechanism":"the actual differentiator — what they specifically do, not a category"}
- improve: {"gap_type":"review_complaint"|"missing_feature"|"price_gap"|"ux_problem","detail":"the specific gap, named","evidence_source":"the specific review, page, or listing where you found it"}
- low_capital: {"model":"saas"|"service"|"marketplace"|"content_subscription","why":"the real mechanism that makes THIS business low-capital to replicate, not an assertion"}
- search_trail: {"discovery_queries":["the real searches that found this business in Phase 1"],"verification_queries":["the real searches that confirmed the evidence and the gap in Phase 2"]}
- effort: "Low", "Medium", or "High"
- verdict: "CLONE IT", "WORTH STUDYING", or "LEAVE IT"

Output as a second JSON array in a \`\`\`replicate fenced block. Maximum 3 entries — a ceiling, not a target. Aim to surface the one or two strongest that genuinely clear the bar. Zero is a correct and expected answer on a day when nothing does — an honest empty section beats a padded one.

---

REPEAT PREVENTION
Before finalising output, check every business name against the exclusion lists above — the hand-maintained one and the "already surfaced" one. If any match — exactly or approximately — remove and replace. Never output the same named business twice across consecutive emails.`
}

// Section B — YCA prospects (Companies House intelligence) + UK legislation
// watch. Runs on even UTC days of the month. Its own intro, not reused from
// Section A — Section A's intro specifically talks about "opportunities"
// and "businesses to replicate", neither of which apply here.
//
// Repeat prevention (fixed 15 Aug 2026): prospects were already deduped in
// code (insertProspects' outreach_prospects lookup), but legislation had
// none at all — items were never recorded after being emailed and never
// checked before inclusion, so the same handful of major changes resurfaced
// every run. Now a function rather than a const so the genuinely-sent
// legislation titles from opportunity_scanner_seen_items can be injected as
// a live exclusion list. That injection is the belt half of belt-and-braces:
// it stops the model wasting searches re-researching known items, but the
// authoritative filter is filterUnseenLegislation in code after parsing,
// which does not trust the model to have honoured this list.
function buildResearchUserB(recentLegislationTitles = []) {
  const legislationExclusions = recentLegislationTitles.length
    ? `
ALREADY REPORTED — DO NOT RETURN THESE AGAIN
The following legislation and regulatory items have already been sent in recent emails. Do not return them again, in any rewording, abbreviation, or partial form. If your search surfaces one of these, skip it and keep looking for something genuinely new:
${recentLegislationTitles.map((t) => `- ${t}`).join('\n')}

If, after excluding all of the above, you find no genuinely new legislation, return an empty legislation array. An empty array is the correct and expected answer on most days — major UK legislation does not change daily. Do not pad the list by re-reporting a known item under a different name, and do not substitute minor or speculative items to avoid returning nothing.
`
    : ''

  return `Your job today is to find SPECIFIC NAMED UK TRADE BUSINESSES with no proper business management software in place, and REAL UK LEGISLATION OR REGULATORY CHANGES that create new business opportunities — not categories, not vague trends. Every prospect and every legislative item must be real, found via search today, with a verifiable source.

UK COMPANIES HOUSE INTELLIGENCE

Search for UK businesses that have recently incorporated or filed accounts in construction, trades, or related sectors. Use these searches:
- "site:find-and-update.company-information.service.gov.uk [trade type] limited 2025 2026"
- "Companies House new incorporation [trade] UK 2025 2026"
- "UK [trade] business started 2024 2025 recently launched"

Find 3-5 recently started UK trade businesses (plumbers, electricians, builders, joiners, painters, roofers, HVAC, flooring, scaffolding, groundwork) that:
- Appear to have no proper business management software
- Are small (under 10 employees based on any available signal)
- Have a website or social media presence suggesting they are actively trading
- Are based in the UK

For each include:
- name: business name
- website: their URL if found
- trade: what type of trade they are
- incorporated: approximate date started if found
- signal: what evidence suggests they have no software (no online booking, basic Facebook page only, no invoicing system visible, etc.)
- why_yca: one sentence on why YCA would help them specifically

Output as a JSON array in a \`\`\`prospects fenced block:
[{"name":"...","website":"...","trade":"...","incorporated":"...","signal":"...","why_yca":"..."}]

Return 3-5 objects. Only include businesses you have actually found via search — do not invent any.

---

UK LEGISLATION AND REGULATORY INTELLIGENCE

Search for UK legislation changes, regulatory announcements, and government consultations that create new business opportunities. Search specifically for:
- "UK legislation 2026 small business impact"
- "HMRC announcement 2026 new requirement"
- "GOV.UK consultation closing 2026"
- "UK regulatory change 2026 compliance requirement"
- "Making Tax Digital update 2026"
- "Companies House reform 2026"
- "UK employment law change 2026"
- "Health and safety regulation UK 2026"
${legislationExclusions}
Split what you find into TWO distinct outputs, by whether it creates something Redmaine could actually build:

OUTPUT 1 — REGULATORY-DRIVEN OPPORTUNITIES (\`\`\`json block)
Where a legislation change creates a specific, buildable product opportunity, treat it as a scored opportunity, not a news item. It must pass all three buildability tests from your instructions and the full 8-criteria scoring process, exactly as a normal opportunity would — a compliance deadline alone is not an opportunity, and "businesses will need help with this" is not a product. There must be a specific tool someone would pay for.

Score and output these using the SAME schema as a normal scored opportunity (buildability, competitor_research, criteria_scores, total_score, criteria_met_strongly, passes_threshold, name, what_it_is, proof_of_demand, margin_and_fulfilment, ai_angle, uk_readiness, verdict), plus one extra field:
- regulatory_driver: the specific legislation or regulation driving it, and its in-force date

Output as a JSON array in a \`\`\`json fenced block. Only include items where passes_threshold is true AND all three buildability tests pass. Most legislation does not clear this bar — an empty array here is normal and correct.

OUTPUT 2 — LEGISLATION WATCH (\`\`\`legislation block)
Genuinely new regulatory changes worth knowing about that did NOT become an opportunity above — the informational watch list. Do not duplicate anything you already returned in the \`\`\`json block.

For each, identify what it requires, when it comes into force, who it affects, what gap it creates, and which brand it is relevant to.

Output as a second JSON array in a \`\`\`legislation fenced block:
[{"title":"...","summary":"...","in_force":"...","affects":"...","opportunity":"...","relevant_brand":"YCA|Quill|PS|All"}]

Return up to 5 items. Only include genuine confirmed legislation or consultations found via search — never invent regulatory changes. If nothing genuinely new is found today, return an empty array; this is expected on most days and is always better than repeating something already reported.`
}

// ── Anthropic (with server-side web_search tool) ────────────────────────────
// max_tokens/max_uses history from the Deno version this was ported from:
// raised 8000 -> 12000 -> 14000 / 8 -> 12 -> 16 as sections were added to a
// single combined prompt, then split into these two alternating sections at
// 8000/8 each when the combined prompt started reliably timing out at 150s
// even after earlier cuts. That 150s ceiling was Supabase Edge Functions'
// own execution budget — this Netlify background function has 15 minutes
// instead, so the split/budget itself is kept here for the actual research
// quality it was tuned for, not because 8000/8 is still a hard ceiling.
//
// Incident fix (6-7 Aug 2026, two consecutive days) — RESEARCH_TIMEOUT_MS
// was left at 120_000 (2 minutes) when this function moved from Supabase
// (150s hard ceiling) to Netlify (900s). That 120s figure was ALREADY
// tighter than the old 150s Supabase ceiling it was ported from — a
// defensive margin that made sense when 150s was all there was, but never
// got raised to match the platform this function actually runs on now.
// Confirmed via opportunity_scanner_runs: both failing days logged the
// exact same error, "Research call did not complete within 120s and was
// aborted", while 5 Aug (two days earlier) completed successfully — the
// underlying Anthropic call (8 web searches, multi-phase competitor
// research) is inherently variable in duration and routinely exceeds 120s,
// while 900s of real budget sat unused every time it did. Raised to 720s
// (12 minutes) — generous enough that a slow research day should complete
// normally, while leaving ~3 minutes of margin under Netlify's own 900s
// kill for the rest of the handler (parsing, prospect dedup/insert, email
// send, run logging) plus Netlify's own dispatch overhead. If Netlify's
// hard kill ever fires instead of this abort, none of this function's own
// error handling runs at all — this timeout must always stay safely below
// it, not exactly at it.
export const RESEARCH_TIMEOUT_MS = 720_000

// Carries how long the call actually ran and whatever text had streamed in
// before the abort — see fetchResearchText. Lets the caller attempt a
// best-effort partial-results recovery instead of just reporting "it timed
// out" with nothing to show for it.
export class ResearchTimeoutError extends Error {
  constructor(elapsedMs, partialText = '') {
    super(`Research call did not complete within ${RESEARCH_TIMEOUT_MS / 1000}s (aborted after ${Math.round(elapsedMs / 1000)}s) and was aborted`)
    this.name = 'ResearchTimeoutError'
    this.elapsedMs = elapsedMs
    this.partialText = partialText
  }
}

// Odd day-of-month -> Section A, even -> Section B. UTC to match dateStr
// elsewhere in this file, not the server's local time.
function sectionForDate(now) {
  return now.getUTCDate() % 2 === 1 ? 'A' : 'B'
}

// userPrompt is a builder rather than a string: Section B's prompt embeds
// the live already-sent legislation exclusion list (see buildResearchUserB),
// so it can only be assembled once that list has been read from the database.
// Section A's builder (26 Aug 2026 replicate rebuild) now does the same for
// the replicate section's live already-surfaced-business exclusion list (see
// buildResearchUserA) — it still also carries the hand-maintained hardcoded
// exclusion list further down for the permanent portfolio-space exclusions.
//
// Section B raised from 8000/8 to 12000/10: it now has to score
// regulatory-driven opportunities through the full 8-criteria process on top
// of prospects and the watch list, which the old budget has no room for.
// Truncating mid-response would leave an unclosed fenced block and silently
// lose a whole section to a parse failure. Still far inside
// RESEARCH_TIMEOUT_MS (720s) — Section A already does comparable scoring work
// within budget.
// Exported so a real Section A run can be reproduced outside the handler —
// same system prompt, same user prompt, same token and search budgets — to
// check what the model actually returns without sending an email or writing
// to the database.
export const SECTION_CONFIG = {
  // maxUses raised 8 -> 16 for Section A alongside the two-category rewrite.
  // Those 8 searches were always shared between the scored-opportunity
  // analysis AND the replicate section; the rewrite added a mandatory
  // per-entry competitor check on top, so the evidence burden went up while
  // the search budget stayed put. First two live runs under the new rules
  // returned an empty replicate array in 51s and 74s — consistent with a
  // model that cannot afford the checks it is now required to run, and so
  // declines rather than half-doing them.
  // maxTokens raised 8000 -> 12000, matching Section B. The 50.9s run on
  // 17 Aug returned NO ```replicate block at all — the signature of an answer
  // truncated before it got that far, since the replicate array is emitted
  // last. Section A now carries a full opportunity analysis (buildability,
  // competitor research, 8 criteria scores per opportunity) AND a replicate
  // section with a mandatory competitor check per entry, on the same 8000 it
  // had before any of that existed. stop_reason is now logged, so if this is
  // still being hit it will say so instead of silently losing a section.
  // maxUses 20 -> 30 (26 Aug 2026 replicate rebuild). The old three-angle
  // competitor check searched around 2 pre-chosen ideas; the new evidence-
  // first approach has to discover 6-8 real candidate businesses from
  // scratch, then run a traction-evidence search AND a gap/improve-evidence
  // search per surviving candidate — materially more search volume for the
  // same section. 30 is a starting budget, not a measured one; check
  // web_searches on the first real runs and raise again if it's regularly
  // hitting the cap before the model finishes evaluating its candidates.
  A: { buildUserPrompt: buildResearchUserA, maxTokens: 12000, maxUses: 30 },
  B: { buildUserPrompt: buildResearchUserB, maxTokens: 12000, maxUses: 10 },
}

// ── Repeat prevention ───────────────────────────────────────────────────────
// Backed by opportunity_scanner_seen_items (migration 100). See that
// migration's header for why this had to be built from scratch rather than
// extended: there was no exclusion table anywhere in this codebase.

const SEEN_SECTION_LEGISLATION = 'legislation'
// 26 Aug 2026 replicate rebuild — same table, same generic loadSeenItems/
// recordSeenItems/normaliseKey/titlesSimilar infra, just a new section value.
// opportunity_scanner_seen_items was explicitly built with a free-text
// `section` column anticipating exactly this (see migration 100's header).
const SEEN_SECTION_REPLICATE = 'replicate'
// How far back to consider an item "already reported" — for an item that has
// only ever been sent ONCE. Legislation has a long shelf life — Making Tax
// Digital was announced years before its in-force date — so a short window
// would let the same item cycle back round. A year is long enough that
// anything genuinely still newsworthy has had its turn.
//
// This window does NOT apply once an item has been sent HARD_CAP_SENDS
// times — see loadSeenItems. Originally this was the only rule, and it had
// a real bug: after SEEN_LOOKBACK_DAYS elapsed the item dropped out of the
// exclusion list and became eligible again, and if re-sent it would drop out
// again a year later — "permanently excluded" was never actually permanent.
// Confirmed against opportunity_scanner_seen_items directly: times_seen also
// never incremented before this fix (see recordSeenItems), so nothing had
// hit the old code's own attempted safeguard in practice.
const SEEN_LOOKBACK_DAYS = 365
// A legislation item may be sent at most this many times, full stop, no
// matter how much time passes. Once an item's times_seen reaches this, it is
// permanently excluded — loadSeenItems keeps such rows in the exclusion list
// forever, ignoring SEEN_LOOKBACK_DAYS entirely for them.
const HARD_CAP_SENDS = 2
// How many titles to inject into the prompt. The database filter is the
// authoritative one, so this only needs to cover enough recent history to
// stop the model wasting searches; injecting all of them would bloat the
// prompt for no extra protection.
const SEEN_PROMPT_LIMIT = 40

// Words that carry no distinguishing signal in a legislation title. Dropped
// before comparison so "The Employment Rights Act 2026" and "Employment
// Rights Act" collapse to the same key.
const TITLE_STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'for', 'to', 'in', 'on', 'at', 'by',
  'from', 'with', 'new', 'uk', 'update', 'updates', 'change', 'changes',
  'requirement', 'requirements', 'regulation', 'regulations', 'rule', 'rules',
  'act', 'bill', 'reform', 'reforms', 'consultation', 'scheme', 'law', 'laws',
])

// UK regulatory acronyms expanded before tokenising. Without this, an
// acronym and its expansion share literally zero tokens ("MTD" vs "Making
// Tax Digital"), so no amount of token-overlap maths can connect them — and
// the model swapping between the two forms across runs is one of the most
// likely ways the same item comes back looking new. Deliberately a short,
// explicit list of terms that actually recur in this domain rather than a
// general abbreviation guesser, which would create false matches.
const ACRONYM_EXPANSIONS = [
  [/\bmtd\b/g, 'making tax digital'],
  [/\bitsa\b/g, 'income tax self assessment'],
  [/\bera\b/g, 'employment rights'],
  [/\bcis\b/g, 'construction industry scheme'],
  [/\briddor\b/g, 'reporting injuries diseases dangerous occurrences'],
  [/\bcoshh\b/g, 'control substances hazardous health'],
  [/\bhmrc\b/g, 'hm revenue customs'],
  [/\bepc\b/g, 'energy performance certificate'],
  [/\bvat\b/g, 'value added tax'],
]

// Normalised dedup key: lowercase, expand known acronyms, strip everything
// non-alphanumeric, drop stopwords, sort the remaining tokens. Sorting means
// word-order rewrites ("Companies House identity verification" vs "identity
// verification at Companies House") produce the same key. This is the
// exact-match half of the filter — titlesSimilar below catches restatements.
export function normaliseKey(title) {
  let text = String(title ?? '').toLowerCase()
  for (const [pattern, expansion] of ACRONYM_EXPANSIONS) text = text.replace(pattern, expansion)
  const tokens = text
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t && !TITLE_STOPWORDS.has(t))
  return [...new Set(tokens)].sort().join(' ')
}

// Containment (overlap coefficient: shared / smaller set), NOT Jaccard.
//
// Jaccard was tried first and is wrong for this job: the real failure mode is
// the same legislation restated with extra qualifiers bolted on ("Making Tax
// Digital for Income Tax" vs "Making Tax Digital for Income Tax Self
// Assessment April 2026"). Every added qualifier grows the union and pushes
// the Jaccard score DOWN, so the more verbosely the model restates an item
// the less likely Jaccard is to catch it — exactly backwards. Containment
// asks the question that actually matters: is one title essentially wholly
// contained in the other?
//
// 0.8 requires near-total containment. Two different changes to the same act
// ("Building Safety Act" vs "Building Safety Act second staircase rule") do
// collapse together under this, which is intended — they are the same
// underlying item and the reader has already been told about it.
const SIMILARITY_THRESHOLD = 0.8
// Below this, a key is too short for containment to mean anything — a
// two-token title would match almost any superset. Those fall back to exact
// key matching only.
const MIN_TOKENS_FOR_SIMILARITY = 2

export function titlesSimilar(a, b) {
  const setA = new Set(normaliseKey(a).split(' ').filter(Boolean))
  const setB = new Set(normaliseKey(b).split(' ').filter(Boolean))
  if (setA.size < MIN_TOKENS_FOR_SIMILARITY || setB.size < MIN_TOKENS_FOR_SIMILARITY) return false
  let shared = 0
  for (const t of setA) if (setB.has(t)) shared++
  return shared / Math.min(setA.size, setB.size) >= SIMILARITY_THRESHOLD
}

// Best-effort by design: if this lookup fails, the run continues with an
// empty seen-list rather than dying. A repeat item is a far better outcome
// than a failed scan, and the failure is logged either way.
//
// Returns rows matching EITHER condition, not just the recency window:
//   - times_seen >= HARD_CAP_SENDS — permanently excluded, regardless of age.
//     This is the fix for the loophole above: without it, an item sent twice
//     more than SEEN_LOOKBACK_DAYS apart would still drop out and be eligible
//     for a third send.
//   - last_seen_at within the lookback window — the existing soft exclusion,
//     unchanged, for items that have only been sent once so far.
async function loadSeenItems(admin, section) {
  if (!admin) return []
  const since = new Date(Date.now() - SEEN_LOOKBACK_DAYS * 86400_000).toISOString()
  const { data, error } = await admin
    .from('opportunity_scanner_seen_items')
    .select('item_key, title, last_seen_at, times_seen')
    .eq('section', section)
    .or(`times_seen.gte.${HARD_CAP_SENDS},last_seen_at.gte.${since}`)
    .order('last_seen_at', { ascending: false })
  if (error) {
    console.error(`[opportunity-scanner-worker-background] seen-items lookup failed for "${section}": ${error.message}`)
    return []
  }
  return data ?? []
}

// The authoritative filter — applied to parsed output, so it holds regardless
// of whether the model honoured the exclusion list injected into its prompt.
// Also dedups within the batch itself, since nothing stops the model
// returning the same item twice in one response.
export function filterUnseenLegislation(items, seen) {
  // Keyed lookup, not just a Set of keys, so a match can report how many
  // times that item has actually been sent — loadSeenItems already decides
  // which rows are even in `seen` (recent-once, or hard-capped-forever); this
  // only needs to phrase the drop reason accordingly.
  const seenByKey = new Map(seen.map((s) => [s.item_key, s]))
  const kept = []
  const dropped = []

  const dropReasonFor = (matchedSeen, matchKind) => {
    const timesSeen = matchedSeen.times_seen ?? 1
    if (timesSeen >= HARD_CAP_SENDS) {
      return `${matchKind} of "${matchedSeen.title}", already sent ${timesSeen} time(s) — permanently excluded at the ${HARD_CAP_SENDS}-send cap`
    }
    return `${matchKind} of previously sent "${matchedSeen.title}"`
  }

  for (const item of items) {
    const title = String(item?.title ?? '').trim()
    if (!title) { dropped.push({ title: '(untitled)', reason: 'no title' }); continue }
    const key = normaliseKey(title)
    if (!key) { dropped.push({ title, reason: 'title normalised to empty' }); continue }

    const exact = seenByKey.get(key)
    if (exact) { dropped.push({ title, reason: dropReasonFor(exact, 'exact match') }); continue }
    const near = seen.find((s) => titlesSimilar(title, s.title))
    if (near) { dropped.push({ title, reason: dropReasonFor(near, 'near-duplicate') }); continue }
    if (kept.some((k) => normaliseKey(k.title) === key || titlesSimilar(title, k.title))) {
      dropped.push({ title, reason: 'duplicate within this same batch' }); continue
    }

    kept.push(item)
  }

  return { kept, dropped }
}

// Called ONLY after the email has actually been sent — see the handler. If
// this ran before the send and the send then failed, these items would be
// permanently suppressed having never once been seen by Adrian, which is the
// one genuinely unrecoverable failure mode in this design.
//
// Calls record_opportunity_scanner_seen_item (migration
// 20260821124845_legislation_permanent_send_cap.sql) — a single atomic
// upsert that increments times_seen server-side, rather than a plain
// supabase-js .upsert(). A plain upsert can't express "times_seen = times_seen
// + 1" in its payload (it can only set columns to fixed values), which is
// exactly why the previous version of this function silently never
// incremented times_seen despite an old comment here claiming it did —
// confirmed against production: every row in opportunity_scanner_seen_items
// sat at times_seen = 1 regardless of how many times that item had actually
// been through this function. The RPC also avoids a read-then-write race
// between concurrent invocations. Best-effort per row: one bad row never
// drops the rest.
async function recordSeenItems(admin, section, items) {
  if (!admin || !items.length) return { recorded: 0 }
  let recorded = 0

  for (const item of items) {
    const title = String(item?.title ?? '').trim()
    const itemKey = normaliseKey(title)
    if (!title || !itemKey) continue

    const { data: timesSeen, error } = await admin.rpc('record_opportunity_scanner_seen_item', {
      p_section: section,
      p_item_key: itemKey,
      p_title: title,
    })
    if (error) {
      console.error(`[opportunity-scanner-worker-background] seen-item record failed for "${title}": ${error.message}`)
      continue
    }
    recorded++
    if (timesSeen >= HARD_CAP_SENDS) {
      console.log(`[opportunity-scanner-worker-background] "${title}" has now been sent ${timesSeen} time(s) — will be permanently excluded from here on`)
    }
  }

  return { recorded }
}

// Persists the FULL replicate evidence trail for a run — one row per
// candidate the model actually examined, kept or dropped, with the real
// search queries and evidence found. See migration
// 103_opportunity_scanner_replicate_findings.sql for why this exists: the
// per-run JSON blob on opportunity_scanner_runs (replicate_dropped) is not
// queryable per-candidate, which is the exact evidence-gap pattern that
// already broke diagnosis twice on this scanner (legislation before
// opportunity_scanner_seen_items existed, this section before search_queries
// existed). Best-effort per row, same as recordSeenItems — one bad row must
// never drop the rest.
async function persistReplicateFindings(admin, runId, findings) {
  if (!admin || !findings?.length) return { persisted: 0 }
  let persisted = 0

  for (const f of findings) {
    const { error } = await admin.from('opportunity_scanner_replicate_findings').insert({
      run_id: runId,
      name: isStr(f?.name) ? f.name : '(unnamed)',
      url: isStr(f?.url) ? f.url : null,
      idea_key: isStr(f?.idea_key) ? f.idea_key : null,
      kept: !!f?.kept,
      drop_reasons: f?.drop_reasons?.length ? f.drop_reasons : null,
      evidence_type: f?.traction_evidence?.type ?? null,
      evidence_detail: f?.traction_evidence?.detail ?? null,
      evidence_source: f?.traction_evidence?.source_url ?? null,
      replicate: f?.replicate ?? null,
      improve: f?.improve ?? null,
      low_capital: f?.low_capital ?? null,
      discovery_queries: f?.search_trail?.discovery_queries ?? null,
      verification_queries: f?.search_trail?.verification_queries ?? null,
    })
    if (error) {
      console.error(`[opportunity-scanner-worker-background] replicate finding persist failed for "${f?.name}": ${error.message}`)
      continue
    }
    persisted++
  }

  return { persisted }
}

// Streams the response instead of waiting for one final JSON blob, purely
// so that IF the abort fires, whatever text the model had already produced
// is still in `accumulated` and can be handed to the caller (via
// ResearchTimeoutError.partialText) for a best-effort partial-results
// parse — see the handler's catch block. On a normal, unaborted run this
// returns exactly the same concatenated text the old non-streaming version
// did, just assembled incrementally instead of read from one response body.
export async function fetchResearchText(anthropicKey, userPrompt, maxTokens, maxUses, systemOverride = null) {
  const controller = new AbortController()
  const startedAt = Date.now()
  const timeoutId = setTimeout(() => controller.abort(), RESEARCH_TIMEOUT_MS)

  let accumulated = ''
  let webSearches = 0
  let stopReason = null
  const searchQueries = []
  let activeToolIndex = null
  let activeToolJson = ''
  // Written even on the timeout/abort path, so a partial run still reports how
  // much searching it had done before it ran out of time.
  const publish = () => {
    lastResearchTelemetry = {
      research_ms: Date.now() - startedAt,
      research_chars: accumulated.length,
      web_searches: webSearches,
      stop_reason: stopReason,
      search_queries: searchQueries.slice(),
    }
  }
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': anthropicKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: maxTokens,
        system: systemOverride || RESEARCH_SYSTEM,
        tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: maxUses }],
        messages: [{ role: 'user', content: userPrompt }],
        stream: true,
      }),
      signal: controller.signal,
    })

    if (!res.ok) {
      const errBody = await res.text()
      throw new Error(`Anthropic API ${res.status}: ${errBody.slice(0, 500)}`)
    }

    // Server-sent events — one JSON event per "data: " line.
    //
    // text_delta events build the answer. TWO other event types are no longer
    // discarded, because without them "the model searched hard and honestly
    // found nothing" and "the model declined without searching" produce an
    // identical empty section:
    //   server_tool_use  — one per web_search the model actually issues. This
    //                      is the direct evidence of effort. Zero or one
    //                      search behind an empty result is a bail; a dozen is
    //                      a real negative finding.
    //   message_delta    — carries stop_reason. 'max_tokens' means the answer
    //                      was TRUNCATED, which silently destroys whichever
    //                      fenced block had not been emitted yet — the exact
    //                      signature of the 50.9s run that produced no
    //                      ```replicate block at all.
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? '' // keep the last (possibly partial) line for the next chunk
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue
        let evt
        try { evt = JSON.parse(line.slice(6)) } catch { continue }
        if (evt.type === 'content_block_delta' && evt.delta?.type === 'text_delta') {
          accumulated += evt.delta.text
        } else if (evt.type === 'content_block_start' && evt.content_block?.type === 'server_tool_use') {
          webSearches += 1
          // Capture the query itself, not just the count. Until now this
          // branch incremented a counter and threw the query away, so the one
          // question that actually diagnoses a missed competitor — "what did
          // it actually search?" — had no answer anywhere: not in the run log,
          // not in the email, not in the database. Every investigation into a
          // miss had to reason backwards from the prompt about what the model
          // probably searched. The query arrives streamed as input_json_delta
          // (content_block_start carries an empty input), so it is accumulated
          // per-block below and parsed on content_block_stop.
          activeToolIndex = evt.index
          activeToolJson = ''
          const direct = evt.content_block?.input?.query
          if (typeof direct === 'string' && direct.trim()) searchQueries.push(direct.trim())
        } else if (evt.type === 'content_block_delta' && evt.delta?.type === 'input_json_delta' && evt.index === activeToolIndex) {
          activeToolJson += evt.delta.partial_json ?? ''
        } else if (evt.type === 'content_block_stop' && evt.index === activeToolIndex) {
          try {
            const q = JSON.parse(activeToolJson)?.query
            if (typeof q === 'string' && q.trim()) searchQueries.push(q.trim())
          } catch { /* partial or non-JSON input — the count still stands */ }
          activeToolIndex = null
          activeToolJson = ''
        } else if (evt.type === 'message_delta' && evt.delta?.stop_reason) {
          stopReason = evt.delta.stop_reason
        }
      }
    }
  } catch (e) {
    // AbortController.abort() makes fetch (and the in-progress body read)
    // reject with a DOMException/Error named 'AbortError' in Node's fetch
    // (undici) same as in a browser — that's the one and only way this
    // catch's abort branch fires, so it's safe to treat any AbortError here
    // as our own timeout (nothing else in this function aborts the signal).
    // `accumulated` still holds whatever streamed in before the abort.
    if (e?.name === 'AbortError') throw new ResearchTimeoutError(Date.now() - startedAt, accumulated)
    throw e
  } finally {
    clearTimeout(timeoutId)
    publish()
  }

  console.log(`[opportunity-scanner-worker-background] research: ${webSearches} web search(es), ${accumulated.length} chars, stop_reason=${stopReason}, ${Date.now() - startedAt}ms`)
  if (searchQueries.length) {
    console.log(`[opportunity-scanner-worker-background] queries actually run:\n${searchQueries.map((q, i) => `  ${i + 1}. ${q}`).join('\n')}`)
  }
  return accumulated
}

// Same take-once pattern as takeReplicateAudit — see its note on why this is
// module-level rather than threaded through the return value (fetchResearchText
// has a timeout/partial-recovery path that must keep its current shape).
let lastResearchTelemetry = { research_ms: null, research_chars: null, web_searches: null, stop_reason: null, search_queries: null }
export function takeResearchTelemetry() {
  const t = lastResearchTelemetry
  lastResearchTelemetry = { research_ms: null, research_chars: null, web_searches: null, stop_reason: null, search_queries: null }
  return t
}

export function parseOpportunities(text) {
  // Prefer a fenced ```json block; fall back to the last bare [...] array.
  let jsonStr = null
  const fenced = [...text.matchAll(/```json\s*([\s\S]*?)```/g)]
  if (fenced.length) {
    jsonStr = fenced[fenced.length - 1][1].trim()
  } else {
    const start = text.lastIndexOf('[')
    const end = text.lastIndexOf(']')
    if (start !== -1 && end !== -1 && end > start) jsonStr = text.slice(start, end + 1)
  }
  if (!jsonStr) throw new Error('No JSON array found in the model response')

  const parsed = JSON.parse(jsonStr)
  if (!Array.isArray(parsed)) throw new Error('Model response JSON was not an array')
  return parsed.slice(0, 5)
}

// Parses the separate "BUSINESSES TO REPLICATE" section — a distinctly
// fenced ```replicate block (never ```json, so this can never accidentally
// match the opportunities block above or vice versa). Independent of
// parseOpportunities so a failure here can be handled without affecting the
// existing opportunity analysis at all.
// Ceiling, not a target. Three is deliberately lower than the old five: the
// failure mode this section had was padding towards a quota with near-identical
// competitors, and a smaller ceiling removes some of the pull to do that.
export const REPLICATE_MAX = 3

const isStr = (v) => typeof v === 'string' && v.trim().length > 0
const isUrl = (v) => isStr(v) && /^https?:\/\/[^\s]+\.[^\s]+/i.test(v.trim())

// Why this exists as CODE and not only as prompt wording: instructions alone
// have not held in the past for this section (see the migration notes on
// opportunity_scanner_replicate_findings for the section's history). These
// checks are structural: an entry that does not carry its own evidence
// cannot reach the email regardless of how convincing its prose is.
//
// Deliberately checks for the PRESENCE and SHAPE of evidence, never the
// truth of it — code cannot know whether a Trustpilot count is accurate. It
// can know whether the model recorded a real evidence type, a real detail,
// and a real source. That is the measure-then-judge split used everywhere
// else in this file: the model measures, fixed rules decide.
const EVIDENCE_TYPES = new Set(['companies_house', 'reviews', 'hiring', 'growth_signal'])
const GAP_TYPES = new Set(['review_complaint', 'missing_feature', 'price_gap', 'ux_problem'])
const LOW_CAPITAL_MODELS = new Set(['saas', 'service', 'marketplace', 'content_subscription'])

// Catches the improve field's equivalent of "more modern" — a whole-string
// non-answer with no named specific behind it. Same crude, deliberately
// narrow match as VAGUE_EDGE used to be: it only fires when the phrase IS
// essentially the whole claim, so a real evidenced sentence that happens to
// contain the word "better" is not caught by it.
const VAGUE_IMPROVE = /^(?:we\s+could\s+|you\s+could\s+|it\s+could\s+be\s+|they\s+could\s+)?(?:make\s+it\s+|do\s+it\s+)?(?:better|cheaper|faster|simpler|easier(?:\s+to\s+use)?|more\s+modern|more\s+user[- ]friendly|improved?(?:\s+ux)?)\b[\s.!]*$/i

// Catches the low-capital "why" field asserting rather than reasoning — "it's
// software" restates the model, it doesn't explain why THIS business is
// low-capital to replicate.
const VAGUE_LOW_CAPITAL = /^(?:it'?s?\s+|this\s+is\s+)?(?:just\s+)?(?:software|a\s+saas(?:\s+product)?|an?\s+app|digital)\b[\s.!]*$/i

export function replicateFindingRejectionReasons(o) {
  if (!o || typeof o !== 'object') return ['not an object']
  const reasons = []

  if (!isStr(o.name)) reasons.push('no business name')
  if (!isUrl(o.url)) reasons.push('no usable URL')
  if (!isStr(o.idea_key)) reasons.push('no idea_key — cannot enforce one-idea-one-entry without it')

  const t = o.traction_evidence
  if (!t || typeof t !== 'object') {
    reasons.push('no traction_evidence — the evidence-of-traction bar is unsupported')
  } else {
    const type = String(t.type ?? '').trim().toLowerCase()
    if (!EVIDENCE_TYPES.has(type)) reasons.push(`traction_evidence.type must be one of ${[...EVIDENCE_TYPES].join('/')}, got ${JSON.stringify(t.type ?? null)}`)
    if (!isStr(t.detail)) reasons.push('traction_evidence.detail missing — no actual figure or fact')
    if (!isUrl(t.source_url)) reasons.push('traction_evidence.source_url missing or not a usable URL — evidence cited to nothing checkable')
  }

  const r = o.replicate
  if (!r || typeof r !== 'object') reasons.push('no replicate — the REPLICATE question was not answered')
  else {
    if (!isStr(r.customer)) reasons.push('replicate.customer missing — who the actual buyer is was not named')
    if (!isStr(r.mechanism)) reasons.push('replicate.mechanism missing — the actual differentiator was not stated')
  }

  const im = o.improve
  if (!im || typeof im !== 'object') reasons.push('no improve — the IMPROVE question was not answered')
  else {
    const gapType = String(im.gap_type ?? '').trim().toLowerCase()
    if (!GAP_TYPES.has(gapType)) reasons.push(`improve.gap_type must be one of ${[...GAP_TYPES].join('/')}, got ${JSON.stringify(im.gap_type ?? null)}`)
    if (!isStr(im.detail)) reasons.push('improve.detail missing')
    else if (VAGUE_IMPROVE.test(im.detail)) reasons.push(`improve.detail is a vague claim, not a specific evidenced gap: "${im.detail}"`)
    if (!isStr(im.evidence_source)) reasons.push('improve.evidence_source missing — the gap is asserted, not evidenced')
  }

  const lc = o.low_capital
  if (!lc || typeof lc !== 'object') reasons.push('no low_capital — the LOW CAPITAL question was not answered')
  else {
    const model = String(lc.model ?? '').trim().toLowerCase()
    if (!LOW_CAPITAL_MODELS.has(model)) reasons.push(`low_capital.model must be one of ${[...LOW_CAPITAL_MODELS].join('/')}, got ${JSON.stringify(lc.model ?? null)}`)
    if (!isStr(lc.why)) reasons.push('low_capital.why missing')
    else if (VAGUE_LOW_CAPITAL.test(lc.why)) reasons.push(`low_capital.why asserts rather than reasons: "${lc.why}"`)
  }

  const st = o.search_trail
  if (!st || typeof st !== 'object') {
    reasons.push('no search_trail — the discovery/verification queries were not recorded')
  } else {
    if (!Array.isArray(st.discovery_queries) || !st.discovery_queries.some(isStr)) {
      reasons.push('search_trail.discovery_queries is empty — no evidence the candidate was actually found via search')
    }
    if (!Array.isArray(st.verification_queries) || !st.verification_queries.some(isStr)) {
      reasons.push('search_trail.verification_queries is empty — no evidence the traction/gap claims were actually verified')
    }
  }

  const effort = String(o.effort ?? '').trim()
  if (!['Low', 'Medium', 'High'].includes(effort)) reasons.push(`effort must be Low/Medium/High, got ${JSON.stringify(o.effort ?? null)}`)

  const verdict = String(o.verdict ?? '').trim().toUpperCase()
  if (!['CLONE IT', 'WORTH STUDYING', 'LEAVE IT'].includes(verdict)) reasons.push(`verdict must be CLONE IT/WORTH STUDYING/LEAVE IT, got ${JSON.stringify(o.verdict ?? null)}`)

  return reasons
}

// Applies the per-entry rules above, then the two cross-entry rules a
// single-entry check structurally cannot catch: one business model per
// email, one business per email. Returns EVERY candidate examined, annotated
// kept/drop_reasons, rather than the old {kept, dropped} split — dropped
// candidates keep their full evidence fields so the whole batch can be
// persisted as one evidence trail (see persistReplicateFindings), not just
// the ones that shipped.
export function filterReplicateFindings(entries) {
  const seenIdea = new Set()
  const seenName = new Set()
  const annotated = []

  for (const o of Array.isArray(entries) ? entries : []) {
    const reasons = replicateFindingRejectionReasons(o)
    const ideaKey = String(o?.idea_key ?? '').trim().toLowerCase()
    const nameKey = String(o?.name ?? '').trim().toLowerCase()

    if (!reasons.length) {
      if (ideaKey && seenIdea.has(ideaKey)) reasons.push(`same underlying business model as an earlier entry ("${ideaKey}") — one idea, one entry`)
      else if (nameKey && seenName.has(nameKey)) reasons.push(`duplicate business "${o.name}"`)
    }

    if (reasons.length) {
      annotated.push({ ...o, kept: false, drop_reasons: reasons })
      continue
    }

    seenIdea.add(ideaKey)
    seenName.add(nameKey)
    annotated.push({ ...o, kept: true, drop_reasons: null })
  }

  // Ceiling applied last, over entries that already passed everything else —
  // an over-quota entry was valid, it just lost on ordering, and that reads
  // very differently in the evidence trail from an entry that failed the bar.
  let keptCount = 0
  for (const a of annotated) {
    if (!a.kept) continue
    keptCount++
    if (keptCount > REPLICATE_MAX) {
      a.kept = false
      a.drop_reasons = [`over the ${REPLICATE_MAX}-entry ceiling`]
    }
  }

  return annotated
}

// Repeat-prevention against opportunity_scanner_seen_items (section
// 'replicate') — the SAME normaliseKey/titlesSimilar dedup logic legislation
// already uses, not a parallel implementation. filterUnseenLegislation only
// ever reads item.title, so a thin adapter mapping name -> title is enough
// to reuse it exactly rather than re-deriving the same rules a second time.
export function filterUnseenReplicate(items, seen) {
  const titled = items.map((it) => ({ ...it, title: it.name }))
  const { kept, dropped } = filterUnseenLegislation(titled, seen)
  return {
    kept: kept.map(({ title, ...rest }) => rest),
    dropped: dropped.map((d) => ({ name: d.title, reason: d.reason })),
  }
}

export function parseReplicateBusinesses(text) {
  // Cleared before any throw path below. Netlify reuses warm containers, so
  // without this a parse failure would leave the PREVIOUS invocation's audit
  // in place and the run log would attribute it to this run.
  lastReplicateAudit = { kept: 0, dropped: [] }
  lastReplicateFindings = []

  let jsonStr = null
  const fenced = [...text.matchAll(/```replicate\s*([\s\S]*?)```/g)]
  if (fenced.length) jsonStr = fenced[fenced.length - 1][1].trim()
  if (!jsonStr) {
    // Recorded, not just thrown. An empty section has three quite different
    // causes — the model returned no block, it returned an empty array, or
    // the filter rejected everything — and they call for opposite responses
    // (the prompt is broken / the bar is too high / the bar is working).
    lastReplicateAudit = { kept: 0, dropped: [{ name: '(none)', reasons: ['model returned no ```replicate block at all'] }] }
    throw new Error('No ```replicate block found in the model response')
  }

  const parsed = JSON.parse(jsonStr)
  if (!Array.isArray(parsed)) throw new Error('Businesses-to-replicate JSON was not an array')
  if (!parsed.length) {
    lastReplicateAudit = { kept: 0, dropped: [{ name: '(none)', reasons: ['model returned an empty replicate array — it found nothing it judged to qualify'] }] }
    return []
  }

  const annotated = filterReplicateFindings(parsed)
  const kept = annotated.filter((a) => a.kept)
  const dropped = annotated
    .filter((a) => !a.kept)
    .map((a) => ({ name: isStr(a?.name) ? a.name : '(unnamed)', reasons: a.drop_reasons ?? [] }))

  for (const d of dropped) {
    console.log(`[opportunity-scanner-worker-background] replicate entry dropped — ${d.name}: ${d.reasons.join('; ')}`)
  }
  if (parsed.length && !kept.length) {
    console.log(`[opportunity-scanner-worker-background] all ${parsed.length} replicate entr${parsed.length === 1 ? 'y' : 'ies'} failed the evidence bar — section will be omitted`)
  }
  // Handed to the run log so the outcome survives the request. Console output
  // from a background function is not reliably retrievable afterwards.
  lastReplicateAudit = { kept: kept.length, dropped }
  // The full annotated batch (kept AND dropped, every field intact) — handed
  // to persistReplicateFindings so the evidence trail covers every candidate
  // examined, not just what shipped. See takeReplicateFindings.
  lastReplicateFindings = annotated
  return kept
}

// Module-level rather than a return value because parseReplicateBusinesses is
// called inside a try/catch whose failure path must not change, and threading a
// second value through it would ripple into the partial-recovery path too.
let lastReplicateAudit = { kept: 0, dropped: [] }
export function takeReplicateAudit() {
  const audit = lastReplicateAudit
  lastReplicateAudit = { kept: 0, dropped: [] }
  return audit
}

// Same take-once pattern as takeReplicateAudit, for the full per-candidate
// evidence trail persisted to opportunity_scanner_replicate_findings.
let lastReplicateFindings = []
export function takeReplicateFindings() {
  const findings = lastReplicateFindings
  lastReplicateFindings = []
  return findings
}


// Parses the "UK COMPANIES HOUSE INTELLIGENCE" section — a distinctly fenced
// ```prospects block (never ```json or ```replicate, so it can never
// accidentally match either of those). Independent of the other two parses,
// same pattern as parseReplicateBusinesses, so a failure here can be handled
// without affecting the opportunity analysis or the replicate-businesses
// section at all.
export function parseProspects(text) {
  let jsonStr = null
  const fenced = [...text.matchAll(/```prospects\s*([\s\S]*?)```/g)]
  if (fenced.length) jsonStr = fenced[fenced.length - 1][1].trim()
  if (!jsonStr) throw new Error('No ```prospects block found in the model response')

  const parsed = JSON.parse(jsonStr)
  if (!Array.isArray(parsed)) throw new Error('YCA prospects JSON was not an array')
  return parsed.slice(0, 5)
}

// Auto-inserts YCA prospects straight into the outreach platform's own
// outreach_prospects table (same Supabase project) instead of surfacing them
// in this email — Adrian doesn't need to see these, the outreach platform's
// own daily sequence enrollment picks them up from there. Case-insensitive
// dedup on company_name; a prospect already present is skipped, not
// re-inserted or updated. contact_name isn't part of the current
// ```prospects schema (name/website/trade/incorporated/signal/why_yca), so
// it will typically be absent — included when present in case that ever
// changes. Best-effort per row: a lookup or insert failure for one prospect
// is logged and skipped, never thrown, so one bad row can't drop the rest.
async function insertProspects(admin, prospects) {
  let inserted = 0
  let skipped = 0

  for (const p of prospects) {
    const companyName = String(p.name ?? '').trim()
    if (!companyName) { skipped++; continue }

    const { count, error: lookupError } = await admin
      .from('outreach_prospects')
      .select('id', { count: 'exact', head: true })
      .ilike('company_name', companyName)
    if (lookupError) {
      console.error(`[opportunity-scanner-worker-background] outreach_prospects lookup failed for "${companyName}": ${lookupError.message}`)
      continue
    }
    if ((count ?? 0) > 0) { skipped++; continue }

    const row = {
      company_name: companyName,
      website_url: p.website || null,
      industry: p.trade || null,
      source: 'opportunity_scanner',
      stage: 'new',
    }
    if (p.contact_name) row.contact_name = p.contact_name

    const { error: insertError } = await admin.from('outreach_prospects').insert(row)
    if (insertError) {
      console.error(`[opportunity-scanner-worker-background] outreach_prospects insert failed for "${companyName}": ${insertError.message}`)
      continue
    }
    inserted++
  }

  return { inserted, skipped }
}

// Parses the "UK LEGISLATION AND REGULATORY INTELLIGENCE" section — a
// distinctly fenced ```legislation block (never ```json, ```replicate, or
// ```prospects, so it can never accidentally match any of those). Same
// pattern as parseReplicateBusinesses and parseProspects, independent of
// the other three parses, so a failure here can be handled without
// affecting any of them.
export function parseLegislation(text) {
  let jsonStr = null
  const fenced = [...text.matchAll(/```legislation\s*([\s\S]*?)```/g)]
  if (fenced.length) jsonStr = fenced[fenced.length - 1][1].trim()
  if (!jsonStr) throw new Error('No ```legislation block found in the model response')

  const parsed = JSON.parse(jsonStr)
  if (!Array.isArray(parsed)) throw new Error('UK legislation JSON was not an array')
  return parsed.slice(0, 5)
}

// ── Email ───────────────────────────────────────────────────────────────────
const esc = (s) =>
  String(s ?? '—').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

function verdictBadge(v) {
  const key = String(v || '').toLowerCase()
  const style = key.startsWith('strong')
    ? { bg: '#dcfce7', fg: '#166534' }
    : key.startsWith('worth')
      ? { bg: '#fef9c3', fg: '#854d0e' }
      : { bg: '#f3f4f6', fg: '#6b7280' }
  return `<span style="display:inline-block;background:${style.bg};color:${style.fg};font-weight:700;font-size:12px;padding:3px 10px;border-radius:4px;font-family:sans-serif;white-space:nowrap">${esc(v)}</span>`
}

function field(label, value) {
  return `
    <div style="margin-bottom:12px">
      <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.06em;color:#6b7280;font-family:sans-serif;margin-bottom:4px">${label}</div>
      <div style="font-size:13px;color:#374151;font-family:sans-serif;line-height:1.6">${esc(value)}</div>
    </div>`
}

// Numeric criteria score (out of 80) badge — distinct from verdictBadge, which
// carries Claude's separate qualitative Strong/Worth investigating/Pass call.
// Both are shown; neither replaces the other.
function scoreBadge(score) {
  const strong = score >= 45
  const bg = strong ? '#dcfce7' : '#fef9c3'
  const fg = strong ? '#166534' : '#854d0e'
  return `<span style="display:inline-block;background:${bg};color:${fg};font-weight:700;font-size:13px;padding:3px 10px;border-radius:4px;font-family:sans-serif;white-space:nowrap">${score}/80</span>`
}

// "Competition Reality" — the 3 named competitors + scale from competitor_research,
// rendered before the score per the mandatory-competitor-research-first requirement.
// Renders nothing if the model didn't return competitor_research (never blocks the card).
function competitionReality(o) {
  const cr = o.competitor_research ?? {}
  const competitors = Array.isArray(cr.competitors) ? cr.competitors : []
  if (!competitors.length) return ''
  const rows = competitors.slice(0, 3).map((c) => {
    const backed = c.backed && String(c.backed).toLowerCase() !== 'none' ? String(c.backed) + '-backed' : 'no institutional backing'
    // Table, not flexbox, for this row — display:flex has no support in
    // Outlook (Word rendering engine) and is inconsistent across mobile
    // mail clients. Without an explicit width, the name cell can get
    // squeezed by the nowrap details cell next to it on a narrow viewport,
    // and once a client can't fit even one word it falls back to breaking
    // between every character — exactly the reported vertical-text bug.
    // width="1" on the details <td> is the standard email-safe trick: give
    // that column only the minimum width its non-wrapping content needs,
    // and let the name column take the rest, with no way for it to be
    // squeezed to a razor-thin width the way an unconstrained flex item
    // could be.
    return `
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;font-family:sans-serif">
        <tr>
          <td style="padding:6px 12px 6px 0;font-size:13px;color:#111827;font-weight:600;vertical-align:baseline;border-bottom:1px solid #e5e7eb">${esc(c.name)}</td>
          <td width="1" style="padding:6px 0;font-size:12px;color:#6b7280;text-align:right;white-space:nowrap;vertical-align:baseline;border-bottom:1px solid #e5e7eb">${esc(c.scale)} &middot; ${esc(c.estimated_revenue)} &middot; ${backed}</td>
        </tr>
      </table>`
  }).join('')
  const whiteLabel = cr.white_label_or_commodity
    ? `<div style="font-size:12px;color:#92400e;background:#fffbeb;border-radius:4px;padding:6px 10px;margin-top:8px;font-family:sans-serif">White-label / commodity — no formula or IP exclusivity${cr.white_label_notes ? ': ' + esc(cr.white_label_notes) : ''}</div>`
    : ''
  return `
    <div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:14px 16px;margin-bottom:14px">
      <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.06em;color:#6b7280;font-family:sans-serif;margin-bottom:6px">Competition Reality</div>
      ${rows}
      ${whiteLabel}
    </div>`
}

function card(o, i) {
  const totalScore = typeof o.total_score === 'number' ? o.total_score : null
  // Table, not flexbox — same fix as competitionReality() above, same bug:
  // a flex:1 title next to a white-space:nowrap badge can
  // get squeezed to a razor-thin width in Outlook/mobile mail clients,
  // producing the vertical, one-letter-per-line rendering.
  const header = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin-bottom:14px">
      <tr>
        <td style="vertical-align:top"><div style="font-size:17px;font-weight:700;color:#111827;font-family:sans-serif;line-height:1.4">${i + 1}. ${esc(o.name)}</div></td>
        <td width="1" style="vertical-align:top;padding-left:12px;white-space:nowrap">${verdictBadge(String(o.verdict ?? ''))}</td>
      </tr>
    </table>`
  return `
  <div style="background:#ffffff;border:1px solid #e5e7eb;border-radius:10px;padding:24px;margin-bottom:20px">
    ${header}
    ${competitionReality(o)}
    ${totalScore !== null ? `
    <div style="margin-bottom:14px">
      <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.06em;color:#6b7280;font-family:sans-serif;margin-bottom:4px">Opportunity score</div>
      ${scoreBadge(totalScore)}
    </div>` : ''}
    ${field('What it is', o.what_it_is)}
    ${field('Proof of demand', o.proof_of_demand)}
    ${field('Margin &amp; fulfilment', o.margin_and_fulfilment)}
    ${field('How AI improves / automates it', o.ai_angle)}
    ${field('UK readiness', o.uk_readiness)}
  </div>`
}

// ── Businesses to Replicate — a separate section appended below the existing
// opportunity cards. Nothing above this point in the email (heading, cards,
// footer copy) is changed by its presence; when there's nothing to show
// (parse failed or empty) buildEmail renders exactly as it did before.
function verdictBadgeReplicate(v) {
  const key = String(v || '').toLowerCase()
  const style = key.startsWith('clone')
    ? { bg: '#dcfce7', fg: '#166534' }
    : key.startsWith('worth')
      ? { bg: '#fef9c3', fg: '#854d0e' }
      : { bg: '#f3f4f6', fg: '#6b7280' }
  return `<span style="display:inline-block;background:${style.bg};color:${style.fg};font-weight:700;font-size:12px;padding:3px 10px;border-radius:4px;font-family:sans-serif;white-space:nowrap">${esc(v)}</span>`
}

// Evidence-type chip — names which of the four evidence-of-traction signals
// this finding cleared, so the claim being made is legible before reading
// the detail rather than buried inside a field nobody reads.
function evidenceChipReplicate(type) {
  const labels = {
    companies_house: 'Companies House filed accounts',
    reviews: 'Sustained review volume',
    hiring: 'Active hiring',
    growth_signal: 'Documented growth',
  }
  const label = labels[String(type || '').trim().toLowerCase()] ?? String(type || 'unverified')
  return `<span style="display:inline-block;background:#e0f2fe;color:#075985;font-weight:700;font-size:11px;padding:3px 9px;border-radius:4px;font-family:sans-serif;white-space:nowrap">${esc(label)}</span>`
}

function replicateCard(o, i) {
  const titleHtml = o.url
    ? `<a href="${esc(o.url)}" style="color:#111827;text-decoration:none">${esc(o.name)}</a>`
    : esc(o.name)

  // Traction evidence rendered as figure-then-source rather than prose, so a
  // claim with nothing behind it would look conspicuously empty instead of
  // reading as confident copy. That asymmetry is the point.
  const t = o.traction_evidence
  const tractionHtml = t && typeof t === 'object'
    ? field('Evidence of traction', `${t.detail ?? ''}${t.source_url ? ` — ${t.source_url}` : ' (no source given)'}`)
    : ''

  const r = o.replicate
  const replicateHtml = r && typeof r === 'object'
    ? field('Replicate — the customer', r.customer ?? '') + field('Replicate — the mechanism', r.mechanism ?? '')
    : ''

  const im = o.improve
  const gapLabels = {
    review_complaint: 'Review complaint',
    missing_feature: 'Missing feature',
    price_gap: 'Price gap',
    ux_problem: 'UX problem',
  }
  const improveHtml = im && typeof im === 'object'
    ? field(`Improve — ${gapLabels[String(im.gap_type || '').toLowerCase()] ?? im.gap_type ?? ''}`, `${im.detail ?? ''}${im.evidence_source ? ` (${im.evidence_source})` : ''}`)
    : ''

  const lc = o.low_capital
  const lowCapitalHtml = lc && typeof lc === 'object'
    ? field(`Low capital — ${lc.model ?? ''}`, lc.why ?? '')
    : ''

  const st = o.search_trail
  const searchTrailHtml = st && typeof st === 'object'
    ? field('Discovery searches', Array.isArray(st.discovery_queries) ? st.discovery_queries.filter(isStr).join(' · ') : '') +
      field('Verification searches', Array.isArray(st.verification_queries) ? st.verification_queries.filter(isStr).join(' · ') : '')
    : ''

  return `
  <div style="background:#ffffff;border:1px solid #e5e7eb;border-radius:10px;padding:24px;margin-bottom:20px">
    <div style="display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:4px;gap:12px">
      <div style="font-size:17px;font-weight:700;color:#111827;font-family:sans-serif;line-height:1.4;flex:1">${i + 1}. ${titleHtml}</div>
      ${verdictBadgeReplicate(String(o.verdict ?? ''))}
    </div>
    <div style="margin-bottom:10px">${evidenceChipReplicate(o.traction_evidence?.type)}</div>
    ${o.url ? `<div style="font-size:12px;color:#6b7280;font-family:sans-serif;margin-bottom:12px;word-break:break-all">${esc(o.url)}</div>` : ''}
    ${tractionHtml}
    ${replicateHtml}
    ${improveHtml}
    ${lowCapitalHtml}
    ${searchTrailHtml}
    ${field('Effort to replicate', o.effort)}
  </div>`
}

// ── UK Legislation Watch — a section appended below Businesses to Replicate.
// Same additive pattern as the other three: nothing above this point in the
// email is changed by its presence, and when there's nothing to show (parse
// failed or empty) buildEmail renders exactly as it did before this section
// existed.
function legislationCard(o, i) {
  return `
  <div style="background:#ffffff;border:1px solid #e5e7eb;border-radius:10px;padding:24px;margin-bottom:20px">
    <div style="display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:4px;gap:12px">
      <div style="font-size:17px;font-weight:700;color:#111827;font-family:sans-serif;line-height:1.4;flex:1">${i + 1}. ${esc(o.title)}</div>
      ${o.relevant_brand ? `<span style="display:inline-block;background:#f3f4f6;color:#6b7280;font-weight:700;font-size:12px;padding:3px 10px;border-radius:4px;font-family:sans-serif;white-space:nowrap">${esc(o.relevant_brand)}</span>` : ''}
    </div>
    ${field('Summary', o.summary)}
    ${field('In force', o.in_force)}
    ${field('Who it affects', o.affects)}
    ${field('Opportunity', o.opportunity)}
  </div>`
}

// Regulatory-driven opportunity card — a legislation change that cleared the
// full buildability bar and 8-criteria scoring, so it belongs with the scored
// opportunities rather than in the informational watch list. Reuses Section
// A's own `card()` renderer so a scored opportunity looks identical wherever
// it appears, with the regulatory driver added above it as the thing that
// makes this one different.
function regulatoryOpportunityCard(o, i) {
  const driver = o.regulatory_driver
    ? `<div style="font-size:12px;color:#3730a3;background:#eef2ff;border-radius:4px;padding:6px 10px;margin-bottom:10px;font-family:sans-serif">Regulatory driver: ${esc(o.regulatory_driver)}</div>`
    : ''
  return `${driver}${card(o, i)}`
}

// ── Section B email — YCA prospects + regulatory-driven opportunities + UK
// legislation watch. Entirely separate from buildEmail (Section A's
// opportunities/replicate email); the two sections never share a run, so
// there's no case where both need rendering together.
//
// Prospects still render an explicit "nothing today" line when empty, so a
// quiet day still reads as "it ran and checked". Legislation deliberately
// does NOT: see the omission note on legislationSection below.
//
// Reduced to a count-only line (26 Aug 2026) — this used to render a full
// card per prospect (name, trade, website, incorporated date, signal, why
// YCA) via prospectCard(), which had a recurring Outlook/mobile vertical
// one-letter-per-line rendering bug that was "fixed" once (8e29bee) and kept
// recurring. Per-entry detail here also had no review value: every prospect
// is already auto-inserted into outreach_prospects (see insertProspects)
// before this email is even built, so this section was never the place a
// prospect got acted on — the outreach platform's own pipeline is. A count
// is the only thing worth showing; prospectCard() has been removed entirely
// rather than patched again, so there is no per-entry markup left to break.
function buildProspectsLegislationEmail(prospects, legislationItems, dateStr, opts = {}) {
  const banner = opts.partial ? partialResultsBanner('B', opts.elapsedMs) : ''
  const regulatoryOpportunities = opts.regulatoryOpportunities ?? []
  const prospectsSection = prospects.length
    ? `<div style="font-size:13px;color:#6b7280;font-family:sans-serif;margin-bottom:20px">${prospects.length} new prospect${prospects.length === 1 ? '' : 's'} added to outreach today.</div>`
    : `<div style="font-size:13px;color:#6b7280;font-family:sans-serif;margin-bottom:20px">No new YCA prospects found today.</div>`

  // Scored opportunities that happen to be driven by a regulatory change.
  // Omitted entirely when empty for the same reason as the watch list below —
  // most days no legislation clears the buildability bar, and an empty
  // "Scored Opportunities" heading would imply the scan found something.
  const regulatorySection = regulatoryOpportunities.length
    ? `
  <div style="margin-top:8px;margin-bottom:20px;padding-top:28px;border-top:2px solid #e5e7eb">
    <div style="font-size:20px;font-weight:700;color:#111827;font-family:sans-serif;margin-bottom:4px">Scored Opportunities</div>
    <div style="font-size:13px;color:#6b7280;font-family:sans-serif;margin-bottom:20px">${regulatoryOpportunities.length} buildable opportunit${regulatoryOpportunities.length === 1 ? 'y' : 'ies'} created by a regulatory change</div>
    ${regulatoryOpportunities.map(regulatoryOpportunityCard).join('')}
  </div>`
    : ''

  // Omitted entirely when there's nothing new — NOT rendered as an empty or
  // "nothing found today" section. Before repeat prevention existed this
  // section repeated the same handful of major changes every run, which
  // trained the reader to skip it; now that it only ever contains genuinely
  // new items, its presence is the signal. An empty-state line would put a
  // heading in front of the reader on most days for no reason and dilute
  // that signal back to nothing. Prospects keep their empty-state line
  // because "no new prospects today" is itself a meaningful daily datapoint.
  const legislationSection = legislationItems.length
    ? `
  <div style="margin-top:8px;margin-bottom:20px;padding-top:28px;border-top:2px solid #e5e7eb">
    <div style="font-size:20px;font-weight:700;color:#111827;font-family:sans-serif;margin-bottom:4px">UK Legislation Watch</div>
    <div style="font-size:13px;color:#6b7280;font-family:sans-serif;margin-bottom:20px">${legislationItems.length} new regulatory change${legislationItems.length === 1 ? '' : 's'} worth knowing about</div>
    ${legislationItems.map(legislationCard).join('')}
  </div>`
    : ''
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f3f4f6">
<div style="max-width:640px;margin:0 auto;padding:32px 16px">
  <div style="margin-bottom:28px">
    <div style="font-size:22px;font-weight:700;color:#111827;font-family:sans-serif;margin-bottom:4px">YCA prospects + legislation</div>
    <div style="font-size:13px;color:#6b7280;font-family:sans-serif">${esc(dateStr)}</div>
  </div>
  ${banner}
  ${prospectsSection}
  ${regulatorySection}
  ${legislationSection}
  <div style="border-top:1px solid #e5e7eb;margin-top:8px;padding-top:20px;font-size:11px;color:#9ca3af;font-family:sans-serif;line-height:1.6">
    Researched live by Claude (${MODEL}) with web search across Companies House filings and UK regulatory announcements. Sent automatically on alternating days.
  </div>
</div></body></html>`
}

// Section A email — opportunities + businesses to replicate only. Legislation
// belongs to Section B's own email (buildProspectsLegislationEmail) along
// with prospects, since both sections run on separate days and never share
// a run.
function buildEmail(opportunities, dateStr, replicateBusinesses = [], opts = {}) {
  const banner = opts.partial ? partialResultsBanner('A', opts.elapsedMs) : ''
  const cards = opportunities.map(card).join('')
  const replicateSection = replicateBusinesses.length ? `
  <div style="margin-top:8px;margin-bottom:20px;padding-top:28px;border-top:2px solid #e5e7eb">
    <div style="font-size:20px;font-weight:700;color:#111827;font-family:sans-serif;margin-bottom:4px">Businesses to Replicate</div>
    <div style="font-size:13px;color:#6b7280;font-family:sans-serif;margin-bottom:20px">${replicateBusinesses.length} named UK business${replicateBusinesses.length === 1 ? '' : 'es'} with verified proof of traction &mdash; each evaluated against replicate, improve and low-capital</div>
    ${replicateBusinesses.map(replicateCard).join('')}
  </div>` : ''
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f3f4f6">
<div style="max-width:640px;margin:0 auto;padding:32px 16px">
  <div style="margin-bottom:28px">
    <div style="font-size:22px;font-weight:700;color:#111827;font-family:sans-serif;margin-bottom:4px">Daily opportunity scan</div>
    <div style="font-size:13px;color:#6b7280;font-family:sans-serif">${esc(dateStr)} · ${opportunities.length} opportunit${opportunities.length === 1 ? 'y' : 'ies'} to review</div>
  </div>
  ${banner}
  ${cards}
  ${replicateSection}
  <div style="border-top:1px solid #e5e7eb;margin-top:8px;padding-top:20px;font-size:11px;color:#9ca3af;font-family:sans-serif;line-height:1.6">
    Researched live by Claude (${MODEL}) with web search across Etsy/Amazon bestsellers, Google Trends UK, US/AU/CA models not yet mainstream in the UK, and Reddit founder communities. Sent automatically on alternating days.
  </div>
</div></body></html>`
}

// Fallback for the specific ResearchTimeoutError case when NO partial text
// could be recovered/parsed at all (see the handler's catch block — this is
// now the rarer sub-case; a partial-results email via buildEmail/
// buildProspectsLegislationEmail is sent instead whenever anything usable
// streamed in before the abort). Reports elapsed time and which section
// (A/B) was running rather than a bare "it was slow" — so if this fires a
// third time, the email itself says why, not just that it happened.
function timeoutEmail(dateStr, section, elapsedMs) {
  const elapsedS = Math.round((elapsedMs ?? RESEARCH_TIMEOUT_MS) / 1000)
  const sectionLabel = section === 'A' ? 'Section A (opportunities + businesses to replicate)' : 'Section B (YCA prospects + UK legislation)'
  return `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#f3f4f6">
<div style="max-width:560px;margin:0 auto;padding:32px 16px;font-family:sans-serif">
  <div style="font-size:18px;font-weight:700;color:#111827;margin-bottom:8px">Opportunity scan</div>
  <div style="font-size:13px;color:#6b7280;margin-bottom:16px">${esc(dateStr)}</div>
  <div style="background:#fff;border:1px solid #e5e7eb;border-radius:8px;padding:16px;font-size:13px;color:#374151;line-height:1.6">
    ${esc(sectionLabel)} was aborted after ${elapsedS}s (limit ${RESEARCH_TIMEOUT_MS / 1000}s) — no usable partial output was recovered from what had streamed in by then, so nothing was found to send. Will run again tomorrow on the regular schedule; this is not an automatic retry of today's run.
  </div>
</div></body></html>`
}

// Amber banner prepended to a partial-results email — see the handler's
// catch block. Makes it visually unmistakable that this is a cut-off run,
// not a normal complete one, without needing a separate email template for
// every combination of "which fields recovered".
function partialResultsBanner(section, elapsedMs) {
  const elapsedS = Math.round(elapsedMs / 1000)
  const sectionLabel = section === 'A' ? 'opportunities + businesses to replicate' : 'YCA prospects + UK legislation'
  return `
  <div style="background:#fffbeb;border:1px solid #fde68a;border-radius:8px;padding:14px 16px;margin-bottom:20px;font-family:sans-serif">
    <div style="font-size:13px;font-weight:700;color:#92400e;margin-bottom:4px">Partial results — today's ${esc(sectionLabel)} research was cut off after ${elapsedS}s</div>
    <div style="font-size:12px;color:#92400e;line-height:1.5">Whatever had completed before the abort is below. Some sections below may be shorter than usual, or a section that normally appears may be missing entirely if it hadn't been reached yet.</div>
  </div>`
}

function failureEmail(errMsg, dateStr) {
  return `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#f3f4f6">
<div style="max-width:560px;margin:0 auto;padding:32px 16px;font-family:sans-serif">
  <div style="font-size:18px;font-weight:700;color:#991b1b;margin-bottom:8px">Opportunity scanner failed</div>
  <div style="font-size:13px;color:#6b7280;margin-bottom:16px">${esc(dateStr)}</div>
  <div style="background:#fff;border:1px solid #fecaca;border-radius:8px;padding:16px;font-size:13px;color:#374151;line-height:1.6">
    Today's opportunity scan did not complete. No opportunities were emailed.<br><br>
    <strong>Error:</strong> ${esc(errMsg)}
  </div>
  <div style="font-size:11px;color:#9ca3af;margin-top:16px">This is the scanner's own failure notification — it ran, hit an error, and told you rather than failing silently.</div>
</div></body></html>`
}

// The date line printed at the top of every email this function sends.
//
// Display only. This was a bare toLocaleDateString('en-GB', ...), which
// formats in the RUNTIME's local timezone — and Netlify Functions run in
// UTC, not Europe/London — so during BST an email built just after UK
// midnight was headed with the previous day's date. Pinned to
// Europe/London, which is date-aware via tzdata: no hardcoded offset, so it
// stays correct across the late-October BST->GMT switch. Mirrors
// supabase/functions/_shared/ukTime.ts, which this file cannot import
// across the Deno/Node boundary.
//
// dateStr (the ISO YYYY-MM-DD used for subjects and for sectionForDate's
// odd/even A/B selection) is deliberately left on UTC: it is a run key and
// a scheduling input, not a rendered timestamp, and the scanner's cron fires
// at 07:00 UTC where the UTC and UK dates always agree anyway.
function ukPrettyDate(d = new Date()) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London',
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  }).format(d)
}

async function sendEmail(resendKey, from, to, subject, html) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from, to, subject, html }),
  })
  if (!res.ok) throw new Error(`Resend ${res.status}: ${(await res.text()).slice(0, 300)}`)
  return await res.json()
}

// Netlify's edge layer was caching this background function's response —
// see the netlify.toml header rule for this path, which is what actually
// governs the immediate 202 Netlify sends the caller (background functions
// respond before this handler even starts running, so that 202 is never
// literally this return value — see the Handler comment below). These
// headers are set on every response this handler code does return, both
// for consistency with that rule and because they apply directly whenever
// this function runs synchronously (e.g. local `netlify dev`).
const NO_CACHE_HEADERS = {
  'Cache-Control': 'no-cache, no-store, must-revalidate',
  Pragma: 'no-cache',
}

function json(statusCode, body) {
  return { statusCode, headers: { 'Content-Type': 'application/json', ...NO_CACHE_HEADERS }, body: JSON.stringify(body) }
}

// ── Handler ─────────────────────────────────────────────────────────────────
// Netlify invokes this the same way as any function, but because the
// filename ends in `-background`, it responds 202 to the caller immediately
// and lets this handler keep running for up to 15 minutes — the caller (the
// Supabase opportunity-scanner trigger) never sees or waits on this
// function's actual return value below; it only matters for this function's
// own logs.
export async function handler(event) {
  if (event.httpMethod !== 'POST') {
    return json(405, { ok: false, error: 'Method not allowed' })
  }

  // Shared-secret check — see file header. Checked first, before anything
  // that costs money or touches the database.
  const expectedSecret = process.env.INTERNAL_SECRET
  if (!expectedSecret) {
    console.error('[opportunity-scanner-worker-background] INTERNAL_SECRET is not set — refusing to run')
    return json(500, { ok: false, error: 'Server not configured: INTERNAL_SECRET is not set on this Netlify site' })
  }
  const authHeader = event.headers?.authorization || event.headers?.Authorization || ''
  const suppliedSecret = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : ''
  if (!suppliedSecret || suppliedSecret !== expectedSecret) {
    return json(401, { ok: false, error: 'Unauthorised' })
  }

  const dateStr = new Date().toISOString().slice(0, 10)
  // RESEND_API_KEY is unaffected by this change — still read from the
  // Netlify site env var exactly as before.
  const resendKey = process.env.RESEND_API_KEY
  const fromEmail = process.env.OPPORTUNITY_EMAIL_FROM || FALLBACK_FROM
  const toEmail = process.env.OPPORTUNITY_EMAIL_TO || FALLBACK_TO

  const SUPABASE_URL = process.env.SUPABASE_URL
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY
  // Node.js 20 detected without native WebSocket support — same fix as the
  // outreach platform: pass the global fetch explicitly and disable realtime
  // (this function never uses subscriptions) so the client doesn't try to
  // open a WebSocket at all.
  const admin = SUPABASE_URL && SERVICE_KEY
    ? createClient(SUPABASE_URL, SERVICE_KEY, { global: { fetch }, realtime: { transport: undefined } })
    : null

  // Returns the new run's id (or null on failure/no admin) so the caller can
  // thread it into persistReplicateFindings — the evidence-trail rows need a
  // run_id FK, and this is the one place that id is ever generated.
  const logRun = async (itemsFound, emailSent, error) => {
    if (!admin) return null
    // Replicate outcome recorded alongside the opportunity count so the two
    // are distinguishable after the fact — see the migration note on these
    // columns for why a bare opportunities_found of 0 was ambiguous.
    const audit = takeReplicateAudit()
    // Research telemetry, so "searched hard and found nothing" is
    // distinguishable from "declined without searching" on any given day
    // WITHOUT having to fire synthetic runs to find out. web_searches is the
    // one that actually settles it.
    const t = takeResearchTelemetry()
    const { data, error: logErr } = await admin.from('opportunity_scanner_runs')
      .insert({
        opportunities_found: itemsFound,
        email_sent: emailSent,
        error,
        replicate_kept: audit.kept,
        replicate_dropped: audit.dropped.length ? audit.dropped : null,
        research_ms: t.research_ms,
        research_chars: t.research_chars,
        web_searches: t.web_searches,
        stop_reason: t.stop_reason,
        // The queries themselves, not just how many. Without this, a missed
        // competitor could only ever be diagnosed by guessing at what the
        // model probably searched — see the 27 Aug meal-plan miss, where the
        // real queries were unrecoverable after the fact.
        search_queries: t.search_queries?.length ? t.search_queries : null,
      })
      .select('id')
      .single()
    if (logErr) {
      console.error('[opportunity-scanner-worker-background] failed to write run log:', logErr.message)
      return null
    }
    return data?.id ?? null
  }

  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY

  // Same warm-container concern as in parseReplicateBusinesses, from the other
  // direction: Section B never parses a replicate block, so on a reused
  // container its run log would otherwise inherit Section A's audit.
  takeReplicateAudit()
  takeReplicateFindings()

  const section = sectionForDate(new Date())

  // Hoisted out of the try block so the partial-results recovery path in the
  // catch can apply the same repeat filter. A partial run still sends a real
  // email, so it must not be allowed to resend items the reader has already
  // had — the timeout is not a reason to drop the guarantee.
  let seenLegislation = []
  let seenReplicate = []

  try {
    if (!admin) throw new Error('SUPABASE_URL / SUPABASE_SERVICE_KEY not configured')
    if (!ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY not configured')
    if (!resendKey) throw new Error('RESEND_API_KEY not configured')

    const config = SECTION_CONFIG[section]
    console.log(`[opportunity-scanner-worker-background] starting run ${dateStr} — section ${section}`)

    // Already-sent items for whichever section is running today, loaded
    // BEFORE the research call so the titles/names can be injected into the
    // prompt as a live exclusion list — both buildResearchUserA (26 Aug 2026
    // replicate rebuild) and buildResearchUserB take the same shape of
    // argument now, so this is symmetric across sections rather than a
    // Section-B-only path.
    seenLegislation = section === 'B'
      ? await loadSeenItems(admin, SEEN_SECTION_LEGISLATION)
      : []
    seenReplicate = section === 'A'
      ? await loadSeenItems(admin, SEEN_SECTION_REPLICATE)
      : []
    if (section === 'B') {
      console.log(`[opportunity-scanner-worker-background] ${seenLegislation.length} previously-sent legislation item(s) will be excluded`)
    }
    if (section === 'A') {
      console.log(`[opportunity-scanner-worker-background] ${seenReplicate.length} previously-surfaced replicate business(es) will be excluded`)
    }
    const userPrompt = config.buildUserPrompt(
      section === 'A'
        ? seenReplicate.slice(0, SEEN_PROMPT_LIMIT).map((s) => s.title)
        : seenLegislation.slice(0, SEEN_PROMPT_LIMIT).map((s) => s.title),
    )

    const researchText = await fetchResearchText(ANTHROPIC_API_KEY, userPrompt, config.maxTokens, config.maxUses)
    const prettyDate = ukPrettyDate()

    if (section === 'A') {
      const opportunities = parseOpportunities(researchText)
      console.log(`[opportunity-scanner-worker-background] ${opportunities.length} opportunities surfaced`)

      // Best-effort: a failure to parse the "Businesses to Replicate"
      // section must never affect the opportunity analysis or email.
      // Two filters applied in sequence: parseReplicateBusinesses already
      // applied the evidence bar (filterReplicateFindings) and returns only
      // what survived it; filterUnseenReplicate then applies the SAME
      // repeat-prevention this scanner already uses for legislation, against
      // opportunity_scanner_seen_items (section 'replicate'). Both outcomes
      // are folded back into one evidence trail so every candidate examined
      // — evidence-bar drop, repeat drop, or kept — persists as one row.
      let replicateBusinesses = []
      let replicateEvidenceTrail = []
      try {
        const evidenceKept = parseReplicateBusinesses(researchText)
        const evidenceAnnotated = takeReplicateFindings()
        const { kept: freshReplicate, dropped: repeatDropped } = filterUnseenReplicate(evidenceKept, seenReplicate)
        for (const d of repeatDropped) {
          console.log(`[opportunity-scanner-worker-background] replicate entry dropped as repeat — "${d.name}" (${d.reason})`)
        }
        const repeatReasonByName = new Map(repeatDropped.map((d) => [d.name, d.reason]))
        replicateEvidenceTrail = evidenceAnnotated.map((a) => (
          a.kept && repeatReasonByName.has(a.name)
            ? { ...a, kept: false, drop_reasons: [repeatReasonByName.get(a.name)] }
            : a
        ))
        replicateBusinesses = freshReplicate
        console.log(`[opportunity-scanner-worker-background] ${replicateBusinesses.length} businesses to replicate surfaced (${repeatDropped.length} dropped as repeats)`)
      } catch (e) {
        console.error('[opportunity-scanner-worker-background] could not parse Businesses to Replicate section:', String(e?.message ?? e))
      }

      const subject = `Daily opportunity scan — ${dateStr}`
      if (opportunities.length === 0 && replicateBusinesses.length === 0) {
        // Not an error, but worth telling Adrian the scan ran and found nothing.
        await sendEmail(resendKey, fromEmail, toEmail, subject,
          failureEmail('The research completed but surfaced no opportunities or businesses to replicate worth sending.', dateStr))
        const runId = await logRun(0, true, null)
        if (runId) await persistReplicateFindings(admin, runId, replicateEvidenceTrail)
        console.log('[opportunity-scanner-worker-background] section A: nothing today, notice sent, run logged')
        return json(200, { ok: true, section, opportunitiesFound: 0, emailSent: true })
      }

      const html = buildEmail(opportunities, prettyDate, replicateBusinesses)
      await sendEmail(resendKey, fromEmail, toEmail, subject, html)

      const runId = await logRun(opportunities.length, true, null)
      if (runId) await persistReplicateFindings(admin, runId, replicateEvidenceTrail)
      // Recorded only AFTER the send has actually succeeded — same rule
      // legislation follows (see recordSeenItems) — so a business is never
      // permanently excluded without Adrian actually having received it.
      if (replicateBusinesses.length) {
        const { recorded } = await recordSeenItems(admin, SEEN_SECTION_REPLICATE, replicateBusinesses.map((b) => ({ title: b.name })))
        console.log(`[opportunity-scanner-worker-background] recorded ${recorded} replicate business(es) as sent`)
      }
      console.log('[opportunity-scanner-worker-background] section A: email sent, run logged')
      return json(200, { ok: true, section, opportunitiesFound: opportunities.length, emailSent: true })
    }

    // section === 'B'
    let prospects = []
    try {
      prospects = parseProspects(researchText)
      console.log(`[opportunity-scanner-worker-background] ${prospects.length} YCA prospects surfaced`)
    } catch (e) {
      console.error('[opportunity-scanner-worker-background] could not parse UK Companies House Intelligence section:', String(e?.message ?? e))
    }

    // Inserted straight into the outreach platform's own table (see
    // buildProspectsLegislationEmail for what's shown in the email itself).
    // Best-effort: a failure here must never affect the email or the run log.
    if (admin && prospects.length) {
      try {
        const { inserted, skipped } = await insertProspects(admin, prospects)
        console.log(`[opportunity-scanner-worker-background] outreach_prospects: ${inserted} inserted, ${skipped} skipped as duplicates`)
      } catch (e) {
        console.error('[opportunity-scanner-worker-background] outreach_prospects insertion failed:', String(e?.message ?? e))
      }
    }

    // Regulatory-driven scored opportunities — Section B's ```json block.
    // Best-effort like every other parse here: nothing else in this run
    // depends on it.
    let regulatoryOpportunities = []
    try {
      regulatoryOpportunities = parseOpportunities(researchText)
      console.log(`[opportunity-scanner-worker-background] ${regulatoryOpportunities.length} regulatory-driven opportunit(ies) surfaced`)
    } catch (e) {
      console.error('[opportunity-scanner-worker-background] could not parse regulatory-driven opportunities:', String(e?.message ?? e))
    }

    // Best-effort, same pattern as prospects above — a failure to parse the
    // "UK Legislation and Regulatory Intelligence" section must never affect
    // the prospects section.
    let legislationItems = []
    try {
      legislationItems = parseLegislation(researchText)
      console.log(`[opportunity-scanner-worker-background] ${legislationItems.length} legislation items surfaced`)
    } catch (e) {
      console.error('[opportunity-scanner-worker-background] could not parse UK Legislation and Regulatory Intelligence section:', String(e?.message ?? e))
    }

    // The authoritative repeat-prevention filter. Applied to parsed output,
    // so it holds whether or not the model honoured the exclusion list it was
    // given — the prompt injection is an optimisation, this is the guarantee.
    const { kept: freshLegislation, dropped: repeatLegislation } =
      filterUnseenLegislation(legislationItems, seenLegislation)
    for (const d of repeatLegislation) {
      console.log(`[opportunity-scanner-worker-background] legislation dropped as repeat — "${d.title}" (${d.reason})`)
    }
    console.log(`[opportunity-scanner-worker-background] legislation: ${freshLegislation.length} new, ${repeatLegislation.length} dropped as repeats`)

    const subject = `YCA prospects + legislation — ${dateStr}`
    const html = buildProspectsLegislationEmail(prospects, freshLegislation, prettyDate, { regulatoryOpportunities })
    await sendEmail(resendKey, fromEmail, toEmail, subject, html)

    // Recorded only AFTER the send has succeeded. If sendEmail throws, this
    // never runs and these items stay eligible for tomorrow — the alternative
    // (recording first) would permanently suppress items that were never
    // actually delivered, which is the one failure here that can't be undone.
    const { recorded } = await recordSeenItems(admin, SEEN_SECTION_LEGISLATION, freshLegislation)
    console.log(`[opportunity-scanner-worker-background] recorded ${recorded} legislation item(s) as sent`)

    await logRun(prospects.length + freshLegislation.length + regulatoryOpportunities.length, true, null)
    console.log('[opportunity-scanner-worker-background] section B: email sent, run logged')
    return json(200, {
      ok: true, section,
      prospectsFound: prospects.length,
      legislationFound: freshLegislation.length,
      legislationDroppedAsRepeat: repeatLegislation.length,
      regulatoryOpportunitiesFound: regulatoryOpportunities.length,
      emailSent: true,
    })
  } catch (e) {
    const errMsg = String(e?.message ?? e)
    console.error('[opportunity-scanner-worker-background] run failed:', errMsg)

    const isTimeout = e instanceof ResearchTimeoutError
    const prettyDate = ukPrettyDate()
    let emailSent = false
    let itemsFound = 0
    let loggedError = errMsg
    // Hoisted out of the section==='A' branch below so the single shared
    // logRun() call at the foot of this catch can persist it regardless of
    // which branch ran — mirrors seenLegislation/seenReplicate being hoisted
    // above the try block for the same reason.
    let replicateEvidenceTrail = []

    // Partial-results recovery — only possible for a genuine research
    // timeout, since that's the only error carrying whatever text had
    // streamed in before the abort (see fetchResearchText/
    // ResearchTimeoutError). Runs the SAME parsers the normal path uses;
    // each is independently best-effort (an unclosed/partial fenced block
    // simply fails to parse and is treated as "not recovered", same pattern
    // already used for replicateBusinesses/prospects/legislation) so this
    // can only ever recover genuinely complete sections, never fabricate
    // one from a truncated response.
    if (isTimeout && e.partialText) {
      try {
        if (section === 'A') {
          let opportunities = []
          let replicateBusinesses = []
          try { opportunities = parseOpportunities(e.partialText) } catch { /* not recovered */ }
          try {
            // Same two-filter sequence as the normal path — a partial run
            // must not become a loophole that resends an already-surfaced
            // replicate business.
            const evidenceKept = parseReplicateBusinesses(e.partialText)
            const evidenceAnnotated = takeReplicateFindings()
            const { kept: freshReplicate, dropped: repeatDropped } = filterUnseenReplicate(evidenceKept, seenReplicate)
            const repeatReasonByName = new Map(repeatDropped.map((d) => [d.name, d.reason]))
            replicateEvidenceTrail = evidenceAnnotated.map((a) => (
              a.kept && repeatReasonByName.has(a.name)
                ? { ...a, kept: false, drop_reasons: [repeatReasonByName.get(a.name)] }
                : a
            ))
            replicateBusinesses = freshReplicate
            if (repeatDropped.length) {
              console.log(`[opportunity-scanner-worker-background] partial-recovery dropped ${repeatDropped.length} replicate business(es) as repeats`)
            }
          } catch { /* not recovered */ }
          if (opportunities.length || replicateBusinesses.length) {
            const html = buildEmail(opportunities, prettyDate, replicateBusinesses, { partial: true, elapsedMs: e.elapsedMs })
            if (resendKey) {
              await sendEmail(resendKey, fromEmail, toEmail, `Opportunity scan (partial — cut off after ${Math.round(e.elapsedMs / 1000)}s) — ${dateStr}`, html)
              emailSent = true
            }
            // Again, only after a successful send.
            if (emailSent && replicateBusinesses.length) {
              const { recorded } = await recordSeenItems(admin, SEEN_SECTION_REPLICATE, replicateBusinesses.map((b) => ({ title: b.name })))
              console.log(`[opportunity-scanner-worker-background] partial-recovery recorded ${recorded} replicate business(es) as sent`)
            }
            itemsFound = opportunities.length
            loggedError = `partial: aborted after ${Math.round(e.elapsedMs / 1000)}s during research — recovered ${opportunities.length} opportunity(ies), ${replicateBusinesses.length} business(es) to replicate`
          }
        } else {
          let prospects = []
          let legislationItems = []
          let regulatoryOpportunities = []
          try { prospects = parseProspects(e.partialText) } catch { /* not recovered */ }
          try { legislationItems = parseLegislation(e.partialText) } catch { /* not recovered */ }
          try { regulatoryOpportunities = parseOpportunities(e.partialText) } catch { /* not recovered */ }
          if (admin && prospects.length) {
            try { await insertProspects(admin, prospects) } catch (insErr) {
              console.error('[opportunity-scanner-worker-background] partial-recovery outreach_prospects insertion failed:', String(insErr?.message ?? insErr))
            }
          }
          // Same authoritative filter as the normal path — a partial run must
          // not become a loophole that resends already-reported legislation.
          const { kept: freshLegislation, dropped: repeatLegislation } =
            filterUnseenLegislation(legislationItems, seenLegislation)
          if (repeatLegislation.length) {
            console.log(`[opportunity-scanner-worker-background] partial-recovery dropped ${repeatLegislation.length} legislation item(s) as repeats`)
          }
          if (prospects.length || freshLegislation.length || regulatoryOpportunities.length) {
            const html = buildProspectsLegislationEmail(prospects, freshLegislation, prettyDate, { partial: true, elapsedMs: e.elapsedMs, regulatoryOpportunities })
            if (resendKey) {
              await sendEmail(resendKey, fromEmail, toEmail, `YCA prospects + legislation (partial — cut off after ${Math.round(e.elapsedMs / 1000)}s) — ${dateStr}`, html)
              emailSent = true
            }
            // Again, only after a successful send — and only if one actually
            // happened, which on this path depends on resendKey being set.
            if (emailSent) {
              const { recorded } = await recordSeenItems(admin, SEEN_SECTION_LEGISLATION, freshLegislation)
              console.log(`[opportunity-scanner-worker-background] partial-recovery recorded ${recorded} legislation item(s) as sent`)
            }
            itemsFound = prospects.length + freshLegislation.length + regulatoryOpportunities.length
            loggedError = `partial: aborted after ${Math.round(e.elapsedMs / 1000)}s during research — recovered ${prospects.length} prospect(s), ${freshLegislation.length} new legislation item(s) (${repeatLegislation.length} dropped as repeats), ${regulatoryOpportunities.length} regulatory opportunit(ies)`
          }
        }
      } catch (recoveryErr) {
        console.error('[opportunity-scanner-worker-background] partial-results recovery itself failed:', String(recoveryErr?.message ?? recoveryErr))
      }
    }

    // Either not a timeout, or a timeout with nothing recoverable in
    // e.partialText (e.g. aborted before the model produced any text at
    // all) — fall back to the existing failure/timeout notification. The
    // timeout email is now specific about elapsed time and which section
    // was running (see timeoutEmail) rather than a bare "it was slow".
    if (!emailSent && resendKey) {
      try {
        await sendEmail(resendKey, fromEmail, toEmail,
          isTimeout ? `Opportunity scan — will retry tomorrow — ${dateStr}` : `Opportunity scanner failed — ${dateStr}`,
          isTimeout ? timeoutEmail(dateStr, section, e.elapsedMs) : failureEmail(errMsg, dateStr))
        emailSent = true
      } catch (notifyErr) {
        console.error('[opportunity-scanner-worker-background] failure email also failed:', String(notifyErr?.message ?? notifyErr))
      }
    }
    const runId = await logRun(itemsFound, emailSent, loggedError)
    if (runId && replicateEvidenceTrail.length) await persistReplicateFindings(admin, runId, replicateEvidenceTrail)
    return json(500, { ok: false, error: errMsg, emailSent, partialRecovered: itemsFound > 0 })
  }
}
