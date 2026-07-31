-- Add unique constraint on (artist_email, case_type) in recovery_cases_v1.
-- One case per royalty stream type per artist — the application-level guard
-- in fn_create_recovery_cases_from_findings_v1 is now backed by a DB constraint.
--
-- First remove existing duplicate rows (keep the one with an audit_id; if both
-- have audit_ids or both null, keep the most recent).

DELETE FROM registrations.recovery_cases_v1
WHERE id IN (
  SELECT id FROM (
    SELECT
      id,
      ROW_NUMBER() OVER (
        PARTITION BY artist_email, case_type
        ORDER BY
          (audit_id IS NOT NULL) DESC,  -- prefer rows linked to an audit
          created_at DESC               -- then most recent
      ) AS rn
    FROM registrations.recovery_cases_v1
  ) ranked
  WHERE rn > 1
);

ALTER TABLE registrations.recovery_cases_v1
  ADD CONSTRAINT uq_recovery_cases_artist_case_type
  UNIQUE (artist_email, case_type);
