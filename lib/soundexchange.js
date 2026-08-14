'use strict';
// lib/soundexchange.js
//
// Thin compatibility shim — re-exports scanSoundExchange from the
// feature-flagged adapter. Callers (lib/scanner.js) are unchanged.
//
// The prior implementation called wp-admin/admin-ajax.php, a WordPress
// internal AJAX endpoint not authorized for programmatic access. That
// call has been removed. See lib/soundexchange-adapter.js for the
// authorized architecture and feature-flag documentation.

const { scanSoundExchange } = require('./soundexchange-adapter');

module.exports = { scanSoundExchange };
