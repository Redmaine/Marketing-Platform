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

Use web search to find 3–5 real, profitable online businesses that could be replicated and improved. Look for businesses that are:
- Clearly making money (high review counts, strong search presence, obvious demand)
- Charging a premium that leaves room to undercut
- Running on outdated technology, poor UX, or no AI integration
- Succeeding in the US, Australia or Canada but not yet dominant in the UK

For each business include:
- Business name and URL
- What they sell and rough price point
- Why they're vulnerable (overpriced, bad UX, no AI, no UK presence, weak branding)
- How to replicate and beat them: cheaper, faster, AI-enhanced, or better designed
- Effort to replicate: Low / Medium / High
- One-line verdict: CLONE IT / WORTH STUDYING / LEAVE IT`

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

Output ONLY a JSON array wrapped in a \`\`\`json fenced block. Only include opportunities where passes_threshold is true. Zero is fine if nothing qualifies.

---

BUSINESSES TO REPLICATE

Find 3-5 real named businesses making money that could be replicated and improved. Requirements:
- Real companies with real URLs found via search today
- Verifiable revenue evidence (reviews, rankings, community posts, estimated traffic)
- UK businesses strongly preferred — only use US/AU if no UK equivalent found
- Must not appear on the exclusion list above
- Must not overlap with Adrian's existing portfolio above

Search specifically for:
- UK businesses with outdated tech or no AI integration
- UK Etsy shops with 10,000+ reviews and no dominant brand
- UK apps with 3-4 star ratings and obvious gaps in reviews
- UK SaaS tools charging premium prices with weak competition

For each include:
- name: actual business name
- url: real URL found via search
- what_they_sell: what they sell and actual price point
- vulnerability: specific weakness found
- how_to_beat_them: concrete plan
- effort: "Low", "Medium", or "High"
- verdict: "CLONE IT", "WORTH STUDYING", or "LEAVE IT"

Output as a second JSON array in a \`\`\`replicate fenced block. Every business must be real, named, with a URL found via search.

---

REPEAT PREVENTION
Before finalising output, check every business name against the exclusion list. If any match — exactly or approximately — remove and replace. Never output the same named business twice across consecutive emails.`

// Section B — YCA prospects (Companies House intelligence) + UK legislation
// watch. Runs on even UTC days of the month. Its own intro, not reused from
// Section A — Section A's intro specifically talks about "opportunities"
// and "businesses to replicate", neither of which apply here. No exclusion
// list or repeat-prevention block: prospects are deduped in code
// (insertProspects' outreach_prospects lookup) and legislation items don't
// have an equivalent "already featured" concept in this codebase.
const RESEARCH_USER_B = `Your job today is to find SPECIFIC NAMED UK TRADE BUSINESSES with no proper business management software in place, and REAL UK LEGISLATION OR REGULATORY CHANGES that create new business opportunities — not categories, not vague trends. Every prospect and every legislative item must be real, found via search today, with a verifiable source.

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

For each relevant finding, identify:
- What the legislation or regulation requires
- When it comes into force
- Which businesses are affected
- What product or service gap it creates
- Whether YCA, Quill, or PS could address it specifically

Output as a second JSON array in a \`\`\`legislation fenced block:
[{"title":"...","summary":"...","in_force":"...","affects":"...","opportunity":"...","relevant_brand":"YCA|Quill|PS|All"}]

Return 2-5 items. Only include genuine confirmed legislation or consultations found via search — never invent regulatory changes. If nothing relevant is found today, return an empty array.`

// ── Anthropic (with server-side web_search tool) ────────────────────────────
// max_tokens/max_uses history from the Deno version this was ported from:
// raised 8000 -> 12000 -> 14000 / 8 -> 12 -> 16 as sections were added to a
// single combined prompt, then split into these two alternating sections at
// 8000/8 each when the combined prompt started reliably timing out at 150s
// even after earlier cuts. That 150s ceiling was Supabase Edge Functions'
// own execution budget — this Netlify background function has 15 minutes
// instead, so the same split/budget is kept here for the actual research
// quality it was tuned for, not because 8000/8 is still a hard ceiling.
const RESEARCH_TIMEOUT_MS = 120_000

