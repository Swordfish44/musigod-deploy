'use strict';

const crypto = require('crypto');
const ingestion = require('./enterprise-ingestion');
const MAX_FILE_SIZE = 10 * 1024 * 1024;
const MAX_ROWS = 1000;
const ALLOWED_MIME_TYPES = new Set(['text/csv','application/csv','text/plain']);

function getRawBody(req, maxBytes = MAX_FILE_SIZE + 65536) {
  return new Promise((resolve, reject) => {
    const chunks = []; let total = 0; let failed = false;
    req.on('data', chunk => { total += chunk.length; if (total > maxBytes) { failed = true; reject(new Error('File exceeds 10MB limit')); req.destroy(); return; } chunks.push(chunk); });
    req.on('end', () => { if (!failed) resolve(Buffer.concat(chunks)); }); req.on('error', reject);
  });
}

function parseMultipart(buffer, boundary) {
  const marker = Buffer.from(`--${boundary}`); const fields = {}; let file = null; let cursor = 0;
  while (cursor < buffer.length) {
    const start = buffer.indexOf(marker, cursor); if (start < 0) break;
    cursor = start + marker.length; if (buffer.slice(cursor, cursor + 2).toString() === '--') break;
    if (buffer.slice(cursor, cursor + 2).toString() === '\r\n') cursor += 2;
    const headerEnd = buffer.indexOf(Buffer.from('\r\n\r\n'), cursor); if (headerEnd < 0) break;
    const headers = buffer.slice(cursor, headerEnd).toString('utf8'); const next = buffer.indexOf(marker, headerEnd + 4);
    const dataEnd = next < 0 ? buffer.length : next - 2; const data = buffer.slice(headerEnd + 4, dataEnd); cursor = next < 0 ? buffer.length : next;
    const name = headers.match(/name="([^"]+)"/i)?.[1]; if (!name) continue;
    const filename = headers.match(/filename="([^"]*)"/i)?.[1];
    if (filename !== undefined) file = { filename, mimeType: headers.match(/Content-Type:\s*([^\r\n]+)/i)?.[1]?.trim() || 'application/octet-stream', data };
    else fields[name] = data.toString('utf8').trim();
  }
  return { fields, file };
}

function parseCsv(text) {
  if (text.includes('\0')) throw new Error('binary content is not allowed');
  const rows = []; let row = []; let field = ''; let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) { if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; } else if (ch === '"') quoted = false; else field += ch; }
    else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n') { row.push(field.replace(/\r$/, '')); rows.push(row); row = []; field = ''; }
    else field += ch;
  }
  if (quoted) throw new Error('CSV contains an unclosed quoted field');
  if (field || row.length) { row.push(field.replace(/\r$/, '')); rows.push(row); }
  return rows.filter(r => r.some(v => v.trim() !== ''));
}

function buildPreview(file, recordType, context = {}) {
  if (!file || !file.data?.length) throw new Error('CSV file is required');
  if (!ALLOWED_MIME_TYPES.has(file.mimeType)) throw new Error('only CSV text files are allowed');
  if (file.data.length > MAX_FILE_SIZE) throw new Error('File exceeds 10MB limit');
  if (!/\.csv$/i.test(file.filename)) throw new Error('filename must end in .csv');
  const rows = parseCsv(file.data.toString('utf8').replace(/^\uFEFF/, ''));
  if (rows.length < 2) throw new Error('CSV must contain a header and at least one data row');
  const headers = rows[0].map(h => h.trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_|_$/g, ''));
  if (headers.some((h, i) => !h || headers.indexOf(h) !== i)) throw new Error('CSV headers must be non-empty and unique');
  const dataRows = rows.slice(1); if (dataRows.length > MAX_ROWS) throw new Error(`pilot uploads are limited to ${MAX_ROWS} rows`);
  const records = dataRows.map((values, index) => {
    if (values.length !== headers.length) throw new Error(`row ${index + 2} has ${values.length} fields; expected ${headers.length}`);
    const source = Object.fromEntries(headers.map((header, i) => [header, values[i].trim()]));
    const normalized = ingestion.normalizeEnterpriseRecord(recordType, source, { source_name: context.source_name, source_record_id: source.source_record_id || null, imported_at: context.imported_at });
    return { source_record_id: source.source_record_id || null, ...normalized };
  });
  return { filename: file.filename.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120), mime_type: file.mimeType, file_size_bytes: file.data.length, content_sha256: crypto.createHash('sha256').update(file.data).digest('hex'), row_count: records.length, headers, records, preview: records.slice(0, 20).map((r, i) => ({ row_number: i + 1, ...r.normalized_payload })) };
}

module.exports = { MAX_FILE_SIZE, MAX_ROWS, ALLOWED_MIME_TYPES, getRawBody, parseMultipart, parseCsv, buildPreview };
