'use strict';
// lib/soundexchange-adapter.js
//
// SoundExchange Repertoire Search Adapter — feature-flagged
//
// ── Official API status (as of 2026-07-29) ──────────────────────────────────
//
// SoundExchange does not publish a documented REST API for third-party
// programmatic access. The authorized data paths are:
//
//   1. CSV/XLSX import (AUTHORIZED — available now):
//      Export catalog, statements, or unclaimed results from SoundExchange
//      Direct (SXDirect) and import via lib/neighboring-rights-audit.js.
//      This is the only currently authorized data path.
//
//   2. Removed (was UNAUTHORIZED):
//      The prior lib/soundexchange.js called wp-admin/admin-ajax.php —
//      a WordPress internal AJAX endpoint, not an official API. That call
//      is not used in this adapter.
//
//   3. Future authorized API (this adapter, pending credentials):
//      SoundExchange has business data-exchange programs for distributors,
//      labels, and administrator partners. When MusiGod is granted API
//      access under such an agreement, set SOUNDEXCHANGE_API_ENABLED=true
//      and supply credentials. This adapter will route to the official
//      endpoint without any code change.
//
// ── Feature flag ─────────────────────────────────────────────────────────────
//
//   SOUNDEXCHANGE_API_ENABLED=true     — enable live API mode
//   SOUNDEXCHANGE_CLIENT_ID=...        — OAuth2 client ID (when enabled)
//   SOUNDEXCHANGE_CLIENT_SECRET=...    — OAuth2 client secret (when enabled)
//   SOUNDEXCHANGE_API_BASE_URL=...     — override base URL (optional)
//
// ── Modes ─────────────────────────────────────────────────────────────────────
//
//   disabled  SOUNDEXCHANGE_API_ENABLED not set or !== 'true'
//             All live methods return FEATURE_DISABLED. CSV import always works.
//
//   live      SOUNDEXCHANGE_API_ENABLED=true + credentials present
//             Routes to the official API endpoint.
//
//   mock      Pass { mock: true } to constructor
//             Returns synthetic fixtures. No network calls. Safe for tests.

const { validateImport, normalizeISRC } = require('./neighboring-rights-audit');

// ── Mock fixtures ─────────────────────────────────────────────────────────────
// Synthetic only — never contains real artist data, amounts, or account info.

const MOCK_REPERTOIRE_RESULTS = [
  {
    isrc: 'USASN0802524',
    title: 'Mock Track Alpha',
    artist_name: 'Mock Artist',
    album_title: 'Mock Album One',
    release_year: 2008,
    label: 'Mock Label',
    registration_status: 'registered',
    source: 'mock',
  },
  {
    isrc: 'USASN0900001',
    title: 'Mock Track Beta',
    artist_name: 'Mock Artist',
    album_title: 'Mock Album Two',
    release_year: 2009,
    label: 'Mock Label',
    registration_status: 'unregistered',
    source: 'mock',
  },
];

// ── Status codes ──────────────────────────────────────────────────────────────

const STATUS = {
  FEATURE_DISABLED:       'FEATURE_DISABLED',
  CREDENTIALS_MISSING:    'CREDENTIALS_MISSING',
  MOCK:                   'MOCK',
  LIVE:                   'LIVE',
  ERROR:                  'ERROR',
};

// ── Adapter class ─────────────────────────────────────────────────────────────

class SoundExchangeAdapter {
  // options.mock — force mock mode (for tests)
  // options.env  — override process.env (for tests: pass { SOUNDEXCHANGE_API_ENABLED: 'true', ... })
  constructor(options = {}) {
    this._mock = Boolean(options.mock);
    this._env  = options.env || process.env;
  }

  // ── Feature flag state ──────────────────────────────────────────────────────

  _isEnabled() {
    return this._env.SOUNDEXCHANGE_API_ENABLED === 'true';
  }

  _hasCredentials() {
    return Boolean(this._env.SOUNDEXCHANGE_CLIENT_ID && this._env.SOUNDEXCHANGE_CLIENT_SECRET);
  }

