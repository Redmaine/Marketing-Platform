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

This section has exactly TWO valid shapes. Every entry must fit cleanly into one of them. If a finding fits neither — or you have to stretch it to make it fit — drop it. There is no third category, and "interesting business" is not a category.

CATEGORY A — a foreign business with proven demand and no UK equivalent
A real, named, currently-trading business operating in another market (US, Australia, Canada, elsewhere) with hard evidence of traction, AND no meaningful UK-native equivalent serving the same need.
The UK-competitor check is a gate you run BEFORE deciding to include it, not a sentence you write afterwards to justify a decision you already made. Search explicitly for UK players in that exact space: the obvious UK brand names, "UK alternative to [name]", the category plus "UK". If the space is already served in the UK by anyone credible, DROP the entry. Do not include it anyway with a note acknowledging some UK competition exists — that is precisely the failure this section keeps producing.

CATEGORY B — a UK business with proven demand and a specific, defensible edge
A real, named, currently-trading UK business with hard evidence of demand, where you can state a SPECIFIC, evidenced edge over what already exists: cheaper (name the actual price gap), faster (name what's slow about the alternative), or better (name the specific missing or weak feature).
A crowded market is not a reason to drop this. Adrian does not require an empty space — good, well-reviewed competitors existing is fine and expected. What is NOT fine is an edge that can't survive contact with those competitors: "their product could be better", "the UX is dated", "no AI integration", "more modern", "more UK-focused" are not edges, they are the absence of one. A real edge is stated specifically enough that a competitor could be shown it and would have to concede the point — a named price, a named missing feature, a named speed difference — not a vibe. If the best you can manage after finding the real competitors is that the whole space feels a bit tired, drop it.

HARD REQUIREMENTS FOR BOTH CATEGORIES
- A named, real, currently-operating business with a working URL you found via search. Never a category, never a whole market — "CV builders are weak" is not a finding — and never a hypothetical.
- Evidence for the demand claim, cited. State the actual metric and where it came from: monthly traffic estimate, review count, funding raised, app-store rating with volume, published or reported revenue. Asserting something is "clearly popular" with nothing behind it does not qualify.
- A competitor check that searches the SOLUTION, not just the subject. Before naming any specific competitor to rule in or out, search broadly for what the finding actually proposes solving or building — the problem category itself ("UK allergen labelling software", "UK recipe costing app", "UK CV builder"), not just obvious rivals of the one business you already have in mind. Naming two or three competitors you already knew about and moving on is a spot-check, not a search, and it is exactly how this scanner has missed real matches before (see the worked rejection below). Only once that broader search is done do you name specific competitors, engage with the closest matches directly, and decide whether the gap or the edge survives.
- ONE IDEA, ONE ENTRY. If two candidate entries would lead to building the same underlying product, they are one finding aimed at two different incumbents. Keep the strongest and drop the other. Never use near-identical competitors to pad towards a quota.

DO THE WORK BEFORE YOU JUDGE
These gates are a filter applied to real research, not a reason to skip the research. Run the discovery searches, find candidate businesses, and run the competitor checks on them. Only then apply the gates. Concluding "nothing qualifies" without having searched is not a strict answer, it is an empty one — and it is just as useless to Adrian as the padded list it replaced. Expect to examine several candidates and discard most of them.

One rigorously evidenced entry beats three thin ones, and an honest empty section beats a padded list. But an empty section arrived at without searching is a failure, not a high standard.`

// Section A — scored opportunities + businesses to replicate. Runs on odd
// UTC days of the month. Everything below is Section A's own instructions
// only — the prospects/legislation instructions live in RESEARCH_USER_B.
const RESEARCH_USER_A = `Your job today is to find SPECIFIC NAMED BUSINESSES making money right now — not categories, not trends, not archetypes. Every opportunity and every business to replicate must be a real named company or seller with a real URL that you have searched for and verified exists.

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

US and Australian businesses are acceptable for the Businesses to Replicate section only if no strong UK equivalent exists. Always prefer a real UK business over a generic US example.

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

Apply the two-category rule from your instructions. Every entry is either Category A (foreign, proven demand, no UK equivalent) or Category B (UK, proven demand, a specific evidenced edge). Anything fitting neither is dropped, not softened into one of them.

WORKED REJECTIONS — real output from this scanner that should never have shipped. Do not reproduce these, or anything shaped like them:
- "CVwizard" and "Kickresume" — rejected twice over. First, the claim that no UK-specific CV builder exists is simply false: StandOut CV, ApplyArc and Reed's own CV builder all operate in the UK today, so the Category A gap does not survive a competitor check. Second, the two entries are the same underlying idea — an AI CV builder — aimed at two different incumbents, which is exactly the padding the one-idea-one-entry rule forbids.
- "LawDepot UK" — rejected because the competitor check was never really run. Rocket Lawyer UK has traded in the UK since 2012 with real traction. Any finding that treats UK online legal documents as an open space has not searched the space at all.
- "Meez" — the failure this section's search rule exists to stop. The entry proposed allergen-compliant labelling generated from recipe data as a novel UK angle, and its competitor check named Jelly, RecipeCostCalculator.net and Ratatool, ruled all three out, and declared the gap survived. FoodCore, MenuIQ and MenuSano all already do exactly that, all UK-built and UK-priced, and none of the three was even looked at. The check never failed on judgement — it failed because it only ever spot-checked competitors of the named business instead of searching for the SOLUTION ("UK allergen labelling software", "generate allergen labels from recipes UK"), which would have returned all three immediately.

The lesson across all three is the same: the competitor check IS the work, not a formality to complete after choosing. Search the solution category first, engage with whatever the real search turns up, and let it kill entries.

Still applies to every entry here: all three buildability tests from your instructions, the exclusion list above, and Adrian's existing portfolio spaces above. A business that is clearly profitable but needs premises, licensing, headcount or a sales team to replicate must be DROPPED.

For each entry return:
- category: exactly "A" or "B"
- idea_key: short kebab-case slug naming the UNDERLYING product idea, not the company — e.g. "ai-cv-builder", "uk-will-writing", "trade-invoice-app". Two entries may never share one.
- name: actual business name
- url: real URL verified via search today
- what_they_sell: what it is, and the actual price point
- demand_evidence: {"metric":"what you measured — monthly visits / review count / funding raised / app rating and volume / reported revenue","value":"the actual figure","source":"where it came from, with URL"}
- competitor_check: {"solution_searches":["the broad searches you ran for the SOLUTION category itself, before naming anyone — e.g. \\"UK allergen labelling software\\", \\"UK recipe costing app\\""],"searched":["every other search you ran, including the named-competitor ones"],"found":[{"name":"...","url":"...","why_not_equivalent":"..."}],"gap_survives":true|false,"reasoning":"..."}
    solution_searches must be genuinely about the thing being built, not about the named business or its obvious rivals, and it must come FIRST. found must include whatever those searches actually returned — including close matches, especially close matches. Ruling out three names you already had in mind is not a competitor check.
    Category A: gap_survives MUST be true. If a credible UK equivalent exists, drop the entry rather than output it with gap_survives false.
    Category B: gap_survives may be false — a crowded market is fine. What is recorded here is who genuinely serves these customers, found by real search, so the edge below can be stated against them rather than against a straw man.
- edge: CATEGORY B ONLY — {"type":"cheaper" | "faster" | "better","what":"the edge in one specific, checkable sentence","evidence":"the real price, the real complaint, the real missing feature, and where you saw it","versus":"the closest real competitors this edge is claimed against, by name — the ones your solution_searches actually surfaced, not weaker ones you picked because they are easier to beat"}. Omit entirely for Category A.
    "cheaper" must name the actual price gap. "faster" must name what is slow about the alternative. "better" must name the specific missing or weak feature. "more modern", "more UK-focused", "better UX" and "AI-powered" are not edges and will be rejected. If, once the real competitors are on the table, you cannot state an edge that survives being shown to them, drop the entry — that is the correct outcome, not a failure of the run.
- buildability: {"redmaine_can_build":"...","quill_can_market":"...","one_percent_better":"..."}
- effort: "Low", "Medium", or "High"
- verdict: "CLONE IT", "WORTH STUDYING", or "LEAVE IT"

Before concluding this section, you must have actually searched: run the solution-category searches first, then name at least the candidate businesses you considered and rejected, in competitor_check.found or in your working, so it is visible that the search happened. An empty section with no evidence of searching is a failed run, not a strict one.

Output as a second JSON array in a \`\`\`replicate fenced block. Maximum 3 entries — a ceiling, not a target. Aim to surface the one or two strongest that genuinely clear the bar.

---

REPEAT PREVENTION
Before finalising output, check every business name against the exclusion list. If any match — exactly or approximately — remove and replace. Never output the same named business twice across consecutive emails.`

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

// userPrompt is a builder rather than a string: Section B's prompt now embeds
// the live already-sent legislation exclusion list (see buildResearchUserB),
// so it can only be assembled once that list has been read from the database.
// Section A's builder ignores its argument — its exclusion list is still the
// hardcoded one in RESEARCH_USER_A (see the note in the handler).
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
  A: { buildUserPrompt: () => RESEARCH_USER_A, maxTokens: 12000, maxUses: 16 },
  B: { buildUserPrompt: buildResearchUserB, maxTokens: 12000, maxUses: 10 },
}

