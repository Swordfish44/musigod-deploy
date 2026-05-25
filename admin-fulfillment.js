(function(){
  const savedKey = localStorage.getItem('musigod_admin_key') || ''
  document.getElementById('admin-key').value = savedKey
  document.getElementById('search').addEventListener('keydown', event => { if(event.key === 'Enter') loadFulfillment() })
  window.loadFulfillment = loadFulfillment

  async function loadFulfillment(){
    const key = document.getElementById('admin-key').value.trim()
    const q = document.getElementById('search').value.trim()
    const status = document.getElementById('status').value
    if(key) localStorage.setItem('musigod_admin_key', key)
    const rows = document.getElementById('rows')
    rows.innerHTML = '<tr><td colspan="6">Loading fulfillment jobs...</td></tr>'
    try{
      const url = '/api/admin-fulfillment?q=' + encodeURIComponent(q) + '&status=' + encodeURIComponent(status)
      const res = await fetch(url, { headers: { 'X-Admin-Key': key } })
      const body = await res.json().catch(()=>({}))
      if(!res.ok) throw new Error(body.error || `HTTP ${res.status}`)
      renderMetrics(body.summary || {})
      renderRows(body.jobs || [])
      renderEvents(body.events || [])
    }catch(err){
      rows.innerHTML = `<tr><td colspan="6">${esc(err.message || 'Unable to load fulfillment jobs')}</td></tr>`
    }
  }

  function renderMetrics(summary){
    const nums = document.querySelectorAll('#metrics strong')
    nums[0].textContent = summary.total ?? 0
    nums[1].textContent = summary.active ?? 0
    nums[2].textContent = summary.failed ?? 0
    nums[3].textContent = summary.retrying ?? 0
    nums[4].textContent = summary.completed ?? 0
  }

  function renderRows(jobs){
    const rows = document.getElementById('rows')
    if(!jobs.length){
      rows.innerHTML = '<tr><td colspan="6">No fulfillment jobs found.</td></tr>'
      return
    }
    rows.innerHTML = jobs.map(job => `
      <tr>
        <td><strong>${esc(job.audit_id)}</strong><div class="muted">${esc(job.stripe_session_id || '')}</div></td>
        <td>${esc(job.email || '')}</td>
        <td><span class="status ${statusClass(job.current_status)}">${esc(job.current_status)}</span></td>
        <td>${esc(job.status_message || '')}${job.last_error ? `<div class="bad status">${esc(job.last_error)}</div>` : ''}</td>
        <td><div>Retries: ${Number(job.n8n_retry_count || 0)}</div><div class="muted">${esc(job.estimated_completion || '')}</div></td>
        <td>${job.updated_at ? esc(new Date(job.updated_at).toLocaleString()) : ''}</td>
      </tr>
    `).join('')
  }

  function renderEvents(events){
    const el = document.getElementById('events')
    if(!events.length){
      el.textContent = 'Search by audit ID to load recent events.'
      return
    }
    el.innerHTML = events.map(event => `<div class="event">${esc(event.created_at ? new Date(event.created_at).toLocaleString() : '')} · ${esc(event.source_system)} · ${esc(event.severity)} · ${esc(event.event_type)}</div>`).join('')
  }

  function statusClass(status){
    if(status === 'COMPLETED') return 'ok'
    if(status === 'ACTION_REQUIRED' || status === 'FAILED_RETRYING') return 'bad'
    return 'warn'
  }

  function esc(value){
    return String(value || '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]))
  }
})()
