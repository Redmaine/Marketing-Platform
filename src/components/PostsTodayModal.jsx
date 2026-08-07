const PLATFORM_LABEL = {
  facebook: 'Facebook',
  instagram: 'Instagram',
  google_business: 'Google Business',
  blog: 'Blog',
  ad_facebook: 'Facebook Ad',
  ad_google: 'Google Ad',
  linkedin: 'LinkedIn',
  twitter: 'Twitter (X)',
}

// "failed" isn't a stored status — it's inferred the same way the dashboard
// counter and the /content?status=failed view derive it: approved, never
// reached Metricool, and the scheduled time has already passed.
function displayStatus(post) {
  const now = new Date()
  if (post.status === 'approved' && !post.metricool_post_id && post.scheduled_for && new Date(post.scheduled_for) < now) {
    return 'failed'
  }
  return post.status
}

const STATUS_STYLE = {
  scheduled: { background: '#DBEAFE', color: '#1E40AF' },
  published: { background: '#D1FAE5', color: '#065F46' },
  failed: { background: '#FEE2E2', color: '#991B1B' },
  approved: { background: '#FEF3C7', color: '#92400E' },
  draft: { background: '#FEF3C7', color: '#92400E' },
  pending: { background: '#FEF3C7', color: '#92400E' },
  rejected: { background: 'var(--chalk)', color: 'var(--steel)' },
}

export function PostsTodayModal({ posts, clients, onClose }) {
  const byId = Object.fromEntries((clients || []).map((c) => [c.id, c]))
  const sorted = [...(posts || [])].sort((a, b) => {
    if (!a.scheduled_for) return 1
    if (!b.scheduled_for) return -1
    return new Date(a.scheduled_for) - new Date(b.scheduled_for)
  })

  return (
    <div className="modal-bg" onClick={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="modal" style={{ maxWidth: 640 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 4 }}>
          <h2 style={{ fontSize: 18, flex: 1 }}>Posts today</h2>
          <button className="btn btn-ghost btn-sm" onClick={onClose}>Close</button>
        </div>
        <p className="muted" style={{ fontSize: 13, marginBottom: 16 }}>
          {sorted.length === 0 ? 'Nothing scheduled for today.' : `${sorted.length} post${sorted.length === 1 ? '' : 's'} scheduled across all brands.`}
        </p>

        {sorted.map((post) => {
          const client = byId[post.client_id]
          const status = displayStatus(post)
          const statusStyle = STATUS_STYLE[status] || { background: 'var(--chalk)', color: 'var(--steel)' }
          return (
            <div key={post.id} className="card" style={{ marginBottom: 12 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8, marginBottom: 10 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                  {client?.logo_url ? (
                    <img src={client.logo_url} alt="" width={20} height={20} style={{ borderRadius: 4, objectFit: 'cover', flexShrink: 0 }} />
                  ) : (
                    <span className="dot" style={{ background: client?.brand_primary_color || 'var(--ember)', flexShrink: 0 }} />
                  )}
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 800 }}>{client?.short_name || client?.name || 'Unknown brand'}</div>
                    <div style={{ fontSize: 11, color: 'var(--mist)' }}>
                      {PLATFORM_LABEL[post.platform] || post.platform}
                      {post.scheduled_for && (
                        <span style={{ marginLeft: 8 }}>
                          · {new Date(post.scheduled_for).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}
                        </span>
                      )}
                    </div>
                  </div>
                </div>
                <span className="pill" style={{ ...statusStyle, flexShrink: 0 }}>{status}</span>
              </div>
              <p style={{ fontSize: 14, lineHeight: 1.6, whiteSpace: 'pre-wrap', overflowWrap: 'break-word' }}>{post.body}</p>
            </div>
          )
        })}
      </div>
    </div>
  )
}