  _baseUrl() {
    // Placeholder — to be replaced with the actual SoundExchange API base URL
    // when official access is granted.
    return this._env.SOUNDEXCHANGE_API_BASE_URL || 'https://api.soundexchange.com';
  }

  // Returns the current operational status of the adapter.
  // Callers should check this before attempting live queries.
  getStatus() {
    if (this._mock) {
      return {
        mode: STATUS.MOCK,
        enabled: false,
        credentialsPresent: false,
        apiBaseUrl: null,
        note: 'Mock mode — synthetic fixtures only. No network calls.',
      };
    }
    if (!this._isEnabled()) {
      return {
        mode: STATUS.FEATURE_DISABLED,
        enabled: false,
        credentialsPresent: this._hasCredentials(),
        apiBaseUrl: null,
        note: 'Set SOUNDEXCHANGE_API_ENABLED=true and provide credentials to enable live mode. Use CSV import path for authorized data access.',
      };
    }
    if (!this._hasCredentials()) {
      return {
        mode: STATUS.CREDENTIALS_MISSING,
        enabled: true,
        credentialsPresent: false,
        apiBaseUrl: this._baseUrl(),
        note: 'Feature enabled but SOUNDEXCHANGE_CLIENT_ID or SOUNDEXCHANGE_CLIENT_SECRET is missing.',
      };
    }
    return {
      mode: STATUS.LIVE,
      enabled: true,
      credentialsPresent: true,
      apiBaseUrl: this._baseUrl(),
      note: 'Live mode. Requires valid API credentials from SoundExchange data-exchange program.',
    };
  }

  // ── Repertoire search ───────────────────────────────────────────────────────

  // Search the SoundExchange repertoire by artist name.
  // Returns { status, results: [...], manualUrl, note }
  async searchRepertoire(artistName) {
    if (!artistName || typeof artistName !== 'string') {
      return this._featureDisabledResult(artistName, 'artistName is required');
    }
    const name = artistName.trim();
    const encoded = encodeURIComponent(name);
    const manualUrl = `https://www.soundexchange.com/artist-search/?query=${encoded}`;

    if (this._mock) {
      const results = MOCK_REPERTOIRE_RESULTS.filter(
        r => r.artist_name.toLowerCase().includes(name.toLowerCase())
          || name.toLowerCase().includes('mock')
      );
      return {
        status: STATUS.MOCK,
        query: name,
        results,
        totalResults: results.length,
        manualUrl,
        note: 'Mock mode — synthetic results only',
        source: 'mock',
      };
    }

    const adapterStatus = this.getStatus();
    if (adapterStatus.mode !== STATUS.LIVE) {
      return this._featureDisabledResult(name, adapterStatus.note, manualUrl);
    }

    // Live path — only reached when SOUNDEXCHANGE_API_ENABLED=true + credentials present
    return this._liveRepertoireSearch(name, manualUrl);
  }

  // Look up a specific recording by ISRC.
  // Returns { status, isrc, result, manualUrl, note }
  async lookupByISRC(rawISRC) {
    const { normalized, valid, error } = normalizeISRC(rawISRC || '');
    if (!valid) {
      return {
        status: STATUS.ERROR,
        isrc: rawISRC,
        result: null,
        error: `Invalid ISRC: ${error}`,
        manualUrl: 'https://www.soundexchange.com/artist-search/',
        note: 'ISRC must be a valid 12-character identifier',
      };
    }

    const manualUrl = `https://www.soundexchange.com/artist-search/`;

    if (this._mock) {
      const result = MOCK_REPERTOIRE_RESULTS.find(r => {
        const { normalized: rNorm } = normalizeISRC(r.isrc || '');
        return rNorm === normalized;
      }) || null;
      return {
        status: STATUS.MOCK,
        isrc: normalized,
        result,
        found: result !== null,
        manualUrl,
        note: 'Mock mode — synthetic result only',
        source: 'mock',
      };
    }

    const adapterStatus = this.getStatus();
    if (adapterStatus.mode !== STATUS.LIVE) {
      return {
        status: adapterStatus.mode,
        isrc: normalized,
        result: null,
        found: null,
        manualUrl,
        note: adapterStatus.note,
      };
    }

    return this._liveISRCLookup(normalized, manualUrl);
  }

