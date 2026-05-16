-- ============================================================
-- Affiliate dashboard proxy RPCs
-- Needed because affiliates schema is not exposed in PostgREST.
-- These SECURITY DEFINER functions bypass RLS and run as owner.
--
-- Apply via: Supabase Dashboard → SQL Editor → New query
-- Or: python run_migration.py (if SUPABASE_ACCESS_TOKEN is set)
-- ============================================================

-- List all affiliates (for dashboard affiliates table)
CREATE OR REPLACE FUNCTION public.fn_list_affiliates()
RETURNS JSON
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(
    (SELECT json_agg(row_to_json(a))
     FROM (SELECT * FROM affiliates.affiliates_v1 ORDER BY created_at DESC) a),
    '[]'::json
  );
$$;

-- List recent commissions (for dashboard commissions feed)
CREATE OR REPLACE FUNCTION public.fn_list_commissions(p_limit INT DEFAULT 100)
RETURNS JSON
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(
    (SELECT json_agg(row_to_json(c))
     FROM (SELECT * FROM affiliates.commissions_v1 ORDER BY created_at DESC LIMIT p_limit) c),
    '[]'::json
  );
$$;

GRANT EXECUTE ON FUNCTION public.fn_list_affiliates() TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_list_commissions(INT) TO anon, authenticated;
