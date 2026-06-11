import { useEffect, useState } from 'react'
import { Routes, Route, Navigate } from 'react-router-dom'
import { useAuth } from './context/AuthContext'
import supabase from './lib/supabase'
import { Layout } from './components/Layout'
import { SignIn } from './pages/SignIn'
import { Dashboard } from './pages/Dashboard'
import { Clients } from './pages/Clients'
import { ClientDetail } from './pages/ClientDetail'
import { ContentQueue } from './pages/ContentQueue'
import { Calendar } from './pages/Calendar'
import { Reports } from './pages/Reports'
import { Settings } from './pages/Settings'

function FullScreen({ children }) {
  return <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 24, textAlign: 'center' }}>{children}</div>
}

export default function App() {
  const { user, isAdmin, loading } = useAuth()

  if (loading) return <FullScreen><span className="spinner" /></FullScreen>

  if (!user) return <SignIn />

  if (!isAdmin) return <NotAdminGate user={user} />

  return (
    <Layout>
      <Routes>
        <Route path="/" element={<Navigate to="/dashboard" replace />} />
        <Route path="/dashboard" element={<Dashboard />} />
        <Route path="/clients" element={<Clients />} />
        <Route path="/clients/:id" element={<ClientDetail />} />
        <Route path="/content" element={<ContentQueue />} />
        <Route path="/calendar" element={<Calendar />} />
        <Route path="/reports" element={<Reports />} />
        <Route path="/settings" element={<Settings />} />
        <Route path="*" element={<Navigate to="/dashboard" replace />} />
      </Routes>
    </Layout>
  )
}

// A signed-in non-admin reached the agency view. If they're a BUSINESS platform
// user, they're on the wrong app — send them to the business platform instead of
// dead-ending. Otherwise show a clear message with the right links.
function NotAdminGate({ user }) {
  const [checking, setChecking] = useState(true)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const { data } = await supabase.from('platform_users').select('id').eq('auth_user_id', user.id).maybeSingle()
      if (cancelled) return
      if (data) { window.location.href = 'https://start.yourcompanyai.co.uk'; return } // business user → business app
      setChecking(false)
    })()
    return () => { cancelled = true }
  }, [user.id])

  if (checking) return <FullScreen><span className="spinner" /></FullScreen>
  return (
    <FullScreen>
      <div className="card" style={{ maxWidth: 420 }}>
        <h2 style={{ fontSize: 18 }}>This is the agency view.</h2>
        <p className="muted" style={{ marginTop: 8 }}>
          You're signed in as {user.email}. If you're a Your Company AI business client, go to{' '}
          <a href="https://start.yourcompanyai.co.uk" style={{ color: 'var(--ember)' }}>start.yourcompanyai.co.uk</a>.
          If you're a marketing client, use your portal link — or email{' '}
          <a href="mailto:hello@yourcompanyai.co.uk" style={{ color: 'var(--ember)' }}>hello@yourcompanyai.co.uk</a>.
        </p>
      </div>
    </FullScreen>
  )
}
