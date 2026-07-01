import { useState } from 'react'
import supabase from '../lib/supabase'

export function SignIn() {
  // 'password' is the default/primary flow. 'magiclink' and 'reset' are fallbacks.
  const [mode, setMode] = useState('password')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [sent, setSent] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function signInPassword(e) {
    e.preventDefault()
    if (!email.trim() || !password) return
    setBusy(true); setError('')
    const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password })
    setBusy(false)
    if (error) { setError('Wrong email or password — try again, or use a magic link.'); return }
    // AuthContext's onAuthStateChange picks up the new session automatically.
  }

  async function sendMagicLink(e) {
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

  async function sendResetLink(e) {
    e.preventDefault()
    if (!email.trim()) return
    setBusy(true); setError('')
    const { error } = await supabase.auth.resetPasswordForEmail(email.trim(), {
      redirectTo: window.location.origin,
    })
    setBusy(false)
    if (error) { setError("Couldn't send the reset link — try again."); return }
    setSent(true)
  }

  function switchMode(next) {
    setMode(next); setSent(false); setError(''); setPassword('')
  }

  return (
    <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', background: 'var(--steel)', padding: 24 }}>
      <div className="card" style={{ width: '100%', maxWidth: 380 }}>
        <div style={{ fontWeight: 800, fontSize: 22, marginBottom: 4 }}>YCA<span style={{ color: 'var(--ember)' }}>.</span> Ops</div>
        <p className="muted" style={{ marginBottom: 18 }}>Marketing operations.</p>

        {mode === 'password' && (
          <form onSubmit={signInPassword}>
            <div className="field">
              <label htmlFor="email">Email</label>
              <input id="email" className="input" type="email" autoComplete="email" inputMode="email"
                value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@yourcompanyai.co.uk" />
            </div>
            <div className="field">
              <label htmlFor="password">Password</label>
              <input id="password" className="input" type="password" autoComplete="current-password"
                value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" />
            </div>
            {error && <p style={{ color: 'var(--red)', fontSize: 13, marginBottom: 10 }}>{error}</p>}
            <button className="btn btn-primary btn-block" disabled={busy}>
              {busy ? 'Signing in…' : 'Sign in'}
            </button>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 12 }}>
              <button type="button" className="btn-link" style={linkStyle} onClick={() => switchMode('reset')}>
                Forgot password?
              </button>
              <button type="button" className="btn-link" style={linkStyle} onClick={() => switchMode('magiclink')}>
                Use a magic link instead
              </button>
            </div>
          </form>
        )}

        {mode === 'magiclink' && (
          sent ? (
            <div>
              <p style={{ fontWeight: 600 }}>Check your email.</p>
              <p className="muted" style={{ marginTop: 6 }}>We sent a sign-in link to {email}. Tap it on this device.</p>
            </div>
          ) : (
            <form onSubmit={sendMagicLink}>
              <p className="muted" style={{ marginBottom: 14, fontSize: 13 }}>No password — we'll email you a sign-in link.</p>
              <div className="field">
                <label htmlFor="email-link">Email</label>
                <input id="email-link" className="input" type="email" autoComplete="email" inputMode="email"
                  value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@yourcompanyai.co.uk" />
              </div>
              {error && <p style={{ color: 'var(--red)', fontSize: 13, marginBottom: 10 }}>{error}</p>}
              <button className="btn btn-primary btn-block" disabled={busy}>
                {busy ? 'Sending…' : 'Send me a link'}
              </button>
              <button type="button" className="btn-link" style={{ ...linkStyle, marginTop: 12, display: 'block' }} onClick={() => switchMode('password')}>
                Use password instead
              </button>
            </form>
          )
        )}

        {mode === 'reset' && (
          sent ? (
            <div>
              <p style={{ fontWeight: 600 }}>Check your email.</p>
              <p className="muted" style={{ marginTop: 6 }}>We sent a password reset link to {email}.</p>
            </div>
          ) : (
            <form onSubmit={sendResetLink}>
              <p className="muted" style={{ marginBottom: 14, fontSize: 13 }}>We'll email you a link to set a new password.</p>
              <div className="field">
                <label htmlFor="email-reset">Email</label>
                <input id="email-reset" className="input" type="email" autoComplete="email" inputMode="email"
                  value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@yourcompanyai.co.uk" />
              </div>
              {error && <p style={{ color: 'var(--red)', fontSize: 13, marginBottom: 10 }}>{error}</p>}
              <button className="btn btn-primary btn-block" disabled={busy}>
                {busy ? 'Sending…' : 'Send reset link'}
              </button>
              <button type="button" className="btn-link" style={{ ...linkStyle, marginTop: 12, display: 'block' }} onClick={() => switchMode('password')}>
                Back to sign in
              </button>
            </form>
          )
        )}
      </div>
    </div>
  )
}

const linkStyle = { background: 'none', border: 'none', padding: 0, color: 'var(--ember)', fontSize: 13, cursor: 'pointer' }
