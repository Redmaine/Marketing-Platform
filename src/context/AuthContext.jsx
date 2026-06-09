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
      const { data } = await supabase.rpc('mkt_is_admin')
      setIsAdmin(data === true)
    } else {
      setIsAdmin(false)
    }
    setLoading(false)
  }

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => resolve(session))
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
