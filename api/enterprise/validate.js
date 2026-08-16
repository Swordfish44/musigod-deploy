'use strict';

const path = require('path');
const ingestion = require(path.join(__dirname, '../../lib/enterprise-ingestion'));
const rules = require(path.join(__dirname, '../../lib/royalty-rules-registry'));
const corrections = require(path.join(__dirname, '../../lib/enterprise-correction-package'));
const title = require(path.join(__dirname, '../../lib/chain-of-title'));

const ADMIN_API_KEY = process.env.ADMIN_API_KEY;
const ACTIONS = new Set(['validate_import', 'normalize_record', 'validate_rule', 'match_rules', 'build_correction', 'analyze_title']);

module.exports = async function handler(req, res) {
  setCors(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  if (!ADMIN_API_KEY || req.headers['x-admin-key'] !== ADMIN_API_KEY) return res.status(401).json({ error: 'Unauthorized' });

  const { action, input = {} } = req.body || {};
  if (!ACTIONS.has(action)) return res.status(400).json({ error: 'unsupported_action', allowed_actions: [...ACTIONS] });

  try {
    let result;
    switch (action) {
      case 'validate_import': result = ingestion.validateImportManifest(input.manifest); break;
      case 'normalize_record': result = ingestion.normalizeEnterpriseRecord(input.record_type, input.record, input.context); break;
      case 'validate_rule': result = rules.validateRoyaltyRule(input.rule); break;
      case 'match_rules': result = rules.selectApplicableRules(input.rules, input.event); break;
      case 'build_correction': result = corrections.buildCorrectionPackage(input.spec, input.records, input.evidence, input.metadata); break;
      case 'analyze_title': result = title.analyzeTitleDocuments(input.documents); break;
    }
    return res.status(200).json({ enterprise_version: '1.0', action, result });
  } catch (error) {
    return res.status(422).json({ error: 'validation_failed', detail: error.message });
  }
};

function setCors(req, res) {
  const allowed = new Set(['https://musigod.com', 'https://www.musigod.com']);
  const origin = req.headers.origin;
  if (allowed.has(origin)) res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-key');
  res.setHeader('Cache-Control', 'no-store');
}
