import { useEffect, useState } from 'react'
import supabase from '../lib/supabase'

// The MASTER_SYSTEM_PROMPT — shown verbatim. This is the quality standard the
// product is built on. It is used unchanged by the generate-content Edge
// Function (Phase 2). It must never be shortened or rewritten without Adrian's
// explicit instruction.
const MASTER_SYSTEM_PROMPT = `You are one of the best copywriters in the UK. You have won awards. Your work has appeared in national campaigns. You write for businesses, not brands — and you write like a person, not a department.

VOICE AND STYLE — NON-NEGOTIABLE:
- Short sentences. Varied rhythm. Punchy. Read it back — if it sounds like a press release, start again.
- Lead with the most interesting thing. Not a preamble. Not context-setting. The most interesting thing, first.
- Never tell the reader what they already know. Don't explain the problem they live with every day — just show you understand it, then move.
- Every sentence must earn its place. If removing it changes nothing, remove it.
- Write the way a smart, straight-talking business owner would speak to a customer they respect.
- No corporate voice. No agency voice. The voice of the business itself.

BANNED WORDS AND PHRASES — NEVER USE THESE:
leverage, utilise, comprehensive, seamless, game-changing, innovative, cutting-edge, passionate, excited, proud, delighted, thrilled, dynamic, bespoke (unless it genuinely is), solution (as a verb), ecosystem, journey, space (as in "the HR space"), empower, transform, revolutionise, best-in-class, world-class, going forward, at the end of the day, in today's fast-paced world, we're excited to announce, don't hesitate to, reach out.

BANNED FORMATS:
- No emojis. Ever.
- No hashtag spam. Maximum two hashtags if needed, specific not generic.
- No bullet points in social copy.
- No "Here's a post about X:" — just write the post.
- No exclamation marks unless the sentence genuinely warrants one (rare).

QUALITY TEST — before finishing, ask:
1. Would a real person write this? Or does it sound like it was generated?
2. Is the opening line strong enough to stop a scroll?
3. Is there a single weak sentence that could be cut?
4. Does it sound like THIS business, or could it belong to anyone?

FORMAT: Return only the post copy. Nothing else. No preamble. No label. Just the copy.`

const CONNECTIONS = [
  { name: 'Supabase', note: 'Database, auth, storage — anon key in Netlify env.' },
  { name: 'Anthropic (claude-haiku-4-5)', note: 'Content + reports. Key in Supabase vault.' },
  { name: 'Buffer', note: 'Social scheduling. Token in Supabase vault.' },
  { name: 'Google My Business', note: 'Reviews. Key in Supabase vault.' },
  { name: 'Resend', note: 'Email. Key in Supabase vault.' },
]

export function Settings() {
  const [clients, setClients] = useState([])
  const [loading, setLoading] = useState(true)

  async function load() {
    setLoading(true)
    const { data } = await supabase.from('mkt_clients').select('id, name, short_name, active').order('name')
    setClients(data || [])
    setLoading(false)
  }
  useEffect(() => { load() }, [])

  async function toggleActive(c) {
    const { error } = await supabase.from('mkt_clients').update({ active: !c.active }).eq('id', c.id)
    if (!error) setClients((p) => p.map((x) => x.id === c.id ? { ...x, active: !x.active } : x))
  }

  return (
    <div className="page">
      <h1>Settings</h1>
      <p className="page-sub">Connections, the master prompt, and your clients.</p>

      <div className="card" style={{ marginTop: 16 }}>
        <h2 style={{ fontSize: 15, marginBottom: 8 }}>Connections</h2>
        {CONNECTIONS.map((c) => (
          <div key={c.name} className="row">
            <div><div style={{ fontWeight: 600 }}>{c.name}</div><div className="muted" style={{ fontSize: 12 }}>{c.note}</div></div>
            <span className="muted" style={{ fontSize: 12 }}>Set in env / vault</span>
          </div>
        ))}
        <p className="muted" style={{ fontSize: 12, marginTop: 10 }}>
          Keys live in Netlify env (frontend) and the Supabase vault (Edge Functions). They are never exposed in the app.
        </p>
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <h2 style={{ fontSize: 15, marginBottom: 4 }}>Master prompt</h2>
        <p className="muted" style={{ fontSize: 12, marginBottom: 8 }}>
          Used verbatim for every content generation. Locked to this standard — changes need a code review.
        </p>
        <textarea className="input" rows={12} readOnly value={MASTER_SYSTEM_PROMPT} style={{ fontFamily: 'ui-monospace, monospace', fontSize: 12 }} />
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <h2 style={{ fontSize: 15, marginBottom: 8 }}>Clients</h2>
        {loading ? <span className="spinner" /> : clients.map((c) => (
          <div key={c.id} className="row">
            <div style={{ fontWeight: 600 }}>{c.short_name || c.name} {!c.active && <span className="muted" style={{ fontWeight: 400 }}>· archived</span>}</div>
            <button className="btn btn-ghost btn-sm" onClick={() => toggleActive(c)}>{c.active ? 'Archive' : 'Restore'}</button>
          </div>
        ))}
      </div>
    </div>
  )
}
