-- ============================================================
-- Affiliates wiring migration
-- Run in Supabase SQL editor: Dashboard → SQL Editor → New query
-- ============================================================

-- 1. Add ref_code column to artists_v1 (idempotent)
ALTER TABLE artists.artists_v1
  ADD COLUMN IF NOT EXISTS ref_code TEXT;

-- 2. Proxy: INSERT a commission row (callable from REST via rpc/fn_create_commission)
--    SECURITY DEFINER runs as owner (postgres), bypasses RLS on affiliates schema.
--    affiliates schema does NOT need to be in the exposed schemas list.
CREATE OR REPLACE FUNCTION public.fn_create_commission(
  p_affiliate_code TEXT,
  p_artist_id      UUID,
  p_trigger        TEXT DEFAULT 'activation'
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_affiliate_id     UUID;
  v_commission_flat  NUMERIC;
  v_commission_id    UUID;
BEGIN
  IF p_affiliate_code IS NULL OR p_affiliate_code = '' THEN
    RETURN json_build_object('ok', false, 'reason', 'no_ref_code');
  END IF;

  SELECT id, commission_flat
  INTO v_affiliate_id, v_commission_flat
  FROM affiliates.affiliates_v1
  WHERE ref_code = p_affiliate_code
  LIMIT 1;

  IF v_affiliate_id IS NULL THEN
    RETURN json_build_object('ok', false, 'reason', 'affiliate_not_found', 'code', p_affiliate_code);
  END IF;

  INSERT INTO affiliates.commissions_v1 (affiliate_id, artist_id, triggered_by, status, amount)
  VALUES (v_affiliate_id, p_artist_id, p_trigger, 'pending', v_commission_flat)
  RETURNING id INTO v_commission_id;

  RETURN json_build_object('ok', true, 'commission_id', v_commission_id, 'amount', v_commission_flat);
END;
$$;

-- 3. Proxy: read back commissions for an artist (for e2e verification)
CREATE OR REPLACE FUNCTION public.fn_get_commissions(p_artist_id UUID)
RETURNS JSON
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(json_agg(row_to_json(c)), '[]'::json)
  FROM affiliates.commissions_v1 c
  WHERE c.artist_id = p_artist_id;
$$;

-- 4. Grant execute to anon and authenticated roles
GRANT EXECUTE ON FUNCTION public.fn_create_commission(TEXT, UUID, TEXT) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_get_commissions(UUID) TO anon, authenticated;

-- ============================================================
-- COLUMN ASSUMPTIONS — if affiliates tables use different names,
-- adjust the INSERT and SELECT above:
--   affiliates.affiliates_v1  → expects column: code TEXT
--   affiliates.commissions_v1 → expects columns: affiliate_id UUID,
--                                artist_id UUID, triggered_by TEXT,
--                                status TEXT
-- ============================================================
