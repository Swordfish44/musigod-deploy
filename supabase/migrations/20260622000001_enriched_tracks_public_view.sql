-- 20260622_enriched_tracks_public_view.sql
--
-- Creates a public schema view alias so PostgREST can serve
-- catalog_enriched_tracks_v1 as /rest/v1/enriched_tracks_v1.
-- The underlying table lives in public already; this view is purely a
-- convenience alias for the frontend and future partner API consumers
-- who should not need to know the versioned table name.
--
-- Safe to run multiple times (CREATE OR REPLACE).

CREATE OR REPLACE VIEW public.enriched_tracks_v1 AS
  SELECT * FROM public.catalog_enriched_tracks_v1;

-- Grant read access to authenticated and anon roles so PostgREST can serve it.
-- The underlying table still has RLS (service_role only for writes).
-- This view is read-only by design.
GRANT SELECT ON public.enriched_tracks_v1 TO authenticated, anon, service_role;

-- Reload PostgREST schema cache so the view is queryable immediately.
NOTIFY pgrst, 'reload schema';