class ResearchTimeoutError extends Error {
  constructor() {
    super(`Research call did not complete within ${RESEARCH_TIMEOUT_MS / 1000}s and was aborted`)
    this.name = 'ResearchTimeoutError'
  }
}

// Odd day-of-month -> Section A, even -> Section B. UTC to match dateStr
// elsewhere in this file, not the server's local time.
function sectionForDate(now) {
  return now.getUTCDate() % 2 === 1 ? 'A' : 'B'
}

const SECTION_CONFIG = {
  A: { userPrompt: RESEARCH_USER_A, maxTokens: 8000, maxUses: 8 },
  B: { userPrompt: RESEARCH_USER_B, maxTokens: 8000, maxUses: 8 },
}

async function fetchResearchText(anthropicKey, userPrompt, maxTokens, maxUses) {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), RESEARCH_TIMEOUT_MS)

  let res
  try {
    res = await fetch('https://api.anthropic.com/v1/messages', {
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
      }),
      signal: controller.signal,
    })
  } catch (e) {
    // AbortController.abort() makes fetch reject with a DOMException/Error
    // named 'AbortError' in Node's fetch (undici) same as in a browser —
    // that's the one and only way this catch's abort branch fires, so it's
    // safe to treat any AbortError here as our own timeout (nothing else in
    // this function aborts the signal).
    if (e?.name === 'AbortError') throw new ResearchTimeoutError()
    throw e
  } finally {
    clearTimeout(timeoutId)
  }

  const data = await res.json()
  if (!res.ok) {
    throw new Error(`Anthropic API ${res.status}: ${JSON.stringify(data).slice(0, 500)}`)
  }

  // With web_search the response is a mix of text / server_tool_use /
  // web_search_tool_result blocks. Concatenate every text block — the final
  // answer (our JSON) lives in text.
  return (Array.isArray(data.content) ? data.content : [])
    .filter((b) => b.type === 'text')
    .map((b) => String(b.text ?? ''))
    .join('\n')
}

