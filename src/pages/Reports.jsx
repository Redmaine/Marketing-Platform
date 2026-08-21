import { useEffect, useState } from 'react'
import supabase from '../lib/supabase'
// UK-local display formatting (src/lib/ukTime.js). Only the RENDERING of
// stored UTC timestamps goes through these — every query filter, sort and
// date-bucketing key below is left on the raw value, deliberately.
import { ukDate } from '../lib/ukTime'

const monthLabel = (d = new Date()) => d.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })

export function Reports() {
  const [reports, setReports] = useState([])
  const [clients, setClients] = useState([])
  const [loading, setLoading] = useState(true)
  const [modal, setModal] = useState(false)

  async function load() {
    setLoading(true)
    const [r, c] = await Promise.all([
      supabase.from('mkt_reports').select('*, client:mkt_clients(name,short_name)').order('created_at', { ascending: false }),
      supabase.from('mkt_clients').select('id, name, short_name').eq('active', true).order('name'),
    ])
    setReports(r.data || [])
    setClients(c.data || [])
    setLoading(false)
  }
  useEffect(() => { load() }, [])

  async function send(r) {
    // Make sure a PDF exists, then email it.
    if (!r.pdf_url) await supabase.functions.invoke('generate-pdf', { body: { report_id: r.id } }).catch(() => {})
    const { data, error } = await supabase.functions.invoke('send-report', { body: { report_id: r.id } })
    if (error || !data?.ok) { alert(data?.error || "Couldn't send the report — try again."); return }
    load()
  }
  async function download(r) {
    if (r.pdf_url) { window.open(r.pdf_url, '_blank'); return }
    const { data, error } = await supabase.functions.invoke('generate-pdf', { body: { report_id: r.id } })
    if (error || !data?.url) { alert("PDF export isn't switched on yet — it ships in Phase 4."); return }
    window.open(data.url, '_blank')
  }

  if (loading) return <div className="page"><span className="spinner" /></div>

  return (
    <div className="page">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div><h1>Reports</h1><p className="page-sub">Monthly reports for every client.</p></div>
        <button className="btn btn-primary btn-sm" onClick={() => setModal(true)}>Generate</button>
      </div>

      {reports.length === 0 ? (
        <p className="empty">No reports yet. Generate your first.</p>
      ) : (
        <div className="card" style={{ marginTop: 16 }}>
          {reports.map((r) => (
            <div key={r.id} className="row">
              <div>
                <div style={{ fontWeight: 600 }}>{r.client?.short_name || r.client?.name} — {r.month}</div>
                <div className="muted" style={{ fontSize: 12 }}>
                  {r.status}{r.sent_to_client ? ` · sent ${r.sent_at ? ukDate(r.sent_at, { day: '2-digit', month: '2-digit', year: 'numeric' }) : ''}` : ''}
                </div>
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button className="btn btn-ghost btn-sm" onClick={() => download(r)}>PDF</button>
                <button className="btn btn-primary btn-sm" onClick={() => send(r)} disabled={r.sent_to_client}>{r.sent_to_client ? 'Sent' : 'Send'}</button>
              </div>
            </div>
          ))}
        </div>
      )}

      {modal && <GenerateModal clients={clients} onClose={() => setModal(false)} onSaved={() => { setModal(false); load() }} />}
    </div>
  )
}

function GenerateModal({ clients, onClose, onSaved }) {
  const [clientId, setClientId] = useState(clients[0]?.id || '')
  const [month, setMonth] = useState(monthLabel())
  const [narrative, setNarrative] = useState('')
  const [reportId, setReportId] = useState(null)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')

  async function generate() {
    if (!clientId) return
    setBusy(true); setNotice('')
    // generate-report writes the draft itself and returns its id + narrative.
    const { data, error } = await supabase.functions.invoke('generate-report', { body: { client_id: clientId, month } })
    setBusy(false)
    if (error || !data?.narrative) { setNotice(data?.error || "Couldn't write that — try again."); return }
    setNarrative(data.narrative)
    setReportId(data.report_id || null)
  }

  // Save any edits Adrian made to the previewed narrative (the draft already exists).
  async function saveDraft() {
    setBusy(true)
    const { error } = reportId
      ? await supabase.from('mkt_reports').update({ narrative }).eq('id', reportId)
      : await supabase.from('mkt_reports').insert({ client_id: clientId, month, narrative, status: 'draft' })
    setBusy(false)
    if (error) { setNotice('Something went wrong — try again.'); return }
    onSaved()
  }

  return (
    <div className="modal-bg" onClick={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="modal">
        <h2 style={{ fontSize: 18, marginBottom: 14 }}>Generate a report</h2>
        <div className="grid grid-2">
          <div className="field"><label>Client</label>
            <select className="input" value={clientId} onChange={(e) => setClientId(e.target.value)}>
              {clients.map((c) => <option key={c.id} value={c.id}>{c.short_name || c.name}</option>)}
            </select>
          </div>
          <div className="field"><label>Month</label><input className="input" value={month} onChange={(e) => setMonth(e.target.value)} /></div>
        </div>

        {narrative ? (
          <div className="field"><label>Narrative (preview — edit before saving)</label>
            <textarea className="input" rows={9} value={narrative} onChange={(e) => setNarrative(e.target.value)} />
          </div>
        ) : (
          <button className="btn btn-dark btn-block" disabled={busy} onClick={generate}>{busy ? 'Writing…' : 'Write the narrative'}</button>
        )}

        {notice && <p style={{ color: 'var(--ember)', fontSize: 13, margin: '8px 0' }}>{notice}</p>}

        <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          {narrative && <button className="btn btn-primary btn-block" disabled={busy} onClick={saveDraft}>Save draft</button>}
        </div>
      </div>
    </div>
  )
}