  // ── CSV/XLSX import (authorized path — always available) ─────────────────────

  // Validate a SoundExchange Direct catalog CSV export (before passing to the
  // neighboring-rights pipeline). This path is always available — it does not
  // require the feature flag or API credentials.
  validateCatalogImport(rows) {
    return validateImport(rows, 'soundexchange_catalog');
  }

  // Validate a SoundExchange Direct statement CSV export.
  // Private royalty and payment data always stays on this import path.
  // Never routes through any API — statement data is never sent over the network.
  validateStatementImport(rows) {
    return validateImport(rows, 'soundexchange_statement');
  }

  // Validate a SoundExchange search-and-claim / unclaimed export.
  validateUnclaimedImport(rows) {
    return validateImport(rows, 'soundexchange_unclaimed');
  }

  // ── Live API stubs (pending official credentials) ─────────────────────────
  // These stubs are called only when mode === LIVE.
  // They are placeholders for the actual API calls that will be implemented
  // once SoundExchange grants access under a data-exchange agreement.

  async _liveRepertoireSearch(artistName, manualUrl) {
    // TODO: implement using official SoundExchange API endpoint and OAuth2
    // token obtained from SOUNDEXCHANGE_CLIENT_ID / SOUNDEXCHANGE_CLIENT_SECRET.
    // This stub prevents a partial live implementation from silently making
    // unauthorized requests.
    return {
      status: STATUS.ERROR,
      query: artistName,
      results: [],
      totalResults: 0,
      manualUrl,
      note: 'Live API is not yet implemented. Contact SoundExchange to complete the data-exchange agreement and provide the official endpoint documentation.',
      source: 'stub',
    };
  }

  async _liveISRCLookup(isrc, manualUrl) {
    // TODO: implement once official endpoint and auth scheme are documented.
    return {
      status: STATUS.ERROR,
      isrc,
      result: null,
      found: null,
      manualUrl,
      note: 'Live API is not yet implemented. See SOUNDEXCHANGE_API_ACCESS_REQUEST.md.',
      source: 'stub',
    };
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  _featureDisabledResult(query, note, manualUrl) {
    const encoded = encodeURIComponent(String(query || ''));
    return {
      status: STATUS.FEATURE_DISABLED,
      query,
      results: [],
      totalResults: 0,
      found: null,
      manualUrl: manualUrl || `https://www.soundexchange.com/artist-search/?query=${encoded}`,
      note: note || 'SoundExchange API is not enabled. Set SOUNDEXCHANGE_API_ENABLED=true and provide credentials, or use the CSV import path.',
      authorized_path: 'Export data from SoundExchange Direct → validateCatalogImport() or validateStatementImport()',
    };
  }
}

// ── Backwards-compatible scanSoundExchange (used by lib/scanner.js) ───────────
// Returns the same shape as the original lib/soundexchange.js scanSoundExchange()
// but without the unauthorized admin-ajax.php call.
// `found: null` signals "not checked" to scanner.js (treated as `status: unknown`).

async function scanSoundExchange(artistName) {
  const adapter = new SoundExchangeAdapter();
  const status  = adapter.getStatus();
  const encoded = encodeURIComponent(String(artistName || '').trim());
  const manualUrl = `https://www.soundexchange.com/artist-search/?query=${encoded}`;

  // No live lookup occurs without explicit API credentials.
  // The manual URL is surfaced to the operator for manual verification.
  return {
    found: null,
    artistName,
    manualUrl,
    apiStatus: status.mode,
    gaps: [{
      type: 'soundexchange_manual_check_required',
      severity: 'high',
      message: `SoundExchange requires a manual check or authorized API access for "${artistName}". Export from SXDirect and use the CSV import path, or apply for API access.`,
      estimatedImpact: 0,
    }],
    note: status.note,
    authorizedPath: 'SoundExchange Direct export → lib/neighboring-rights-audit.js validateCatalogImport()',
    totalEstimatedImpact: 0,
  };
}

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = {
  SoundExchangeAdapter,
  scanSoundExchange,
  STATUS,
};
