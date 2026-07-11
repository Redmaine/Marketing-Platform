import { NavLink, useLocation, useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'

const I = {
  dashboard: 'M3 12l2-2 7-7 7 7 2 2M5 10v10a1 1 0 001 1h4v-6h4v6h4a1 1 0 001-1V10',
  clients: 'M17 20h5v-2a3 3 0 00-5.4-1.8M17 20H7m10 0v-2a5.8 5.8 0 00-.4-1.8M7 20H2v-2a3 3 0 015.4-1.8M7 20v-2c0-.6.1-1.2.4-1.8m0 0a5 5 0 019.2 0M15 7a3 3 0 11-6 0 3 3 0 016 0z',
  content: 'M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.6a1 1 0 01.7.3l5.4 5.4a1 1 0 01.3.7V19a2 2 0 01-2 2z',
  calendar: 'M8 7V3m8 4V3M4 11h16M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z',
  blog: 'M11 4H6a2 2 0 00-2 2v12a2 2 0 002 2h12a2 2 0 002-2v-5M18.4 2.6a2 2 0 112.9 2.9L11 16l-4 1 1-4 10.4-10.4z',
  reports: 'M9 17v-6m3 6V7m3 10v-3M5 21h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v14a2 2 0 002 2z',
  settings: 'M10.3 4.3c.4-1.8 2.9-1.8 3.3 0a1.7 1.7 0 002.6 1.1c1.5-.9 3.3.8 2.4 2.4a1.7 1.7 0 001 2.5c1.8.5 1.8 3 0 3.4a1.7 1.7 0 00-1 2.5c.9 1.6-.9 3.3-2.4 2.4a1.7 1.7 0 00-2.6 1.1c-.4 1.8-2.9 1.8-3.3 0a1.7 1.7 0 00-2.6-1.1c-1.5.9-3.3-.8-2.4-2.4a1.7 1.7 0 00-1-2.5c-1.8-.5-1.8-3 0-3.4a1.7 1.7 0 001-2.5c-.9-1.6.9-3.3 2.4-2.4 1 .6 2.3.1 2.6-1.1zM15 12a3 3 0 11-6 0 3 3 0 016 0z',
  back: 'M15 19l-7-7 7-7',
}
function Icon({ d }) {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d={d} /></svg>
}

const NAV = [
  { to: '/dashboard', label: 'Dashboard', icon: I.dashboard },
  { to: '/clients', label: 'Clients', icon: I.clients },
  { to: '/content', label: 'Content', icon: I.content },
  { to: '/calendar', label: 'Calendar', icon: I.calendar },
  { to: '/blog', label: 'Blog', icon: I.blog },
  { to: '/reports', label: 'Reports', icon: I.reports },
]

const TITLES = {
  '/dashboard': 'Dashboard', '/clients': 'Clients', '/content': 'Content queue',
  '/calendar': 'Calendar', '/blog': 'Blog', '/reports': 'Reports', '/settings': 'Settings',
}

export function Layout({ children }) {
  const { signOut } = useAuth()
  const loc = useLocation()
  const navigate = useNavigate()
  const isDetail = loc.pathname.split('/').filter(Boolean).length > 1
  const title = TITLES[loc.pathname] || (isDetail ? 'Client' : 'YCA Ops')

  return (
    <div className="app">
      {/* Desktop sidebar */}
      <aside className="sidebar">
        <div className="brand">YCA<span>.</span> Ops</div>
        {NAV.map((n) => (
          <NavLink key={n.to} to={n.to} className={({ isActive }) => 'nav-link' + (isActive ? ' active' : '')}>
            <Icon d={n.icon} /> {n.label}
          </NavLink>
        ))}
        <NavLink to="/settings" className={({ isActive }) => 'nav-link' + (isActive ? ' active' : '')}>
          <Icon d={I.settings} /> Settings
        </NavLink>
        <div className="spacer" />
        <button className="signout" onClick={signOut}>Sign out</button>
      </aside>

      {/* Mobile top bar */}
      <div className="topbar">
        {isDetail && (
          <button className="t-btn" onClick={() => navigate(-1)} aria-label="Back"><Icon d={I.back} /></button>
        )}
        <span className="t-title">{title}</span>
        <NavLink to="/settings" className="t-btn" aria-label="Settings"><Icon d={I.settings} /></NavLink>
      </div>

      <main className="main">{children}</main>

      {/* Mobile bottom nav (5 icons) */}
      <nav className="bottomnav">
        {NAV.map((n) => (
          <NavLink key={n.to} to={n.to} className={({ isActive }) => (isActive ? 'active' : '')}>
            <Icon d={n.icon} /> {n.label}
          </NavLink>
        ))}
      </nav>
    </div>
  )
}
