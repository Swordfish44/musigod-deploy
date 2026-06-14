const { captureException, withSentry } = require('./_sentry')

const SB_URL = process.env.SUPABASE_URL || 'https://uykzkrnoetcldeuxzqyy.supabase.co'
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY
const ADMIN_API_KEY = process.env.ADMIN_API_KEY

const ALLOWED_MIME_TYPES = new Set([
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/jpg',
  'text/csv',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
])

const ALLOWED_DOCUMENT_TYPES = new Set([
  'PRO_STATEMENT','DISTRIBUTOR_STATEMENT','PUBLISHING_AGREEMENT',
  'LABEL_AGREEMENT','SPLIT_SHEET','COPYRIGHT_REGISTRATION',
  'ISRC_UPC_METADATA','PHOTO_ID','LLC_DOCUMENT','TAX_DOCUMENT','OTHER',
])

const MAX_FILE_SIZE = 10 * 1024 * 1024 // 10MB

module.exports = withSentry(async function handler(req, res) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })
  if (!SB_KEY) return res.status(500).json({ error: 'Supabase service key not configured' })

  try {
    // Parse multipart form data manually
    const contentType = req.headers['content-type'] || ''
    if (!contentType.includes('multipart/form-data')) {
      return res.status(400).json({ error: 'Content-Type must be multipart/form-data' })
    }

    const boundary = contentType.split('boundary=')[1]?.trim()
    if (!boundary) return res.status(400).json({ error: 'Missing multipart boundary' })

    const rawBody = await getRawBody(req, MAX_FILE_SIZE)
    const { fields, file } = parseMultipart(rawBody, boundary)

    const artist_email = clean(fields.artist_email)
    const artist_id    = clean(fields.artist_id) || null
    const audit_id     = clean(fields.audit_id) || null
    const recovery_case_id = clean(fields.recovery_case_id) || null
    const document_type = clean(fields.document_type)

    // Validate
    if (!artist_email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(artist_email)) {
      return res.status(400).json({ error: 'Valid artist_email is required' })
    }
    if (!document_type || !ALLOWED_DOCUMENT_TYPES.has(document_type)) {
      return res.status(400).json({ error: `document_type must be one of: ${[...ALLOWED_DOCUMENT_TYPES].join(', ')}` })
    }
    if (!file) {
      return res.status(400).json({ error: 'File is required' })
    }
    if (!ALLOWED_MIME_TYPES.has(file.mimeType)) {
      return res.status(400).json({ error: `File type not allowed: ${file.mimeType}` })
    }
    if (file.data.length > MAX_FILE_SIZE) {
      return res.status(400).json({ error: 'File exceeds 10MB limit' })
    }

    // Build storage path
    const date = new Date().toISOString().slice(0, 10)
    const ts = Date.now()
    const safeName = file.filename.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 100)
    const normalizedEmail = artist_email.toLowerCase().replace(/[^a-z0-9._-]/g, '_')
    const filePath = `${normalizedEmail}/${date}/${ts}-${safeName}`

    // Upload to Supabase storage
    const uploadRes = await fetch(
      `${SB_URL}/storage/v1/object/artist-documents/${filePath}`,
      {
        method: 'POST',
        headers: {
          apikey: SB_KEY,
          Authorization: `Bearer ${SB_KEY}`,
          'Content-Type': file.mimeType,
          'x-upsert': 'false',
        },
        body: file.data,
      }
    )

    if (!uploadRes.ok) {
      const uploadErr = await uploadRes.text()
      console.error('Storage upload failed:', uploadRes.status, uploadErr)
      return res.status(500).json({ error: 'File upload failed' })
    }

    // Insert document record
    const docRows = await sbFetch('artist_documents_v1', 'registrations', {
      method: 'POST',
      prefer: 'return=representation',
      body: {
        artist_id:        artist_id || null,
        artist_email,
        audit_id:         audit_id || null,
        recovery_case_id: recovery_case_id || null,
        document_type,
        file_name:        file.filename,
        file_path:        filePath,
        storage_bucket:   'artist-documents',
        mime_type:        file.mimeType,
        file_size_bytes:  file.data.length,
        status:           'UPLOADED',
      },
    })

    const document_id = docRows?.[0]?.id

    // Log timeline event
    await sbRpc('fn_log_artist_activity_v1', 'registrations', {
      p_artist_email:     artist_email,
      p_event_type:       'DOCUMENT_UPLOADED',
      p_event_title:      `Document uploaded: ${document_type.replace(/_/g, ' ')}`,
      p_event_body:       `File: ${file.filename}`,
      p_artist_id:        artist_id || null,
      p_audit_id:         audit_id || null,
      p_recovery_case_id: recovery_case_id || null,
      p_visibility:       'BOTH',
      p_created_by:       'artist',
    })

    // Create admin queue task
    await sbRpc('fn_create_admin_queue_task_v1', 'registrations', {
      p_queue_name:       'DOCS_MISSING_QUEUE',
      p_artist_email:     artist_email,
      p_task_title:       `Review uploaded document: ${document_type.replace(/_/g, ' ')}`,
      p_task_body:        `Artist uploaded ${file.filename}. Review and classify.`,
      p_artist_id:        artist_id || null,
      p_audit_id:         audit_id || null,
      p_recovery_case_id: recovery_case_id || null,
      p_priority:         'NORMAL',
    })

    console.info(JSON.stringify({
      ts: new Date().toISOString(),
      event: 'DOCUMENT_UPLOADED',
      artist_email,
      document_type,
      file_path: filePath,
      document_id,
      file_size_bytes: file.data.length,
    }))

    return res.status(200).json({ ok: true, document_id, file_path: filePath })

  } catch (err) {
    console.error('upload-artist-document error:', err)
    captureException(err, { route: 'upload-artist-document' })
    return res.status(500).json({ error: 'Upload failed' })
  }
}, 'upload-artist-document')

