import { useState } from 'react'
import supabase from '../lib/supabase'

const PLATFORMS = [
  { value: 'facebook', label: 'Facebook' },
  { value: 'linkedin', label: 'LinkedIn' },
]

// Default the schedule picker to tomorrow at the client's usual post time.
function defaultSchedule(client) {
  const d = new Date()
  d.setDate(d.getDate() + 1)
  const [hh, mm] = String(client?.post_time || '09:00').split(':')
  d.setHours(Number(hh) || 9, Number(mm) || 0, 0, 0)
  // Format as YYYY-MM-DDTHH:mm for <input type="datetime-local">
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function GeneratePostModal({ client, onClose, onDone }) {
  const pillars = client?.content_pillars || []
  const [platform, setPlatform] = useState('facebook')
  const [pillar, setPillar] = useState(pillars[0] || '')
  const [draft, setDraft] = useState(null)        // the created mkt_content_queue row
  const [generating, setGenerating] = useState(false)
  const [working, setWorking] = useState(false)   // approve / reject in flight
  const [error, setError] = useState('')
  const [when, setWhen] = useState(defaultSchedule(client))

  async function generate(replaceId) {
    setError(''); setGenerating(true)
    // Regenerate replaces the previous draft.
    if (replaceId) { await supabase.from('mkt_content_queue').delete().eq('id', replaceId) }
    const { data, error } = await supabase.functions.invoke('generate-content', {
      body: { client_id: client.id, platform, pillar: pillar || 'General' },
    })
    setGenerating(false)
    if (error || !data?.item) { setError(data?.error || "Couldn't generate that — try again."); return }
    setDraft(data.item)
  }

  async function reject() {
    if (!draft) { onClose(); return }
    setWorking(true)
    await supabase.from('mkt_content_queue').delete().eq('id', draft.id)
    setWorking(false)
    onDone?.()
    onClose()
  }

  async function approve() {
    if (!draft) return
    setError(''); setWorking(true)
    const iso = new Date(when).toISOString()
    const { error: upErr } = await supabase.from('mkt_content_queue')
      .update({ status: 'approved', approved_at: new Date().toISOString(), scheduled_for: iso })
      .eq('id', draft.id)
    if (upErr) { setWorking(false); setError('Could not approve — try again.'); return }

    const { data, error } = await supabase.functions.invoke('schedule-to-metricool', {
      body: { content_queue_id: draft.id, scheduled_for: iso },
    })
    setWorking(false)
    if (error || data?.error) {
      // Approved but Metricool scheduling failed — keep it approved, surface why.
      setError(data?.error || 'Approved, but Metricool scheduling failed. Check the brand ID and API key.')
      onDone?.()
      return
    }
    onDone?.()
    onClose()
  }

  return (
    <div className="modal-bg" onClick={(e) => { if (e.target === e.currentTarget && !generating && !working) onClose() }}>
      <div className="modal">
        <h2 style={{ fontSize: 18, marginBottom: 4 }}>Generate a post</h2>
        <p className="muted" style={{ fontSize: 13, marginBottom: 14 }}>{client.short_name || client.name}</p>

        {!draft ? (
          <>
            <div className="grid grid-2">
              <div className="field">
                <label>Platform</label>
                <select className="input" value={platform} onChange={(e) => setPlatform(e.target.value)} disabled={generating}>
                  {PLATFORMS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
                </select>
              </div>
              <div className="field">
                <label>Content pillar</label>
                <select className="input" value={pillar} onChange={(e) => setPillar(e.target.value)} disabled={generating}>
                  {pillars.length === 0 && <option value="">General</option>}
                  {pillars.map((p) => <option key={p} value={p}>{p}</option>)}
                </select>
              </div>
            </div>
            {error && <p style={{ color: 'var(--red)', fontSize: 13, marginBottom: 10 }}>{error}</p>}
            <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
              <button className="btn btn-ghost" onClick={onClose} disabled={generating}>Cancel</button>
              <button className="btn btn-primary btn-block" onClick={() => generate()} disabled={generating}>
                {generating ? 'Writing…' : 'Generate'}
              </button>
            </div>
            {generating && <p className="muted" style={{ fontSize: 12, marginTop: 10 }}>Claude is writing the post — a few seconds.</p>}
          </>
        ) : (
          <>
            <div className="field">
              <label style={{ textTransform: 'capitalize' }}>{draft.platform} · {draft.pillar}</label>
              <div className="card" style={{ whiteSpace: 'pre-wrap', fontSize: 14, lineHeight: 1.5, maxHeight: 280, overflow: 'auto' }}>
                {draft.body}
              </div>
            </div>
            <div className="field">
              <label>Schedule for</label>
              <input className="input" type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} disabled={working} />
            </div>
            {error && <p style={{ color: 'var(--red)', fontSize: 13, marginBottom: 10 }}>{error}</p>}
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button className="btn btn-ghost" onClick={reject} disabled={working || generating}>
                {working ? '…' : 'Reject'}
              </button>
              <button className="btn btn-ghost" onClick={() => generate(draft.id)} disabled={working || generating}>
                {generating ? 'Rewriting…' : 'Regenerate'}
              </button>
              <button className="btn btn-primary" style={{ flex: 1 }} onClick={approve} disabled={working || generating}>
                {working ? 'Scheduling…' : 'Approve & schedule'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
