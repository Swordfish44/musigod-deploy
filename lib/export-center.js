'use strict';
// lib/export-center.js
// Config-driven artist export center with guided checklists for each document type.
// Guide updates require only a config change — no code changes.
// Pure functions — no DB access, no network calls.
// Does NOT invent portal navigation labels or URLs that have not been verified.

const GUIDE_VERSION = 'export-center-v1';

const GUIDES = [
  {
    id: 'soundexchange_associated_recordings',
    label: 'SoundExchange Associated Recordings',
    category: 'soundexchange',
    required: true,
    why: 'Identifies which recordings SoundExchange currently associates with your account. Essential for matching your catalog against your SoundExchange registration status and finding unregistered recordings.',
    file_type: ['CSV', 'XLSX'],
    date_coverage: 'All available — export the full catalog, not a date-filtered subset.',
    how_to_export: [
      'Log into SoundExchange Direct (SXDirect) at soundexchange.com.',
      'Navigate to your catalog or recordings section.',
      'Use the export or download option to save the full associated recordings list as CSV or Excel.',
      'Do not share your login credentials — export the file yourself, save it to your computer, and upload it here.',
    ],
    upload_warning: 'Do not email this file. Download it locally and upload through the MusiGod secure portal only.',
    official_guidance_url: null,
    acknowledgment_required: true,
  },
  {
    id: 'soundexchange_search_and_claim',
    label: 'SoundExchange Search-and-Claim / Unclaimed Recordings',
    category: 'soundexchange',
    required: true,
    why: 'SoundExchange may hold royalties for recordings not yet matched to your account. This export identifies unclaimed funds that may belong to you based on your performer identity.',
    file_type: ['CSV', 'XLSX'],
    date_coverage: 'All available.',
    how_to_export: [
      'Log into SoundExchange Direct.',
      'Navigate to the search-and-claim or unclaimed recordings tool.',
      'Search for your artist name and all known aliases and spelling variants.',
      'Export any unclaimed or unmatched results as CSV or Excel.',
    ],
    upload_warning: 'Do not email royalty or payment data. Upload through the MusiGod secure portal only.',
    official_guidance_url: null,
    acknowledgment_required: true,
  },
  {
    id: 'soundexchange_payments',
    label: 'SoundExchange Payment Statements (All Years)',
    category: 'soundexchange',
    required: true,
    why: 'Required to calculate what has already been paid, identify gaps, detect underpayments, and establish the baseline for the audit. Without complete payment history the audit cannot determine what is outstanding.',
    file_type: ['CSV', 'XLSX', 'PDF'],
    date_coverage: 'All available years. Request at minimum 5 years back, or as far as your SoundExchange account shows.',
    how_to_export: [
      'Log into SoundExchange Direct.',
      'Navigate to your statements or payment history section.',
      'Export all available years. If the portal does not offer a combined export, download each year separately.',
      'Include both digital performance and non-interactive streaming statements if shown separately.',
    ],
    upload_warning: 'Payment statements contain private financial data. Never email them. Upload through the MusiGod secure portal only.',
    official_guidance_url: null,
    acknowledgment_required: true,
  },
  {
    id: 'soundexchange_adjustments',
    label: 'SoundExchange Adjustments and Reversals',
    category: 'soundexchange',
    required: false,
    why: 'Adjustments and reversals change your net received total. Without them the audit may over- or understate what you have actually received.',
    file_type: ['CSV', 'XLSX', 'PDF'],
    date_coverage: 'All available.',
    how_to_export: [
      'Check whether SoundExchange Direct offers a separate adjustments or reversals export.',
      'If not, look for adjustment line items within your regular payment statements.',
      'Download and upload any available adjustment records.',
    ],
    upload_warning: 'Upload through the MusiGod secure portal only.',
    official_guidance_url: null,
    acknowledgment_required: false,
  },
  {
    id: 'distributor_statements',
    label: 'Distributor Statements',
    category: 'distributor',
    required: true,
    why: 'Corroborates master ownership and documents ISRC assignments. Helps verify which recordings your distributor has registered on your behalf and which ISRCs they assigned.',
    file_type: ['CSV', 'XLSX', 'PDF'],
    date_coverage: 'All available years.',
    how_to_export: [
      'Log into your distributor portal (DistroKid, CD Baby, TuneCore, AWAL, or other).',
      'Navigate to earnings, statements, or catalog.',
      'Export all available statement history.',
      'If your distributor offers a separate ISRC export, include that as a separate upload.',
      'Do not share your distributor login credentials — export the files yourself.',
    ],
    upload_warning: 'Do not email statements. Export them yourself and upload through MusiGod.',
    official_guidance_url: null,
    acknowledgment_required: true,
  },
  {
    id: 'label_statements',
    label: 'Label Statements',
    category: 'label',
    required: false,
    why: 'Required if any recordings were released under a label deal. Establishes the ownership split between label and artist for the purpose of neighboring rights.',
    file_type: ['CSV', 'XLSX', 'PDF'],
    date_coverage: 'All available years for each label relationship.',
    how_to_export: [
      'Contact the label accounting department or royalty administrator.',
      'Request a full statement export for all available recording periods.',
      'If the label provides portal access, export from there.',
      'Include contract or deal memo if it clarifies ownership splits.',
    ],
    upload_warning: 'Upload through MusiGod only. Do not forward statements by email.',
    official_guidance_url: null,
    acknowledgment_required: false,
  },
  {
    id: 'ppl_and_international_cmo',
    label: 'PPL and International CMO Statements',
    category: 'international',
    required: false,
    why: 'Neighboring rights are collected across many countries. PPL (UK), GVL (Germany), IFPI affiliates, and other collection organizations may hold royalties for your recordings that have not been distributed.',
    file_type: ['CSV', 'XLSX', 'PDF'],
    date_coverage: 'All available years.',
    how_to_export: [
      'If you have a PPL member account, log in and export your statement history.',
      'For other international CMOs, contact them directly for statement exports.',
      'Provide all available statements regardless of territory or currency.',
    ],
    upload_warning: 'Upload through MusiGod only. Do not email international statements.',
    official_guidance_url: null,
    acknowledgment_required: false,
  },
  {
    id: 'international_mandates',
    label: 'Existing International Collection Mandates',
    category: 'international',
    required: false,
    why: 'Existing mandates determine which CMOs are already authorized to collect on your behalf. Without this we cannot determine which territories have collection already in place or where gaps exist.',
    file_type: ['PDF', 'DOCX'],
    date_coverage: 'Current and historical mandates in effect.',
    how_to_export: [
      'Locate signed mandate or appointment agreements with any CMO.',
      'Download signed copies from your CMO portal if available, or scan physical copies as PDF.',
      'Include expired mandates if you are not sure which are current — we will sort them.',
    ],
    upload_warning: 'Upload through MusiGod only. Do not email signed legal documents.',
    official_guidance_url: null,
    acknowledgment_required: false,
  },
  {
    id: 'master_ownership',
    label: 'Master Ownership and Exclusive License Evidence',
    category: 'ownership',
    required: true,
    why: 'Neighboring rights require proof of master ownership or an exclusive license to master recordings. Without this no claim can be authorized regardless of other evidence.',
    file_type: ['PDF', 'DOCX'],
    date_coverage: 'All periods during which you owned or exclusively licensed the masters.',
    how_to_export: [
      'Locate recording agreements, work-for-hire agreements, or exclusive license agreements.',
      'For self-funded / self-produced recordings: provide any business records confirming you produced and funded the recording (studio invoices, engineer contracts, session pay records).',
      'Business entity formation documents may support master ownership where an LLC or corporation holds the rights.',
      'If documents contain full SSN, EIN, bank account numbers, or routing numbers: redact those fields before uploading, or contact MusiGod for secure alternatives.',
    ],
    upload_warning: 'Redact sensitive personal identifiers before uploading where possible. Never email ownership documents.',
    official_guidance_url: null,
    acknowledgment_required: true,
  },
];

