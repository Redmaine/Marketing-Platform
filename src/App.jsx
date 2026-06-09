import { Routes, Route, Navigate } from 'react-router-dom'
import { useAuth } from './context/AuthContext'
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

  if (!isAdmin) {
    return (
      <FullScreen>
        <div className="card" style={{ maxWidth: 380 }}>
          <h2 style={{ fontSize: 18 }}>This account can't open the agency view.</h2>
          <p className="muted" style={{ marginTop: 8 }}>You're signed in as {user.email}. Ask Adrian to add you, or use your client portal link.</p>
        </div>
      </FullScreen>
    )
  }

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