// ---------------------------------------------------------------------------
// Multipart parser (no external deps)
// ---------------------------------------------------------------------------
function parseMultipart(buffer, boundary) {
  const boundaryBuf = Buffer.from('--' + boundary)
  const fields = {}
  let file = null

  let pos = 0
  while (pos < buffer.length) {
    const boundaryIdx = indexOf(buffer, boundaryBuf, pos)
    if (boundaryIdx === -1) break
    pos = boundaryIdx + boundaryBuf.length

    // Check for end boundary
    if (buffer[pos] === 0x2d && buffer[pos + 1] === 0x2d) break

    // Skip \r\n after boundary
    if (buffer[pos] === 0x0d && buffer[pos + 1] === 0x0a) pos += 2

    // Read headers
    const headerEnd = indexOf(buffer, Buffer.from('\r\n\r\n'), pos)
    if (headerEnd === -1) break
    const headerStr = buffer.slice(pos, headerEnd).toString('utf8')
    pos = headerEnd + 4

    // Find next boundary
    const nextBoundary = indexOf(buffer, boundaryBuf, pos)
    const contentEnd = nextBoundary === -1 ? buffer.length : nextBoundary - 2 // strip \r\n

    const content = buffer.slice(pos, contentEnd)
    pos = nextBoundary === -1 ? buffer.length : nextBoundary

    // Parse Content-Disposition
    const dispMatch = headerStr.match(/Content-Disposition:[^\r\n]*/i)
    if (!dispMatch) continue
    const disp = dispMatch[0]

    const nameMatch = disp.match(/name="([^"]*)"/)
    const filenameMatch = disp.match(/filename="([^"]*)"/)

    if (!nameMatch) continue
    const fieldName = nameMatch[1]

    if (filenameMatch) {
      const ctMatch = headerStr.match(/Content-Type:\s*([^\r\n]+)/i)
      file = {
        filename: filenameMatch[1],
        mimeType: ctMatch ? ctMatch[1].trim() : 'application/octet-stream',
        data: content,
      }
    } else {
      fields[fieldName] = content.toString('utf8')
    }
  }

  return { fields, file }
}

function indexOf(buf, search, start = 0) {
  for (let i = start; i <= buf.length - search.length; i++) {
    let found = true
    for (let j = 0; j < search.length; j++) {
      if (buf[i + j] !== search[j]) { found = false; break }
    }
    if (found) return i
  }
  return -1
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
async function sbFetch(path, schema, options = {}) {
  const headers = {
    apikey: SB_KEY,
    Authorization: `Bearer ${SB_KEY}`,
    'Accept-Profile': schema,
  }
  if (options.body) {
    headers['Content-Type'] = 'application/json'
    headers['Content-Profile'] = schema
  }
  if (options.prefer) headers.Prefer = options.prefer

  const res = await fetch(`${SB_URL}/rest/v1/${path}`, {
    method: options.method || 'GET',
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`Supabase ${options.method || 'GET'} ${path} failed: ${res.status} ${text}`)
  return text ? JSON.parse(text) : null
}

async function sbRpc(fn, schema, params) {
  const res = await fetch(`${SB_URL}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: {
      apikey: SB_KEY,
      Authorization: `Bearer ${SB_KEY}`,
      'Content-Type': 'application/json',
      'Content-Profile': schema,
    },
    body: JSON.stringify(params),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`RPC ${fn} failed: ${res.status} ${text}`)
  return text ? JSON.parse(text) : null
}

function getRawBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let total = 0
    req.on('data', chunk => {
      total += chunk.length
      if (total > maxBytes) return reject(new Error('File too large'))
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

function clean(v) { return String(v || '').trim() }

function setCors(req, res) {
  const origin = req.headers.origin || ''
  const allowed = new Set(['https://musigod.com', 'https://www.musigod.com'])
  res.setHeader('Access-Control-Allow-Origin', allowed.has(origin) ? origin : 'https://musigod.com')
  res.setHeader('Vary', 'Origin')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-key')
}