function getGuides(options = {}) {
  const { requiredOnly = false, category = null } = options;
  let result = GUIDES;
  if (requiredOnly) result = result.filter(g => g.required);
  if (category) result = result.filter(g => g.category === category);
  return result.map(g => ({ ...g, guide_version: GUIDE_VERSION }));
}

function getGuideById(id) {
  const g = GUIDES.find(g => g.id === id);
  if (!g) return null;
  return { ...g, guide_version: GUIDE_VERSION };
}

function buildAcknowledgmentRecord(guideId, artistId, timestamp = null) {
  return {
    guide_id: guideId,
    guide_version: GUIDE_VERSION,
    artist_id: artistId,
    acknowledged_at: timestamp || new Date().toISOString(),
  };
}

function validateAcknowledgment(guideId, artistId) {
  const guide = getGuideById(guideId);
  if (!guide) return { valid: false, error: `Unknown guide: ${guideId}` };
  if (!guide.acknowledgment_required) return { valid: true, note: 'Acknowledgment not required for this guide' };
  if (!artistId) return { valid: false, error: 'artistId required for acknowledgment' };
  return { valid: true };
}

function listRequiredGuideIds() {
  return GUIDES.filter(g => g.required).map(g => g.id);
}

module.exports = {
  GUIDE_VERSION,
  GUIDES,
  getGuides,
  getGuideById,
  buildAcknowledgmentRecord,
  validateAcknowledgment,
  listRequiredGuideIds,
};
