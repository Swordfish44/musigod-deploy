-- 03_rollback.sql — restores the exact override observed on 2026-09-23 before 01_fix.sql.
-- This re-breaks artist registration (PGRST106). Use only if 01_fix.sql caused
-- PGRST002 / Data API instability. Grants are left in place (harmless, service_role only).
ALTER ROLE authenticator SET pgrst.db_schemas = 'public, storage, graphql_public, royalty_intelligence';
NOTIFY pgrst, 'reload config';
NOTIFY pgrst, 'reload schema';
