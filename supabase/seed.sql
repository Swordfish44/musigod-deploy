-- supabase/seed.sql
--
-- LOCAL / NON-PRODUCTION SEED — Echo test artist only.
-- Do NOT apply to the production Supabase project.
-- Run via: npm run db:seed (requires LOCAL_DATABASE_URL in .env.local)
--
-- What this creates:
--   1. One intake workflow for the Echo test engagement (INVITED state).
--   2. Seven mandatory item status rows initialized to MISSING.
--      Optional items are not seeded — they are auto-initialized at OPTIONAL.
--
-- Prerequisites:
--   - Migrations 000000–000004 applied to the local database.
--   - registrations.artists_v1 must exist (pre-existing table).
--     artist_id is intentionally left NULL in the seed — the FK is optional
--     and the artists_v1 schema is not reproduced here.
--
-- Idempotent: all INSERTs use ON CONFLICT DO NOTHING.

-- ── Echo test workflow ────────────────────────────────────────────────────────

INSERT INTO registrations.intake_workflows_v1 (
  engagement_id,
  artist_email,
  pilot_id,
  tier,
  current_state,
  correlation_id
)
VALUES (
  'pilot-001-echo-sandbox',         -- engagement_id (unique)
  'echo@musigod-test.local',        -- synthetic test email — never a real artist address
  'pilot-001',                      -- pilot config key from lib/intake-config.js
  'individual',
  'INVITED',
  'seed-echo-001'
)
ON CONFLICT (engagement_id) DO NOTHING;

-- ── Echo mandatory item statuses — all MISSING at seed time ──────────────────
-- Inserted as a single CTE to avoid needing a separate lookup query.
-- ON CONFLICT DO NOTHING preserves any statuses already set by prior test runs.

WITH workflow AS (
  SELECT id FROM registrations.intake_workflows_v1
  WHERE engagement_id = 'pilot-001-echo-sandbox'
  LIMIT 1
)
INSERT INTO registrations.intake_item_statuses_v1 (workflow_id, item_id, status, notes)
SELECT
  workflow.id,
  items.item_id,
  'MISSING',
  'Seeded — pending intake'
FROM workflow
CROSS JOIN (
  VALUES
    ('identity_confirmed'),
    ('engagement_signed'),
    ('loa_signed'),
    ('soundexchange_catalog'),
    ('soundexchange_payments'),
    ('featured_performer_declaration'),
    ('master_ownership')
) AS items(item_id)
ON CONFLICT (workflow_id, item_id) DO NOTHING;
