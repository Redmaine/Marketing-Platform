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

function InviteModal({ onClose }) {
  const [f, setF] = useState({ recipient_name: '', business_name: '', recipient_email: '', channel: 'email' })
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState(null)
  const [error, setError] = useState('')
  const [copied, setCopied] = useState('')
  const u = (k) => (e) => setF((p) => ({ ...p, [k]: e.target.value }))

  async function send() {
    setBusy(true); setError('')
    const { data, error } = await supabase.functions.invoke('invite-send', { body: f })
    setBusy(false)
    if (error || !data?.invite_url) { setError(data?.error || "Couldn't create the invite — try again."); return }
    setResult(data)
  }
  function copy(text, which) {
    navigator.clipboard?.writeText(text).then(() => { setCopied(which); setTimeout(() => setCopied(''), 1500) })
  }

  return (
    <div className="modal-bg" onClick={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="modal">
        <h2 style={{ fontSize: 18, marginBottom: 14 }}>Invite a business</h2>
        {result ? (
          <div>
            <p style={{ fontWeight: 600, marginBottom: 10 }}>
              Invite ready.{result.email_sent ? ' Email sent.' : f.channel !== 'whatsapp' && f.recipient_email ? ' (Email not sent — check Resend.)' : ''}
            </p>
            <div className="field"><label>Invite link</label>
              <div style={{ display: 'flex', gap: 8 }}>
                <input className="input" readOnly value={result.invite_url} />
                <button className="btn btn-ghost btn-sm" onClick={() => copy(result.invite_url, 'link')}>{copied === 'link' ? 'Copied' : 'Copy'}</button>
              </div>
            </div>
            <div className="field"><label>WhatsApp</label>
              <div style={{ display: 'flex', gap: 8 }}>
                <a className="btn btn-primary btn-sm btn-block" href={result.whatsapp_url} target="_blank" rel="noreferrer">Share on WhatsApp</a>
                <button className="btn btn-ghost btn-sm" onClick={() => copy(result.whatsapp_url, 'wa')}>{copied === 'wa' ? 'Copied' : 'Copy link'}</button>
              </div>
            </div>
            <button className="btn btn-ghost btn-block" onClick={onClose} style={{ marginTop: 6 }}>Done</button>
          </div>
        ) : (
          <>
            <div className="grid grid-2">
              <div className="field"><label>Their name (optional)</label><input className="input" value={f.recipient_name} onChange={u('recipient_name')} /></div>
              <div className="field"><label>Business (optional)</label><input className="input" value={f.business_name} onChange={u('business_name')} /></div>
            </div>
            <div className="field"><label>Email (optional)</label><input className="input" type="email" value={f.recipient_email} onChange={u('recipient_email')} /></div>
            <div className="field"><label>Send via</label>
              <select className="input" value={f.channel} onChange={u('channel')}>
                <option value="email">Email</option><option value="whatsapp">WhatsApp</option><option value="both">Both</option>
              </select>
            </div>
            {error && <p style={{ color: 'var(--red)', fontSize: 13 }}>{error}</p>}
            <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
              <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
              <button className="btn btn-primary btn-block" disabled={busy} onClick={send}>{busy ? 'Creating…' : 'Create invite'}</button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

const CONNECTIONS = [
  { name: 'Supabase', note: 'Database, auth, storage — anon key in Netlify env.' },
  { name: 'Anthropic (claude-haiku-4-5)', note: 'Content + reports. Key in Supabase vault.' },
  { name: 'Metricool', note: 'Social scheduling. API key in Supabase vault (METRICOOL_API_KEY).' },
  { name: 'Google My Business', note: 'Reviews. Key in Supabase vault.' },
  { name: 'Resend', note: 'Email. Key in Supabase vault.' },
]

export function Settings() {
  const [clients, setClients] = useState([])
  const [loading, setLoading] = useState(true)
  const [inviting, setInviting] = useState(false)

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

      <div className="card" style={{ marginTop: 16, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
        <div>
          <h2 style={{ fontSize: 15 }}>Invite a business</h2>
          <p className="muted" style={{ fontSize: 12, marginTop: 2 }}>Send an invite by email or share on WhatsApp. 30 days free, no card.</p>
        </div>
        <button className="btn btn-primary btn-sm" onClick={() => setInviting(true)}>New invite</button>
      </div>
      {inviting && <InviteModal onClose={() => setInviting(false)} />}

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
