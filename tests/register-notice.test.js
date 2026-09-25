'use strict'
// Paid / already-registered answers show as a normal notice, never "Error:".
const assert = require('assert')
const fs = require('fs')
const html = fs.readFileSync(require('path').join(__dirname, '..', 'register.html'), 'utf8')
assert(/NOTICE_CODES\s*=\s*\{[^}]*PAID_AWAITING_AGREEMENT/.test(html))
assert(/NOTICE_CODES\[regBody\.code\]\)\s*\{\s*toast\(regBody\.error,\s*false/.test(html), 'notice uses non-error toast')
assert(html.indexOf('NOTICE_CODES[regBody.code]') < html.indexOf("throw new Error(regBody.error || `Registration failed"), 'notice handled before error path')
console.log('register notice tests passed')
