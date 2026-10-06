'use strict'

const assert = require('assert')
const fs = require('fs')
const path = require('path')

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8')
const handlerStart = html.indexOf('async function handleSubmit(e)')
const handlerEnd = html.indexOf("document.querySelectorAll('#contact", handlerStart)
assert(handlerStart >= 0 && handlerEnd > handlerStart, 'homepage contact handler must exist')
const handler = html.slice(handlerStart, handlerEnd)

assert(handler.includes("fetch('/api/register-artist'"), 'homepage signup must use the guarded registration API')
assert(handler.includes("body.status !== 'PENDING_CHECKOUT'"), 'homepage must fail closed unless registration is pending checkout')
assert(handler.includes('/checkout.html?artist_id='), 'successful registration must continue to controlled checkout')
assert(!handler.includes('SUPABASE_ANON'), 'browser must not carry a Supabase key')
assert(!handler.includes('/rest/v1/'), 'browser must not write directly to PostgREST')
assert(!handler.includes("plan_status:      'ACTIVE'"), 'homepage must never self-activate an artist')

console.log('homepage contact registration: server-side guarded registration and checkout routing passed')
