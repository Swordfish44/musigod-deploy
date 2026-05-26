(function(){
  const params = new URLSearchParams(window.location.search)
  const auditId = (params.get('id') || params.get('audit_id') || '').trim()
  const els = {
    card: document.getElementById('status-card'),
    title: document.getElementById('status-title'),
    message: document.getElementById('status-message'),
    progress: document.getElementById('progress-fill'),
    pulse: document.getElementById('pulse'),
    auditId: document.getElementById('audit-id'),
    paid: document.getElementById('paid-status'),
    estimate: document.getElementById('estimate'),
    latest: document.getElementById('latest-update'),
    events: document.getElementById('event-list'),
    poll: document.getElementById('poll-state'),
  }

  if(!auditId){
    renderFallback('Audit ID missing', 'Use the status link from your MusiGod email or contact support with your payment receipt.')
    return
  }

  els.auditId.textContent = auditId
  loadStatus()
  setInterval(loadStatus, 10000)

  async function loadStatus(){
    els.poll.textContent = 'Refreshing...'
    try{
      const res = await fetch('/api/get-audit-status?id=' + encodeURIComponent(auditId), { credentials: 'same-origin' })
      const body = await res.json().catch(()=>({}))
      if(!res.ok && !body.status) throw new Error(body.error || 'Status unavailable')
      renderStatus(body.status, body.events || [])
      els.poll.textContent = 'Polling every 10 seconds'
    }catch(err){
      renderFallback('Status still syncing', 'We received your payment, but your audit status is still syncing. Check your email for confirmation. Contact support with your payment email if this does not update shortly.')
      els.poll.textContent = 'Retrying every 10 seconds'
    }
  }

  function renderStatus(status, events){
    const current = status.current_status || 'ACTION_REQUIRED'
    els.card.classList.toggle('soft-error', current === 'ACTION_REQUIRED' || current === 'FAILED_RETRYING')
    els.title.textContent = titleFor(current)
    els.message.textContent = status.status_message || 'MusiGod is processing your audit status.'
    els.auditId.textContent = status.audit_id || auditId
    els.paid.textContent = status.paid_status || 'UNKNOWN'
    els.estimate.textContent = status.estimated_completion || 'Most paid audits begin review within 1 business day.'
    els.latest.textContent = status.updated_at ? new Date(status.updated_at).toLocaleString() : new Date().toLocaleString()
    els.progress.style.width = progressFor(current) + '%'
    els.progress.classList.toggle('complete', current === 'COMPLETED')
    els.pulse.className = 'pulse' + (current === 'COMPLETED' ? ' complete' : current === 'ACTION_REQUIRED' || current === 'FAILED_RETRYING' ? ' error' : '')
    renderEvents(events)
  }

  function renderEvents(events){
    if(!events.length){
      els.events.textContent = 'No detailed events yet. This page will update automatically.'
      return
    }
    els.events.innerHTML = events.map(event => `
      <div class="event">
        <div>
          <div class="event-type">${esc(event.event_type || 'update')}</div>
          <div>${esc(event.source_system || 'fulfillment')} · ${esc(event.severity || 'info')}</div>
        </div>
        <div class="event-time">${event.created_at ? esc(new Date(event.created_at).toLocaleString()) : ''}</div>
      </div>
    `).join('')
  }

  function renderFallback(title, message){
    els.card.classList.add('soft-error')
    els.title.textContent = title
    els.message.textContent = message
    els.paid.textContent = 'UNKNOWN'
    els.estimate.textContent = 'Support can confirm manually.'
    els.latest.textContent = new Date().toLocaleString()
    els.progress.style.width = '15%'
    els.pulse.className = 'pulse error'
    els.events.textContent = 'No status events loaded.'
  }

  function titleFor(status){
    return ({
      PENDING_PAYMENT: 'Waiting for payment',
      PAID: 'Payment confirmed',
      FULFILLMENT_QUEUED: 'Fulfillment queued',
      PROCESSING: 'Review in progress',
      COMPLETED: 'Fulfillment complete',
      FAILED_RETRYING: 'Retrying fulfillment',
      ACTION_REQUIRED: 'MusiGod action required',
    })[status] || 'Status update'
  }

  function progressFor(status){
    return ({
      PENDING_PAYMENT: 15,
      PAID: 35,
      FULFILLMENT_QUEUED: 50,
      PROCESSING: 72,
      COMPLETED: 100,
      FAILED_RETRYING: 62,
      ACTION_REQUIRED: 62,
    })[status] || 20
  }

  function esc(value){
    return String(value || '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]))
  }
})()
