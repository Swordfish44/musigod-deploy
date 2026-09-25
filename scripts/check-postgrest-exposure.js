#!/usr/bin/env node
'use strict'

// Live, read-only probe: does PostgREST actually serve the schemas the
// registration -> checkout path needs? Catches the case where the dashboard
// "Exposed schemas" list and the running Data API disagree (PGRST106).
//
// Usage: SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/check-postgrest-exposure.js
// Exit 0 = all required schemas served; exit 1 = at least one rejected.

const SB_URL = process.env.SUPABASE_URL || 'https://uykzkrnoetcldeuxzqyy.supabase.co'
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY
const CHECKS = [
  { schema: 'artists', table: 'artists_v1' },
  { schema: 'registrations', table: 'registrations_v1' },
]

async function main() {
  if (!SB_KEY) throw new Error('SUPABASE_SERVICE_ROLE_KEY is required')
  let failed = 0
  for (const { schema, table } of CHECKS) {
    const res = await fetch(`${SB_URL}/rest/v1/${table}?select=id&limit=1`, {
      headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Accept-Profile': schema },
    })
    const text = await res.text()
    let detail = ''
    try { const j = JSON.parse(text); detail = j.code ? `${j.code} ${j.message} ${j.hint || ''}` : '' } catch {}
    const ok = res.ok
    if (!ok) failed++
    console.log(`${ok ? 'PASS' : 'FAIL'} ${schema}.${table} -> ${res.status} ${detail}`.trim())
  }
  process.exit(failed ? 1 : 0)
}

main().catch(err => { console.error(err.message); process.exit(1) })
