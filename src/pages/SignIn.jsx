import { useState } from 'react'
import supabase from '../lib/supabase'

export function SignIn() {
  const [email, setEmail] = useState('')
  const [sent, setSent] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function send(e) {
    e.preventDefault()
    if (!email.trim()) return
    setBusy(true); setError('')
    const { error } = await supabase.auth.signInWithOtp({
      email: email.trim(),
      options: { emailRedirectTo: window.location.origin },
    })
    setBusy(false)
    if (error) { setError("Couldn't send the link — try again."); return }
    setSent(true)
  }

  return (
    <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', background: 'var(--steel)', padding: 24 }}>
      <div className="card" style={{ width: '100%', maxWidth: 380 }}>
        <div style={{ fontWeight: 800, fontSize: 22, marginBottom: 4 }}>YCA<span style={{ color: 'var(--ember)' }}>.</span> Ops</div>
        <p className="muted" style={{ marginBottom: 18 }}>Marketing operations. Sign in with a magic link — no password.</p>

        {sent ? (
          <div>
            <p style={{ fontWeight: 600 }}>Check your email.</p>
            <p className="muted" style={{ marginTop: 6 }}>We sent a sign-in link to {email}. Tap it on this device.</p>
          </div>
        ) : (
          <form onSubmit={send}>
            <div className="field">
              <label htmlFor="email">Email</label>
              <input id="email" className="input" type="email" autoComplete="email" inputMode="email"
                value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@yourcompanyai.co.uk" />
            </div>
            {error && <p style={{ color: 'var(--red)', fontSize: 13, marginBottom: 10 }}>{error}</p>}
            <button className="btn btn-primary btn-block" disabled={busy}>
              {busy ? 'Sending…' : 'Send me a link'}
            </button>
          </form>
        )}
      </div>
    </div>
  )
}