function parseOpportunities(text) {
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
function parseReplicateBusinesses(text) {
  let jsonStr = null
  const fenced = [...text.matchAll(/```replicate\s*([\s\S]*?)```/g)]
  if (fenced.length) jsonStr = fenced[fenced.length - 1][1].trim()
  if (!jsonStr) throw new Error('No ```replicate block found in the model response')

  const parsed = JSON.parse(jsonStr)
  if (!Array.isArray(parsed)) throw new Error('Businesses-to-replicate JSON was not an array')
  return parsed.slice(0, 5)
}

// Parses the "UK COMPANIES HOUSE INTELLIGENCE" section — a distinctly fenced
// ```prospects block (never ```json or ```replicate, so it can never
// accidentally match either of those). Independent of the other two parses,
// same pattern as parseReplicateBusinesses, so a failure here can be handled
// without affecting the opportunity analysis or the replicate-businesses
// section at all.
function parseProspects(text) {
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
function parseLegislation(text) {
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
  return `
  <div style="background:#ffffff;border:1px solid #e5e7eb;border-radius:10px;padding:24px;margin-bottom:20px">
    <div style="display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:14px;gap:12px">
      <div style="font-size:17px;font-weight:700;color:#111827;font-family:sans-serif;line-height:1.4;flex:1">${i + 1}. ${esc(o.name)}</div>
      ${verdictBadge(String(o.verdict ?? ''))}
    </div>
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

function replicateCard(o, i) {
  const titleHtml = o.url
    ? `<a href="${esc(o.url)}" style="color:#111827;text-decoration:none">${esc(o.name)}</a>`
    : esc(o.name)
  return `
  <div style="background:#ffffff;border:1px solid #e5e7eb;border-radius:10px;padding:24px;margin-bottom:20px">
    <div style="display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:4px;gap:12px">
      <div style="font-size:17px;font-weight:700;color:#111827;font-family:sans-serif;line-height:1.4;flex:1">${i + 1}. ${titleHtml}</div>
      ${verdictBadgeReplicate(String(o.verdict ?? ''))}
    </div>
    ${o.url ? `<div style="font-size:12px;color:#6b7280;font-family:sans-serif;margin-bottom:12px;word-break:break-all">${esc(o.url)}</div>` : ''}
    ${field('What they sell', o.what_they_sell)}
    ${field('Why they&rsquo;re vulnerable', o.vulnerability)}
    ${field('How to replicate &amp; beat them', o.how_to_beat_them)}
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
  return `
  <div style="background:#ffffff;border:1px solid #e5e7eb;border-radius:10px;padding:24px;margin-bottom:20px">
    <div style="display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:4px;gap:12px">
      <div style="font-size:17px;font-weight:700;color:#111827;font-family:sans-serif;line-height:1.4;flex:1">${i + 1}. ${titleHtml}</div>
      ${o.trade ? `<span style="display:inline-block;background:#f3f4f6;color:#6b7280;font-weight:700;font-size:12px;padding:3px 10px;border-radius:4px;font-family:sans-serif;white-space:nowrap">${esc(o.trade)}</span>` : ''}
    </div>
    ${o.website ? `<div style="font-size:12px;color:#6b7280;font-family:sans-serif;margin-bottom:12px;word-break:break-all">${esc(o.website)}</div>` : ''}
    ${field('Incorporated', o.incorporated)}
    ${field('Signal', o.signal)}
    ${field('Why YCA', o.why_yca)}
  </div>`
}

// ── Section B email — YCA prospects + UK legislation. Entirely separate from
// buildEmail (Section A's opportunities/replicate email); the two sections
// never share a run, so there's no case where both need rendering together.
// Renders an explicit "nothing today" line per subsection (rather than
// omitting it) so a quiet day still reads as "it ran and checked", matching
// the brief's "send an email with that day's findings" for every run.
function buildProspectsLegislationEmail(prospects, legislationItems, dateStr) {
  const prospectsSection = prospects.length
    ? `
  <div style="margin-bottom:20px">
    <div style="font-size:20px;font-weight:700;color:#111827;font-family:sans-serif;margin-bottom:4px">YCA Prospects</div>
    <div style="font-size:13px;color:#6b7280;font-family:sans-serif;margin-bottom:20px">${prospects.length} recently started UK trade business${prospects.length === 1 ? '' : 'es'} with no software in place — also added to the outreach pipeline</div>
    ${prospects.map(prospectCard).join('')}
  </div>`
    : `<div style="font-size:13px;color:#6b7280;font-family:sans-serif;margin-bottom:20px">No new YCA prospects found today.</div>`
  const legislationSection = legislationItems.length
    ? `
  <div style="margin-top:8px;margin-bottom:20px;padding-top:28px;border-top:2px solid #e5e7eb">
    <div style="font-size:20px;font-weight:700;color:#111827;font-family:sans-serif;margin-bottom:4px">UK Legislation Watch</div>
    <div style="font-size:13px;color:#6b7280;font-family:sans-serif;margin-bottom:20px">${legislationItems.length} regulatory change${legislationItems.length === 1 ? '' : 's'} worth acting on</div>
    ${legislationItems.map(legislationCard).join('')}
  </div>`
    : `<div style="margin-top:8px;padding-top:28px;border-top:2px solid #e5e7eb;font-size:13px;color:#6b7280;font-family:sans-serif;margin-bottom:20px">No relevant UK legislation found today.</div>`
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f3f4f6">
<div style="max-width:640px;margin:0 auto;padding:32px 16px">
  <div style="margin-bottom:28px">
    <div style="font-size:22px;font-weight:700;color:#111827;font-family:sans-serif;margin-bottom:4px">YCA prospects + legislation</div>
    <div style="font-size:13px;color:#6b7280;font-family:sans-serif">${esc(dateStr)}</div>
  </div>
  ${prospectsSection}
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
function buildEmail(opportunities, dateStr, replicateBusinesses = []) {
  const cards = opportunities.map(card).join('')
  const replicateSection = replicateBusinesses.length ? `
  <div style="margin-top:8px;margin-bottom:20px;padding-top:28px;border-top:2px solid #e5e7eb">
    <div style="font-size:20px;font-weight:700;color:#111827;font-family:sans-serif;margin-bottom:4px">Businesses to Replicate</div>
    <div style="font-size:13px;color:#6b7280;font-family:sans-serif;margin-bottom:20px">${replicateBusinesses.length} real, profitable business${replicateBusinesses.length === 1 ? '' : 'es'} worth cloning or studying</div>
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
  ${cards}
  ${replicateSection}
  <div style="border-top:1px solid #e5e7eb;margin-top:8px;padding-top:20px;font-size:11px;color:#9ca3af;font-family:sans-serif;line-height:1.6">
    Researched live by Claude (${MODEL}) with web search across Etsy/Amazon bestsellers, Google Trends UK, US/AU/CA models not yet mainstream in the UK, and Reddit founder communities. Sent automatically on alternating days.
  </div>
</div></body></html>`
}

// Brief fallback for the specific ResearchTimeoutError case — deliberately
// shorter than failureEmail (no raw error text to show, since "it was slow"
// is the whole story). With 15 minutes available this should be rare, but
// kept as a safeguard per the brief.
function timeoutEmail(dateStr) {
  return `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#f3f4f6">
<div style="max-width:560px;margin:0 auto;padding:32px 16px;font-family:sans-serif">
  <div style="font-size:18px;font-weight:700;color:#111827;margin-bottom:8px">Opportunity scan</div>
  <div style="font-size:13px;color:#6b7280;margin-bottom:16px">${esc(dateStr)}</div>
  <div style="background:#fff;border:1px solid #e5e7eb;border-radius:8px;padding:16px;font-size:13px;color:#374151;line-height:1.6">
    Research took too long today — will retry tomorrow.
  </div>
</div></body></html>`
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
    const { error: logErr } = await admin.from('opportunity_scanner_runs')
      .insert({ opportunities_found: itemsFound, email_sent: emailSent, error })
    if (logErr) console.error('[opportunity-scanner-worker-background] failed to write run log:', logErr.message)
  }

  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY

  const section = sectionForDate(new Date())

  try {
    if (!admin) throw new Error('SUPABASE_URL / SUPABASE_SERVICE_KEY not configured')
    if (!ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY not configured')
    if (!resendKey) throw new Error('RESEND_API_KEY not configured')

    const config = SECTION_CONFIG[section]
    console.log(`[opportunity-scanner-worker-background] starting run ${dateStr} — section ${section}`)
    const researchText = await fetchResearchText(ANTHROPIC_API_KEY, config.userPrompt, config.maxTokens, config.maxUses)
    const prettyDate = new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })

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

    const subject = `YCA prospects + legislation — ${dateStr}`
    const html = buildProspectsLegislationEmail(prospects, legislationItems, prettyDate)
    await sendEmail(resendKey, fromEmail, toEmail, subject, html)

    await logRun(prospects.length + legislationItems.length, true, null)
    console.log('[opportunity-scanner-worker-background] section B: email sent, run logged')
    return json(200, { ok: true, section, prospectsFound: prospects.length, legislationFound: legislationItems.length, emailSent: true })
  } catch (e) {
    const errMsg = String(e?.message ?? e)
    console.error('[opportunity-scanner-worker-background] run failed:', errMsg)

    // Best-effort failure notification so a broken run is never silent. A
    // ResearchTimeoutError gets the brief "will retry tomorrow" copy instead
    // of the generic failure email with the raw error message.
    const isTimeout = e instanceof ResearchTimeoutError
    let emailSent = false
    if (resendKey) {
      try {
        await sendEmail(resendKey, fromEmail, toEmail,
          isTimeout ? `Opportunity scan — will retry tomorrow — ${dateStr}` : `Opportunity scanner failed — ${dateStr}`,
          isTimeout ? timeoutEmail(dateStr) : failureEmail(errMsg, dateStr))
        emailSent = true
      } catch (notifyErr) {
        console.error('[opportunity-scanner-worker-background] failure email also failed:', String(notifyErr?.message ?? notifyErr))
      }
    }
    await logRun(0, emailSent, errMsg)
    return json(500, { ok: false, error: errMsg, emailSent })
  }
}
