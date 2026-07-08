import { useState, useEffect } from 'react'
import supabase from '../lib/supabase'

// Item 8e — email + password only. Magic-link sign-in was unreliable and has
// been removed as a sign-in method. "Forgot password" sends a reset link;
// arriving via that link (PASSWORD_RECOVERY) shows the set-new-password form so
// an admin who only ever used magic links can set a password once and then use
// it. Sessions persist via supabase.js (persistSession + autoRefreshToken), so
// a signed-in admin stays signed in well beyond a working day.
export function SignIn() {
  const [mode, setMode] = useState('password') // 'password' | 'reset' | 'recovery'
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [sent, setSent] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [info, setInfo] = useState('')

  // When the user opens a password-reset link, Supabase fires PASSWORD_RECOVERY.
  // Switch to the set-new-password form.
  useEffect(() => {
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event) => {
      if (event === 'PASSWORD_RECOVERY') { setMode('recovery'); setError(''); setInfo('') }
    })
    return () => subscription.unsubscribe()
  }, [])

  async function signInPassword(e) {
    e.preventDefault()
    if (!email.trim() || !password) return
    setBusy(true); setError('')
    const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password })
    setBusy(false)
    if (error) { setError('Wrong email or password. If you have never set a password, use "Forgot password".'); return }
    // AuthContext's onAuthStateChange picks up the new session automatically.
  }

  async function sendResetLink(e) {
    e.preventDefault()
    if (!email.trim()) return
    setBusy(true); setError('')
    const { error } = await supabase.auth.resetPasswordForEmail(email.trim(), { redirectTo: window.location.origin })
    setBusy(false)
    if (error) { setError("Couldn't send the reset link — try again."); return }
    setSent(true)
  }

  async function setNewPasswordSubmit(e) {
    e.preventDefault()
    if (newPassword.length < 8) { setError('Password must be at least 8 characters.'); return }
    setBusy(true); setError('')
    const { error } = await supabase.auth.updateUser({ password: newPassword })
    setBusy(false)
    if (error) { setError(error.message); return }
    // updateUser leaves them signed in — AuthContext takes over from here.
    setInfo('Password set. Signing you in…')
  }

  function switchMode(next) {
    setMode(next); setSent(false); setError(''); setInfo(''); setPassword('')
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
            <button type="button" className="btn-link" style={{ ...linkStyle, marginTop: 12, display: 'block' }} onClick={() => switchMode('reset')}>
              Forgot password?
            </button>
          </form>
        )}

        {mode === 'reset' && (
          sent ? (
            <div>
              <p style={{ fontWeight: 600 }}>Check your email.</p>
              <p className="muted" style={{ marginTop: 6 }}>We sent a link to {email} to set a new password. Open it on this device.</p>
              <button type="button" className="btn-link" style={{ ...linkStyle, marginTop: 12, display: 'block' }} onClick={() => switchMode('password')}>Back to sign in</button>
            </div>
          ) : (
            <form onSubmit={sendResetLink}>
              <p className="muted" style={{ marginBottom: 14, fontSize: 13 }}>We'll email you a link to set your password.</p>
              <div className="field">
                <label htmlFor="email-reset">Email</label>
                <input id="email-reset" className="input" type="email" autoComplete="email" inputMode="email"
                  value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@yourcompanyai.co.uk" />
              </div>
              {error && <p style={{ color: 'var(--red)', fontSize: 13, marginBottom: 10 }}>{error}</p>}
              <button className="btn btn-primary btn-block" disabled={busy}>{busy ? 'Sending…' : 'Send link'}</button>
              <button type="button" className="btn-link" style={{ ...linkStyle, marginTop: 12, display: 'block' }} onClick={() => switchMode('password')}>Back to sign in</button>
            </form>
          )
        )}

        {mode === 'recovery' && (
          <form onSubmit={setNewPasswordSubmit}>
            <p className="muted" style={{ marginBottom: 14, fontSize: 13 }}>Set a new password for your account.</p>
            <div className="field">
              <label htmlFor="new-password">New password</label>
              <input id="new-password" className="input" type="password" autoComplete="new-password"
                value={newPassword} onChange={(e) => setNewPassword(e.target.value)} placeholder="At least 8 characters" />
            </div>
            {error && <p style={{ color: 'var(--red)', fontSize: 13, marginBottom: 10 }}>{error}</p>}
            {info && <p style={{ color: 'var(--green, #059669)', fontSize: 13, marginBottom: 10 }}>{info}</p>}
            <button className="btn btn-primary btn-block" disabled={busy}>{busy ? 'Saving…' : 'Set password'}</button>
          </form>
        )}
      </div>
    </div>
  )
}

const linkStyle = { background: 'none', border: 'none', padding: 0, color: 'var(--ember)', fontSize: 13, cursor: 'pointer' }