// ── Repeat prevention ───────────────────────────────────────────────────────
// Backed by opportunity_scanner_seen_items (migration 100). See that
// migration's header for why this had to be built from scratch rather than
// extended: there was no exclusion table anywhere in this codebase.

const SEEN_SECTION_LEGISLATION = 'legislation'
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

// Streams the response instead of waiting for one final JSON blob, purely
// so that IF the abort fires, whatever text the model had already produced
// is still in `accumulated` and can be handed to the caller (via
// ResearchTimeoutError.partialText) for a best-effort partial-results
// parse — see the handler's catch block. On a normal, unaborted run this
// returns exactly the same concatenated text the old non-streaming version
// did, just assembled incrementally instead of read from one response body.
export async function fetchResearchText(anthropicKey, userPrompt, maxTokens, maxUses) {
  const controller = new AbortController()
  const startedAt = Date.now()
  const timeoutId = setTimeout(() => controller.abort(), RESEARCH_TIMEOUT_MS)

  let accumulated = ''
  let webSearches = 0
  let stopReason = null
  // Written even on the timeout/abort path, so a partial run still reports how
  // much searching it had done before it ran out of time.
  const publish = () => {
    lastResearchTelemetry = {
      research_ms: Date.now() - startedAt,
      research_chars: accumulated.length,
      web_searches: webSearches,
      stop_reason: stopReason,
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
        system: RESEARCH_SYSTEM,
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
  return accumulated
}

// Same take-once pattern as takeReplicateAudit — see its note on why this is
// module-level rather than threaded through the return value (fetchResearchText
// has a timeout/partial-recovery path that must keep its current shape).
let lastResearchTelemetry = { research_ms: null, research_chars: null, web_searches: null, stop_reason: null }
export function takeResearchTelemetry() {
  const t = lastResearchTelemetry
  lastResearchTelemetry = { research_ms: null, research_chars: null, web_searches: null, stop_reason: null }
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

// Why this exists as CODE and not only as prompt wording: the previous prompt
// already demanded real named businesses with real URLs and verifiable revenue
// evidence, and the scanner still shipped CVwizard, Kickresume and LawDepot UK
// — two of them the same idea aimed at different incumbents, all three with a
// competitor check that was never really run. Instructions alone demonstrably
// did not hold. These checks are structural: an entry that does not carry its
// own evidence cannot reach the email regardless of how convincing its prose is.
//
// Deliberately checks for the PRESENCE and SHAPE of evidence, never the truth
// of it — code cannot know whether Rocket Lawyer UK competes with LawDepot. It
// can know whether the model recorded searching, what it found, and whether it
// concluded the gap survived. That is the measure-then-judge split used for the
// image backstop: the model measures, fixed rules decide.
const EDGE_TYPES = new Set(['cheaper', 'faster', 'better'])

// The phrases that, on their own, mean an edge was never actually found — the
// vocabulary a finding reaches for when the honest answer is "it feels a bit
// tired". Deliberately matches only when the phrase IS essentially the whole
// claim, so "cheaper because FoodCore starts at £99/mo and this is £29" is not
// caught by "more modern" appearing later in the sentence.
const VAGUE_EDGE = /^(?:it(?:'s| is)\s+|a\s+|more\s+)?(?:more\s+)?(?:modern|modernised|up[- ]to[- ]date|uk[- ]focused|uk[- ]first|user[- ]friendly|intuitive|streamlined|simpler|slicker|cleaner|ai[- ]powered|ai[- ]driven|better\s+ux|better\s+ui|better\s+design|better\s+experience)\b[\s.!]*$/i

export function replicateRejectionReasons(o) {
  if (!o || typeof o !== 'object') return ['not an object']
  const reasons = []
  const cat = String(o.category ?? '').trim().toUpperCase()

  if (cat !== 'A' && cat !== 'B') reasons.push(`category must be "A" or "B", got ${JSON.stringify(o.category ?? null)}`)
  if (!isStr(o.name)) reasons.push('no business name')
  if (!isUrl(o.url)) reasons.push('no usable URL')
  if (!isStr(o.idea_key)) reasons.push('no idea_key — cannot enforce one-idea-one-entry without it')

  const d = o.demand_evidence
  if (!d || typeof d !== 'object') reasons.push('no demand_evidence — the "proven demand" claim is unsupported')
  else {
    if (!isStr(d.metric)) reasons.push('demand_evidence.metric missing')
    if (!isStr(d.value)) reasons.push('demand_evidence.value missing — no actual figure')
    if (!isStr(d.source)) reasons.push('demand_evidence.source missing — figure cited to nothing')
  }

  const c = o.competitor_check
  if (!c || typeof c !== 'object') reasons.push('no competitor_check')
  else {
    if (!Array.isArray(c.searched) || !c.searched.some(isStr)) {
      reasons.push('competitor_check.searched is empty — the check was not actually run')
    }
    // The Meez failure: a competitor check made entirely of named spot-checks
    // never searches the solution category, so the three real UK matches were
    // never seen at all. Code cannot tell a good search from a bad one, but it
    // can tell whether the broad search was recorded as having happened.
    if (!Array.isArray(c.solution_searches) || !c.solution_searches.some(isStr)) {
      reasons.push('competitor_check.solution_searches is empty — the solution category itself was never searched, only named competitors spot-checked')
    }
    if (!isStr(c.reasoning)) reasons.push('competitor_check.reasoning missing')
    // The LawDepot UK / CVwizard failure in one line: a Category A entry whose
    // own competitor check says the UK gap does not survive is self-refuting,
    // and must never be surfaced with the contradiction left as a caveat.
    if (cat === 'A' && c.gap_survives !== true) {
      reasons.push('Category A but the UK gap did not survive its own competitor check')
    }
  }

  // Category B's bar is no longer "the market is empty" — a crowded market is
  // fine. It is "the edge is specific enough to state against the real
  // competitors". So the code checks the shape that specificity has to take:
  // a named axis, a named piece of evidence, and named rivals it holds against.
  if (cat === 'B') {
    const e = o.edge
    if (!e || typeof e !== 'object') reasons.push('Category B with no edge — "could be better" is not a finding')
    else {
      const type = String(e.type ?? '').trim().toLowerCase()
      if (!EDGE_TYPES.has(type)) {
        reasons.push(`edge.type must be one of ${[...EDGE_TYPES].join('/')}, got ${JSON.stringify(e.type ?? null)}`)
      }
      if (!isStr(e.what)) reasons.push('edge.what missing')
      if (!isStr(e.evidence)) reasons.push('edge.evidence missing — the edge is asserted, not evidenced')
      if (!isStr(e.versus)) reasons.push('edge.versus missing — an edge stated against nobody in particular is not an edge')
      if (isStr(e.what) && VAGUE_EDGE.test(e.what)) {
        reasons.push(`edge.what is a vague claim, not a specific edge: "${e.what}"`)
      }
    }
  }

  return reasons
}

// Applies the per-entry rules above, then the two cross-entry rules that a
// single-entry check structurally cannot catch: one idea per email, and one
// business per email. CVwizard + Kickresume passed every per-entry test and
// were still wrong together, because they were one idea twice.
export function filterReplicateBusinesses(entries) {
  const kept = []
  const dropped = []
  const seenIdea = new Set()
  const seenName = new Set()

  for (const o of Array.isArray(entries) ? entries : []) {
    const reasons = replicateRejectionReasons(o)
    const ideaKey = String(o?.idea_key ?? '').trim().toLowerCase()
    const nameKey = String(o?.name ?? '').trim().toLowerCase()

    if (!reasons.length) {
      if (seenIdea.has(ideaKey)) reasons.push(`same underlying idea as an earlier entry ("${ideaKey}") — one idea, one entry`)
      else if (seenName.has(nameKey)) reasons.push(`duplicate business "${o.name}"`)
    }

    if (reasons.length) {
      dropped.push({ name: isStr(o?.name) ? o.name : '(unnamed)', reasons })
      continue
    }

    seenIdea.add(ideaKey)
    seenName.add(nameKey)
    kept.push(o)
  }

  // Truncation is recorded rather than silent — an over-quota entry was valid,
  // it just lost on ordering, and that reads very differently in a log from an
  // entry that failed the evidence bar.
  const overflow = kept.slice(REPLICATE_MAX)
  for (const o of overflow) dropped.push({ name: o.name, reasons: [`over the ${REPLICATE_MAX}-entry ceiling`] })

  return { kept: kept.slice(0, REPLICATE_MAX), dropped }
}

export function parseReplicateBusinesses(text) {
  // Cleared before any throw path below. Netlify reuses warm containers, so
  // without this a parse failure would leave the PREVIOUS invocation's audit
  // in place and the run log would attribute it to this run.
  lastReplicateAudit = { kept: 0, dropped: [] }

  let jsonStr = null
  const fenced = [...text.matchAll(/```replicate\s*([\s\S]*?)```/g)]
  if (fenced.length) jsonStr = fenced[fenced.length - 1][1].trim()
  if (!jsonStr) {
    // Recorded, not just thrown. An empty section has three quite different
    // causes — the model returned no block, it returned an empty array, or the
    // filter rejected everything — and they call for opposite responses
    // (the prompt is broken / the bar is too high / the bar is working).
    // Collapsing them all into "0" is what made the first live check ambiguous.
    lastReplicateAudit = { kept: 0, dropped: [{ name: '(none)', reasons: ['model returned no ```replicate block at all'] }] }
    throw new Error('No ```replicate block found in the model response')
  }

  const parsed = JSON.parse(jsonStr)
  if (!Array.isArray(parsed)) throw new Error('Businesses-to-replicate JSON was not an array')
  if (!parsed.length) {
    lastReplicateAudit = { kept: 0, dropped: [{ name: '(none)', reasons: ['model returned an empty replicate array — it found nothing it judged to qualify'] }] }
    return []
  }

  const { kept, dropped } = filterReplicateBusinesses(parsed)
  for (const d of dropped) {
    console.log(`[opportunity-scanner-worker-background] replicate entry dropped — ${d.name}: ${d.reasons.join('; ')}`)
  }
  if (parsed.length && !kept.length) {
    console.log(`[opportunity-scanner-worker-background] all ${parsed.length} replicate entr${parsed.length === 1 ? 'y' : 'ies'} failed the evidence bar — section will be omitted`)
  }
  // Handed to the run log so the outcome survives the request. Console output
  // from a background function is not reliably retrievable afterwards, and
  // "what did the filter refuse, and why" is the question worth being able to
  // answer about this section on any given day.
  lastReplicateAudit = { kept: kept.length, dropped }
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
  // Table, not flexbox — same fix as competitionReality() and prospectCard()
  // above, same bug: a flex:1 title next to a white-space:nowrap badge can
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

// Category chip — states which of the two shapes this entry is, so the claim
// being made is legible before reading the detail. A is "nobody serves this in
// the UK"; B is "somebody does, and here is the one thing they get wrong".
function categoryChipReplicate(cat) {
  const c = String(cat || '').trim().toUpperCase()
  const style = c === 'A'
    ? { bg: '#e0f2fe', fg: '#075985', label: 'A · Not in the UK yet' }
    : { bg: '#f3e8ff', fg: '#6b21a8', label: 'B · UK, one fixable weakness' }
  return `<span style="display:inline-block;background:${style.bg};color:${style.fg};font-weight:700;font-size:11px;padding:3px 9px;border-radius:4px;font-family:sans-serif;white-space:nowrap">${esc(style.label)}</span>`
}

function replicateCard(o, i) {
  const titleHtml = o.url
    ? `<a href="${esc(o.url)}" style="color:#111827;text-decoration:none">${esc(o.name)}</a>`
    : esc(o.name)

  // Demand evidence is rendered as figure-then-source rather than prose, so a
  // claim with nothing behind it would look conspicuously empty instead of
  // reading as confident copy. That asymmetry is the point.
  const d = o.demand_evidence
  const demandHtml = d && typeof d === 'object'
    ? field('Evidence of demand', `${d.value ?? ''} — ${d.metric ?? ''} (${d.source ?? 'no source given'})`)
    : ''

  const e = o.edge
  const edgeHtml = e && typeof e === 'object'
    ? field(`The edge — ${String(e.type ?? '').toLowerCase()}`, `${e.what ?? ''} — ${e.evidence ?? ''}`) + field('Held against', e.versus ?? '')
    : ''

  const c = o.competitor_check
  const rivals = c && Array.isArray(c.found) && c.found.length
    ? c.found.map((f) => f?.name).filter(Boolean).join(', ')
    : 'none found'
  // The solution-category searches are surfaced in the email, not just recorded
  // in the JSON, so a check made of nothing but named spot-checks is visible on
  // the page rather than only inside a field nobody reads.
  const solutionSearches = c && Array.isArray(c.solution_searches)
    ? c.solution_searches.filter((s) => typeof s === 'string' && s.trim()).join('; ')
    : ''
  const competitorHtml = c && typeof c === 'object'
    ? field('Competitor check', `${c.reasoning ?? ''} (found: ${rivals})`) +
      (solutionSearches ? field('Searched the category for', solutionSearches) : '')
    : ''

  return `
  <div style="background:#ffffff;border:1px solid #e5e7eb;border-radius:10px;padding:24px;margin-bottom:20px">
    <div style="display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:4px;gap:12px">
      <div style="font-size:17px;font-weight:700;color:#111827;font-family:sans-serif;line-height:1.4;flex:1">${i + 1}. ${titleHtml}</div>
      ${verdictBadgeReplicate(String(o.verdict ?? ''))}
    </div>
    <div style="margin-bottom:10px">${categoryChipReplicate(o.category)}</div>
    ${o.url ? `<div style="font-size:12px;color:#6b7280;font-family:sans-serif;margin-bottom:12px;word-break:break-all">${esc(o.url)}</div>` : ''}
    ${field('What they sell', o.what_they_sell)}
    ${demandHtml}
    ${edgeHtml}
    ${competitorHtml}
    ${o.buildability?.one_percent_better ? field('Your angle', o.buildability.one_percent_better) : ''}
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

// ── YCA Prospects card — Section B's own card, distinct from replicateCard
// (different fields: trade/incorporated/signal/why_yca vs what_they_sell/
// vulnerability/how_to_beat_them/effort). Prospects are also inserted
// straight into outreach_prospects (see insertProspects) — this card is
// purely for visibility in the Section B email, not the only place they end
// up.
function prospectCard(o, i) {
  const titleHtml = o.website
    ? `<a href="${esc(o.website)}" style="color:#111827;text-decoration:none">${esc(o.name)}</a>`
    : esc(o.name)
  const titleCell = `<div style="font-size:17px;font-weight:700;color:#111827;font-family:sans-serif;line-height:1.4">${i + 1}. ${titleHtml}</div>`
  // Table, not flexbox — same fix as competitionReality() above, same bug.
  // display:flex has no support in Outlook and is inconsistent across mobile
  // mail clients; a flex:1 title next to a white-space:nowrap badge can get
  // squeezed to a razor-thin width there, and once a client can't fit even
  // one word it falls back to breaking between every character — the
  // reported vertical, one-letter-per-line rendering. width="1" on the badge
  // <td> gives that column only the minimum width its non-wrapping content
  // needs and lets the title column take the rest, with no way to be
  // squeezed. Only wrapped in the table when a badge actually exists (o.trade)
  // — the title alone has no sibling to be squeezed by.
  const header = o.trade
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin-bottom:4px">
      <tr>
        <td style="vertical-align:top">${titleCell}</td>
        <td width="1" style="vertical-align:top;padding-left:12px;white-space:nowrap"><span style="display:inline-block;background:#f3f4f6;color:#6b7280;font-weight:700;font-size:12px;padding:3px 10px;border-radius:4px;font-family:sans-serif;white-space:nowrap">${esc(o.trade)}</span></td>
      </tr>
    </table>`
    : `<div style="margin-bottom:4px">${titleCell}</div>`
  return `
  <div style="background:#ffffff;border:1px solid #e5e7eb;border-radius:10px;padding:24px;margin-bottom:20px">
    ${header}
    ${o.website ? `<div style="font-size:12px;color:#6b7280;font-family:sans-serif;margin-bottom:12px;word-break:break-all">${esc(o.website)}</div>` : ''}
    ${field('Incorporated', o.incorporated)}
    ${field('Signal', o.signal)}
    ${field('Why YCA', o.why_yca)}
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
function buildProspectsLegislationEmail(prospects, legislationItems, dateStr, opts = {}) {
  const banner = opts.partial ? partialResultsBanner('B', opts.elapsedMs) : ''
  const regulatoryOpportunities = opts.regulatoryOpportunities ?? []
  const prospectsSection = prospects.length
    ? `
  <div style="margin-bottom:20px">
    <div style="font-size:20px;font-weight:700;color:#111827;font-family:sans-serif;margin-bottom:4px">YCA Prospects</div>
    <div style="font-size:13px;color:#6b7280;font-family:sans-serif;margin-bottom:20px">${prospects.length} recently started UK trade business${prospects.length === 1 ? '' : 'es'} with no software in place — also added to the outreach pipeline</div>
    ${prospects.map(prospectCard).join('')}
  </div>`
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
    <div style="font-size:13px;color:#6b7280;font-family:sans-serif;margin-bottom:20px">${replicateBusinesses.length} named business${replicateBusinesses.length === 1 ? '' : 'es'} that survived a competitor check &mdash; each either absent from the UK, or here with one specific fixable weakness</div>
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

  const logRun = async (itemsFound, emailSent, error) => {
    if (!admin) return
    // Replicate outcome recorded alongside the opportunity count so the two
    // are distinguishable after the fact — see the migration note on these
    // columns for why a bare opportunities_found of 0 was ambiguous.
    const audit = takeReplicateAudit()
    // Research telemetry, so "searched hard and found nothing" is
    // distinguishable from "declined without searching" on any given day
    // WITHOUT having to fire synthetic runs to find out. web_searches is the
    // one that actually settles it.
    const t = takeResearchTelemetry()
    const { error: logErr } = await admin.from('opportunity_scanner_runs')
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
      })
    if (logErr) console.error('[opportunity-scanner-worker-background] failed to write run log:', logErr.message)
  }

  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY

  // Same warm-container concern as in parseReplicateBusinesses, from the other
  // direction: Section B never parses a replicate block, so on a reused
  // container its run log would otherwise inherit Section A's audit.
  takeReplicateAudit()

  const section = sectionForDate(new Date())

  // Hoisted out of the try block so the partial-results recovery path in the
  // catch can apply the same repeat filter. A partial run still sends a real
  // email, so it must not be allowed to resend items the reader has already
  // had — the timeout is not a reason to drop the guarantee.
  let seenLegislation = []

  try {
    if (!admin) throw new Error('SUPABASE_URL / SUPABASE_SERVICE_KEY not configured')
    if (!ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY not configured')
    if (!resendKey) throw new Error('RESEND_API_KEY not configured')

    const config = SECTION_CONFIG[section]
    console.log(`[opportunity-scanner-worker-background] starting run ${dateStr} — section ${section}`)

    // Already-sent legislation, loaded BEFORE the research call so the titles
    // can be injected into Section B's prompt as an exclusion list. Section A
    // ignores this (its builder takes no argument) — its exclusion list is
    // still the hardcoded one inside RESEARCH_USER_A, which is a separate,
    // known limitation rather than something this fix changes.
    seenLegislation = section === 'B'
      ? await loadSeenItems(admin, SEEN_SECTION_LEGISLATION)
      : []
    if (section === 'B') {
      console.log(`[opportunity-scanner-worker-background] ${seenLegislation.length} previously-sent legislation item(s) will be excluded`)
    }
    const userPrompt = config.buildUserPrompt(
      seenLegislation.slice(0, SEEN_PROMPT_LIMIT).map((s) => s.title),
    )

    const researchText = await fetchResearchText(ANTHROPIC_API_KEY, userPrompt, config.maxTokens, config.maxUses)
    const prettyDate = ukPrettyDate()

    if (section === 'A') {
      const opportunities = parseOpportunities(researchText)
      console.log(`[opportunity-scanner-worker-background] ${opportunities.length} opportunities surfaced`)

      // Best-effort: a failure to parse the "Businesses to Replicate"
      // section must never affect the opportunity analysis or email.
      let replicateBusinesses = []
      try {
        replicateBusinesses = parseReplicateBusinesses(researchText)
        console.log(`[opportunity-scanner-worker-background] ${replicateBusinesses.length} businesses to replicate surfaced`)
      } catch (e) {
        console.error('[opportunity-scanner-worker-background] could not parse Businesses to Replicate section:', String(e?.message ?? e))
      }

      const subject = `Daily opportunity scan — ${dateStr}`
      if (opportunities.length === 0 && replicateBusinesses.length === 0) {
        // Not an error, but worth telling Adrian the scan ran and found nothing.
        await sendEmail(resendKey, fromEmail, toEmail, subject,
          failureEmail('The research completed but surfaced no opportunities or businesses to replicate worth sending.', dateStr))
        await logRun(0, true, null)
        console.log('[opportunity-scanner-worker-background] section A: nothing today, notice sent, run logged')
        return json(200, { ok: true, section, opportunitiesFound: 0, emailSent: true })
      }

      const html = buildEmail(opportunities, prettyDate, replicateBusinesses)
      await sendEmail(resendKey, fromEmail, toEmail, subject, html)

      await logRun(opportunities.length, true, null)
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
          try { replicateBusinesses = parseReplicateBusinesses(e.partialText) } catch { /* not recovered */ }
          if (opportunities.length || replicateBusinesses.length) {
            const html = buildEmail(opportunities, prettyDate, replicateBusinesses, { partial: true, elapsedMs: e.elapsedMs })
            if (resendKey) {
              await sendEmail(resendKey, fromEmail, toEmail, `Opportunity scan (partial — cut off after ${Math.round(e.elapsedMs / 1000)}s) — ${dateStr}`, html)
              emailSent = true
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
    await logRun(itemsFound, emailSent, loggedError)
    return json(500, { ok: false, error: errMsg, emailSent, partialRecovered: itemsFound > 0 })
  }
}
