'use client'

import { useEffect, useState, useCallback } from 'react'
import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
)

type RegistrationRow = {
  registration_id: string
  artist_id: string
  registration_type: string
  registration_category: string
  display_name: string
  status: string
  submitted_at: string | null
  activated_at: string | null
  awaiting_action: string | null
  action_url: string | null
  last_error: string | null
  error_count: number
  attempts: number
  external_id: string | null
  is_automated: boolean
  requires_human: boolean
  human_action_note: string | null
  is_international: boolean
  territory: string | null
  sort_order: number
  instructions: string | null
  documents_needed: string[] | null
  estimated_minutes: number | null
  portal_sort_order: number | null
  assigned_to: string | null
}

const STATUS_META: Record<string, { label: string; color: string; bg: string; dot: string }> = {
  PENDING:     { label: 'Pending',     color: '#888',    bg: 'rgba(136,136,136,0.1)',  dot: '#888' },
  QUEUED:      { label: 'Queued',      color: '#a0a',    bg: 'rgba(170,0,170,0.1)',    dot: '#a0a' },
  IN_PROGRESS: { label: 'In Progress', color: '#f0a020', bg: 'rgba(240,160,32,0.12)', dot: '#f0a020' },
  SUBMITTED:   { label: 'Submitted',   color: '#3090f0', bg: 'rgba(48,144,240,0.12)', dot: '#3090f0' },
  ACTIVE:      { label: 'Active',      color: '#22c55e', bg: 'rgba(34,197,94,0.12)',  dot: '#22c55e' },
  FAILED:      { label: 'Failed',      color: '#C8102E', bg: 'rgba(200,16,46,0.12)',  dot: '#C8102E' },
  SKIPPED:     { label: 'Skipped',     color: '#555',    bg: 'rgba(85,85,85,0.1)',    dot: '#555' },
  EXPIRED:     { label: 'Expired',     color: '#C8102E', bg: 'rgba(200,16,46,0.08)', dot: '#C8102E' },
}

const CATEGORY_ORDER = ['IDENTITY','PUBLISHING','DISTRIBUTION','ROYALTIES','SYNC','FINANCIAL','LEGAL','MARKETING']

function statusMeta(s: string) {
  return STATUS_META[s] ?? { label: s, color: '#888', bg: 'rgba(136,136,136,0.1)', dot: '#888' }
}

