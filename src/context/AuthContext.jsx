import { createContext, useContext, useEffect, useState } from 'react'
import supabase from '../lib/supabase'

const AuthContext = createContext(null)

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null)
  const [isAdmin, setIsAdmin] = useState(false)
  const [loading, setLoading] = useState(true)

  async function resolve(session) {
    const u = session?.user ?? null
    setUser(u)
    if (u) {
      // mkt_is_admin() reads the agency admin list under RLS-safe SECURITY DEFINER.
      // Logged on error (27 Aug 2026) — this call failing (an expired/invalid
      // token, a network error, anything) used to be indistinguishable from a
      // real "not an admin" result: data comes back null either way, so a
      // signed-in admin landed on the agency-view gate with zero trace of why.
      const { data, error } = await supabase.rpc('mkt_is_admin')
      if (error) {
        console.error(`[AuthContext] mkt_is_admin RPC failed for ${u.email}: ${error.message} (code: ${error.code ?? 'none'})`)
      }
      // KNOWN OPEN PLATFORM ISSUE (27 Aug 2026) — if error.code is 'PGRST303'
      // ("JWT issued at future"), this is NOT a bug in this file or in
      // mkt_is_admin(). It's Supabase's own PostgREST rejecting a
      // correctly-signed, freshly-issued token because PostgREST's clock is
      // intermittently out of sync with GoTrue's. Confirmed on a completely
      // fresh sign-in (cleared storage, brand-new session) — not a stale
      // cached token. Same root cause, same error code, as the service-role
      // 401s send-digest hit starting 2026-08-26 15:29:15 UTC (see that
      // file's own note and commit 3eed5ee) — that incident was worked
      // around (fail loudly instead of showing fabricated data), never
      // fixed, because the fault is on Supabase's infrastructure, not ours.
      // Reported to Supabase support 27 Aug 2026 with both occurrences as
      // evidence (service-role token + user-session token, 27+ hours apart,
      // clock-comparison data attached). If you hit PGRST303 again: this is
      // already known and reported, don't restart the investigation — check
      // if the ticket has a resolution before treating it as new.
      setIsAdmin(data === true)
    } else {
      setIsAdmin(false)
    }
    setLoading(false)
  }

  useEffect(() => {
    // Supabase v2 fires a synthetic INITIAL_SESSION event on mount, delivering
    // the current session — so getSession() is redundant and causes a second
    // mkt_is_admin RPC call and a race to setLoading(false).
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_e, session) => resolve(session))
    return () => subscription.unsubscribe()
  }, [])

  async function signOut() {
    await supabase.auth.signOut()
  }

  return (
    <AuthContext.Provider value={{ user, isAdmin, loading, signOut }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider')
  return ctx
}