function formatDate(d: string | null) {
  if (!d) return null
  return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

function ProgressRing({ pct }: { pct: number }) {
  const r = 36
  const circ = 2 * Math.PI * r
  const dash = circ * (pct / 100)
  return (
    <svg width="88" height="88" style={{ transform: 'rotate(-90deg)' }}>
      <circle cx="44" cy="44" r={r} fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth="6" />
      <circle cx="44" cy="44" r={r} fill="none" stroke="#C8102E" strokeWidth="6" strokeLinecap="round"
        strokeDasharray={`${dash} ${circ}`} style={{ transition: 'stroke-dasharray 0.6s ease' }} />
    </svg>
  )
}

export default function ArtistPortal() {
  const [rows, setRows] = useState<RegistrationRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [updating, setUpdating] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [activeCategory, setActiveCategory] = useState<string>('ALL')
  const [toast, setToast] = useState<{ msg: string; ok: boolean } | null>(null)

  const ARTIST_ID = '3d4788b6-2a86-4ed5-8f27-ab95b3a230d3'

  const showToast = (msg: string, ok: boolean) => {
    setToast({ msg, ok })
    setTimeout(() => setToast(null), 3500)
  }

  const load = useCallback(async () => {
    setLoading(true)
    const { data, error: err } = await supabase
      .from('v_artist_dashboard')
      .select('*')
      .eq('artist_id', ARTIST_ID)
      .order('portal_sort_order', { ascending: true, nullsFirst: false })
    if (err) { setError(err.message); setLoading(false); return }
    setRows((data as RegistrationRow[]) ?? [])
    setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])

  const markComplete = async (reg: RegistrationRow) => {
    setUpdating(reg.registration_id)
    const { error: err } = await supabase.rpc('fn_update_registration_status_v1', {
      p_registration_id: reg.registration_id,
      p_status: 'SUBMITTED',
      p_n8n_execution_id: null,
      p_external_id: null,
      p_external_status: null,
      p_last_error: null,
    })
    setUpdating(null)
    if (err) { showToast(`Error: ${err.message}`, false) }
    else { showToast(`${reg.display_name} marked complete.`, true); load() }
  }

  const categories = ['ALL', ...CATEGORY_ORDER.filter(c => rows.some(r => r.registration_category === c))]
  const filtered = activeCategory === 'ALL' ? rows : rows.filter(r => r.registration_category === activeCategory)
  const totalActive = rows.filter(r => r.status === 'ACTIVE').length
  const totalDone = rows.filter(r => ['ACTIVE','SUBMITTED'].includes(r.status)).length
  const pct = rows.length ? Math.round((totalDone / rows.length) * 100) : 0
  const needsAction = rows.filter(r => r.requires_human && !['ACTIVE','SUBMITTED','SKIPPED'].includes(r.status)).length

  return (
    <>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Bebas+Neue&family=DM+Mono:wght@400;500&family=DM+Sans:wght@300;400;500&display=swap');
        *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
        body{background:#080808;color:#e8e8e8;font-family:'DM Sans',sans-serif;min-height:100vh}
        .portal-root{min-height:100vh;background:#080808}
        .portal-header{background:#0c0c0c;border-bottom:1px solid rgba(200,16,46,0.2);padding:0 32px;height:60px;display:flex;align-items:center;justify-content:space-between;position:sticky;top:0;z-index:50}
        .portal-logo{font-family:'Bebas Neue',sans-serif;font-size:22px;letter-spacing:0.12em;color:#fff}
        .portal-logo span{color:#C8102E}
        .portal-badge{font-family:'DM Mono',monospace;font-size:11px;color:#555;letter-spacing:0.08em}
        .stats-bar{background:linear-gradient(135deg,#0f0f0f 0%,#111 100%);border-bottom:1px solid rgba(255,255,255,0.05);padding:28px 32px;display:flex;align-items:center;gap:40px}
        .stats-ring-wrap{position:relative;width:88px;height:88px;flex-shrink:0}
        .stats-ring-label{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center}
        .stats-ring-pct{font-family:'Bebas Neue',sans-serif;font-size:26px;line-height:1;color:#fff}
        .stats-ring-sub{font-family:'DM Mono',monospace;font-size:9px;color:#555;letter-spacing:0.06em}
        .stats-grid{display:flex;gap:32px;flex-wrap:wrap}
        .stat-num{font-family:'Bebas Neue',sans-serif;font-size:32px;line-height:1;color:#fff}
        .stat-num.red{color:#C8102E}
        .stat-label{font-family:'DM Mono',monospace;font-size:10px;color:#555;letter-spacing:0.08em;margin-top:2px}
        .stats-artist{margin-left:auto;text-align:right}
        .stats-artist-name{font-family:'Bebas Neue',sans-serif;font-size:20px;letter-spacing:0.1em;color:#fff}
        .stats-artist-tier{font-family:'DM Mono',monospace;font-size:10px;color:#C8102E;letter-spacing:0.12em;margin-top:2px}
        .action-banner{background:rgba(200,16,46,0.08);border-bottom:1px solid rgba(200,16,46,0.3);padding:10px 32px;display:flex;align-items:center;gap:10px;font-family:'DM Mono',monospace;font-size:11px;color:#C8102E;letter-spacing:0.06em}
        .action-dot{width:6px;height:6px;border-radius:50%;background:#C8102E;animation:pulse 1.4s ease-in-out infinite}
        @keyframes pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:0.5;transform:scale(1.4)}}
        .cat-tabs{padding:16px 32px 0;display:flex;gap:4px;flex-wrap:wrap;border-bottom:1px solid rgba(255,255,255,0.05);background:#0c0c0c}
        .cat-tab{font-family:'DM Mono',monospace;font-size:10px;letter-spacing:0.1em;padding:7px 14px;border:1px solid transparent;border-radius:3px 3px 0 0;cursor:pointer;color:#555;background:none;transition:color 0.15s,border-color 0.15s;border-bottom:none;position:relative;bottom:-1px}
        .cat-tab:hover{color:#aaa}
        .cat-tab.active{color:#fff;border-color:rgba(255,255,255,0.1);border-bottom-color:#0c0c0c;background:#0c0c0c}
        .cat-count{display:inline-block;margin-left:5px;font-size:9px;color:#C8102E}
        .portal-main{padding:24px 32px;max-width:1100px}
        .reg-card{background:#0e0e0e;border:1px solid rgba(255,255,255,0.06);border-radius:6px;margin-bottom:8px;overflow:hidden;transition:border-color 0.2s}
        .reg-card:hover{border-color:rgba(255,255,255,0.12)}
        .reg-card.expanded{border-color:rgba(200,16,46,0.3)}
        .reg-card-header{display:flex;align-items:center;padding:14px 18px;cursor:pointer;gap:14px;user-select:none}
        .reg-sort{font-family:'DM Mono',monospace;font-size:11px;color:#333;width:24px;flex-shrink:0;text-align:right}
        .reg-status-dot{width:8px;height:8px;border-radius:50%;flex-shrink:0}
        .reg-name{font-family:'DM Sans',sans-serif;font-size:14px;font-weight:500;color:#e0e0e0;flex:1;min-width:0}
        .reg-category-tag{font-family:'DM Mono',monospace;font-size:9px;letter-spacing:0.1em;color:#444;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.06);padding:3px 7px;border-radius:3px;flex-shrink:0}
        .reg-status-badge{font-family:'DM Mono',monospace;font-size:10px;letter-spacing:0.08em;padding:4px 9px;border-radius:3px;flex-shrink:0}
        .reg-auto-tag{font-family:'DM Mono',monospace;font-size:9px;color:#3090f0;letter-spacing:0.06em;flex-shrink:0}
        .reg-time{font-family:'DM Mono',monospace;font-size:10px;color:#444;flex-shrink:0;white-space:nowrap}
        .reg-chevron{color:#333;flex-shrink:0;font-size:12px;transition:transform 0.2s}
        .reg-chevron.open{transform:rotate(180deg)}
        .reg-detail{border-top:1px solid rgba(255,255,255,0.05);padding:20px 56px;display:grid;grid-template-columns:1fr 260px;gap:24px}
        .detail-section-label{font-family:'DM Mono',monospace;font-size:9px;letter-spacing:0.14em;color:#444;margin-bottom:8px}
        .detail-instructions{font-family:'DM Sans',sans-serif;font-size:13px;color:#aaa;line-height:1.6;white-space:pre-wrap}
        .detail-docs{margin-top:16px}
        .doc-item{display:flex;align-items:center;gap:8px;font-family:'DM Mono',monospace;font-size:11px;color:#888;padding:5px 0;border-bottom:1px solid rgba(255,255,255,0.03)}
        .doc-item:last-child{border-bottom:none}
        .doc-bullet{width:4px;height:4px;border-radius:50%;background:#C8102E;flex-shrink:0}
        .sidebar-row{display:flex;justify-content:space-between;align-items:center;padding:7px 0;border-bottom:1px solid rgba(255,255,255,0.04)}
        .sidebar-row:last-child{border-bottom:none}
        .sidebar-key{font-family:'DM Mono',monospace;font-size:10px;color:#444;letter-spacing:0.06em}
        .sidebar-val{font-family:'DM Mono',monospace;font-size:10px;color:#888;text-align:right;max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
        .sidebar-val.green{color:#22c55e}
        .action-link{display:inline-flex;align-items:center;gap:5px;font-family:'DM Mono',monospace;font-size:10px;color:#3090f0;text-decoration:none;margin-top:4px}
        .action-link:hover{color:#60b0ff;text-decoration:underline}
        .detail-actions{margin-top:20px;display:flex;gap:10px;flex-wrap:wrap}
        .btn-complete{font-family:'DM Mono',monospace;font-size:11px;letter-spacing:0.08em;padding:10px 20px;background:#C8102E;color:#fff;border:none;border-radius:4px;cursor:pointer;transition:background 0.15s}
        .btn-complete:hover{background:#a00d25}
        .btn-complete:disabled{opacity:0.4;cursor:not-allowed}
        .btn-secondary{font-family:'DM Mono',monospace;font-size:11px;letter-spacing:0.08em;padding:10px 20px;background:none;color:#666;border:1px solid rgba(255,255,255,0.08);border-radius:4px;cursor:pointer;text-decoration:none;display:inline-flex;align-items:center;transition:color 0.15s,border-color 0.15s}
        .btn-secondary:hover{color:#aaa;border-color:rgba(255,255,255,0.18)}
        .error-box{margin-top:10px;background:rgba(200,16,46,0.08);border:1px solid rgba(200,16,46,0.2);border-radius:4px;padding:10px 14px;font-family:'DM Mono',monospace;font-size:11px;color:#C8102E;line-height:1.5}
        .loading-state{padding:60px 32px;text-align:center;font-family:'DM Mono',monospace;font-size:12px;color:#333;letter-spacing:0.1em}
        .loading-bar{width:200px;height:2px;background:rgba(200,16,46,0.15);margin:16px auto 0;border-radius:2px;overflow:hidden;position:relative}
        .loading-bar::after{content:'';position:absolute;left:-60%;width:60%;height:100%;background:#C8102E;animation:slide 1.2s ease-in-out infinite}
        @keyframes slide{0%{left:-60%}100%{left:110%}}
        .toast{position:fixed;bottom:28px;right:28px;font-family:'DM Mono',monospace;font-size:12px;padding:12px 20px;border-radius:5px;z-index:1000;animation:toastIn 0.25s ease}
        .toast.ok{background:#0e2e18;border:1px solid #22c55e;color:#22c55e}
        .toast.err{background:#2e0e12;border:1px solid #C8102E;color:#C8102E}
        @keyframes toastIn{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:translateY(0)}}
        @media(max-width:700px){.stats-bar{flex-wrap:wrap;padding:20px 16px;gap:20px}.stats-artist{margin-left:0;text-align:left;width:100%}.portal-main{padding:16px}.reg-detail{grid-template-columns:1fr}.cat-tabs{padding:12px 16px 0}.portal-header{padding:0 16px}}
      `}</style>

      <div className="portal-root">
        <header className="portal-header">
          <div className="portal-logo">MUSI<span>GOD</span></div>
          <div className="portal-badge">ARTIST PORTAL — ONBOARDING</div>
        </header>

        <div className="stats-bar">
          <div className="stats-ring-wrap">
            <ProgressRing pct={pct} />
            <div className="stats-ring-label">
              <div className="stats-ring-pct">{pct}%</div>
              <div className="stats-ring-sub">DONE</div>
            </div>
          </div>
          <div className="stats-grid">
            <div><div className="stat-num">{rows.length}</div><div className="stat-label">TOTAL REGISTRATIONS</div></div>
            <div><div className="stat-num" style={{color:'#22c55e'}}>{totalActive}</div><div className="stat-label">ACTIVE</div></div>
            <div><div className="stat-num red">{needsAction}</div><div className="stat-label">NEED YOUR ACTION</div></div>
            <div><div className="stat-num" style={{color:'#f0a020'}}>{rows.filter(r=>r.status==='IN_PROGRESS').length}</div><div className="stat-label">IN PROGRESS</div></div>
          </div>
          <div className="stats-artist">
            <div className="stats-artist-name">Naim Salaam</div>
            <div className="stats-artist-tier">GROWTH TIER — ACTIVE</div>
          </div>
        </div>

        {needsAction > 0 && (
          <div className="action-banner">
            <div className="action-dot" />
            {needsAction} registration{needsAction !== 1 ? 's' : ''} require{needsAction === 1 ? 's' : ''} your action — expand to view instructions
          </div>
        )}

        <div className="cat-tabs">
          {categories.map(cat => (
            <button key={cat} className={`cat-tab${activeCategory===cat?' active':''}`} onClick={()=>setActiveCategory(cat)}>
              {cat}<span className="cat-count">{cat==='ALL'?rows.length:rows.filter(r=>r.registration_category===cat).length}</span>
            </button>
          ))}
        </div>

        <main className="portal-main">
          {loading && <div className="loading-state">LOADING REGISTRATIONS<div className="loading-bar"/></div>}
          {!loading && error && <div className="error-box">Error: {error}</div>}
          {!loading && !error && filtered.length === 0 && <div className="loading-state">No registrations in this category.</div>}
          {!loading && !error && filtered.map(reg => {
            const meta = statusMeta(reg.status)
            const isExpanded = expanded === reg.registration_id
            const isUpdating = updating === reg.registration_id
            const canComplete = reg.requires_human && !['ACTIVE','SUBMITTED','SKIPPED'].includes(reg.status)
            return (
              <div key={reg.registration_id} className={`reg-card${isExpanded?' expanded':''}`}>
                <div className="reg-card-header" onClick={()=>setExpanded(isExpanded?null:reg.registration_id)}>
                  <span className="reg-sort">{reg.portal_sort_order??reg.sort_order??'—'}</span>
                  <span className="reg-status-dot" style={{background:meta.dot}}/>
                  <span className="reg-name">{reg.display_name}</span>
                  <span className="reg-category-tag">{reg.registration_category}</span>
                  {reg.is_automated && <span className="reg-auto-tag">AUTO</span>}
                  {reg.estimated_minutes && <span className="reg-time">~{reg.estimated_minutes}m</span>}
                  <span className="reg-status-badge" style={{color:meta.color,background:meta.bg}}>{meta.label}</span>
                  <span className={`reg-chevron${isExpanded?' open':''}`}>▼</span>
                </div>
                {isExpanded && (
                  <div className="reg-detail">
                    <div>
                      {reg.instructions && <><div className="detail-section-label">INSTRUCTIONS</div><div className="detail-instructions">{reg.instructions}</div></>}
                      {reg.documents_needed && reg.documents_needed.length > 0 && (
                        <div className="detail-docs">
                          <div className="detail-section-label" style={{marginTop:reg.instructions?20:0}}>DOCUMENTS NEEDED</div>
                          {reg.documents_needed.map((doc,i)=><div className="doc-item" key={i}><span className="doc-bullet"/>{doc}</div>)}
                        </div>
                      )}
                      {reg.awaiting_action && (
                        <div style={{marginTop:16}}>
                          <div className="detail-section-label">ACTION REQUIRED</div>
                          <div style={{fontFamily:'DM Mono',fontSize:12,color:'#f0a020',lineHeight:1.5}}>{reg.awaiting_action}</div>
                          {reg.action_url && <a href={reg.action_url} target="_blank" rel="noopener noreferrer" className="action-link">↗ Open Link</a>}
                        </div>
                      )}
                      {reg.last_error && (
                        <div className="error-box" style={{marginTop:16}}>
                          <strong>Last Error:</strong> {reg.last_error}{reg.error_count>1&&` (${reg.error_count} occurrences)`}
                        </div>
                      )}
                      <div className="detail-actions">
                        {canComplete && <button className="btn-complete" disabled={isUpdating} onClick={()=>markComplete(reg)}>{isUpdating?'UPDATING...':'MARK COMPLETE'}</button>}
                        {reg.action_url && <a href={reg.action_url} target="_blank" rel="noopener noreferrer" className="btn-secondary">OPEN PORTAL ↗</a>}
                      </div>
                    </div>
                    <div className="detail-sidebar">
                      <div className="detail-section-label">REGISTRATION DETAILS</div>
                      <div className="sidebar-row"><span className="sidebar-key">TYPE</span><span className="sidebar-val">{reg.registration_type}</span></div>
                      <div className="sidebar-row"><span className="sidebar-key">ROUTING</span><span className="sidebar-val" style={{color:reg.is_automated?'#3090f0':'#f0a020'}}>{reg.is_automated?'AUTOMATED':'MANUAL'}</span></div>
                      {reg.territory && <div className="sidebar-row"><span className="sidebar-key">TERRITORY</span><span className="sidebar-val">{reg.territory}</span></div>}
                      {reg.submitted_at && <div className="sidebar-row"><span className="sidebar-key">SUBMITTED</span><span className="sidebar-val green">{formatDate(reg.submitted_at)}</span></div>}
                      {reg.activated_at && <div className="sidebar-row"><span className="sidebar-key">ACTIVATED</span><span className="sidebar-val green">{formatDate(reg.activated_at)}</span></div>}
                      {reg.attempts>0 && <div className="sidebar-row"><span className="sidebar-key">ATTEMPTS</span><span className="sidebar-val">{reg.attempts}</span></div>}
                      {reg.external_id && <div className="sidebar-row"><span className="sidebar-key">EXT ID</span><span className="sidebar-val">{reg.external_id}</span></div>}
                      {reg.assigned_to && <div className="sidebar-row"><span className="sidebar-key">ASSIGNED</span><span className="sidebar-val">{reg.assigned_to}</span></div>}
                      {reg.human_action_note && <div style={{marginTop:12,fontFamily:'DM Mono',fontSize:10,color:'#555',lineHeight:1.5}}>{reg.human_action_note}</div>}
                    </div>
                  </div>
                )}
              </div>
            )
          })}
        </main>
      </div>

      {toast && <div className={`toast ${toast.ok?'ok':'err'}`}>{toast.msg}</div>}
    </>
  )
}