-- ============================================================
-- MIGRATION ADDITIVE — v18c (2026-07-28)
-- tenant_pilot_registry() expose desormais la nationalite (pilots.nationality
-- pour les pilotes v14+, derniere nationality connue en session_registrations
-- pour les inscriptions legacy pre-v14) : necessaire pour l'editeur du
-- Registre (bouton "Modifier", voir registry.js) qui doit pouvoir l'afficher
-- et la corriger. DROP + CREATE requis (pas un simple OR REPLACE) car la
-- signature RETURNS TABLE change (nouvelle colonne).
--
-- À appliquer manuellement sur le projet Supabase (yfgrvfdjakjnmryhtpgo),
-- comme les migrations precedentes — deja applique en production le
-- 2026-07-28, en suite immediate de migration-v18-nationalite-definitive-
-- et-editeur-registre.sql.
-- ============================================================
DROP FUNCTION IF EXISTS public.tenant_pilot_registry();

CREATE OR REPLACE FUNCTION public.tenant_pilot_registry()
RETURNS TABLE (
  pilot_id uuid,
  pseudo text,
  first_name text,
  last_name text,
  email text,
  birth_date date,
  nationality text,
  first_seen date,
  last_seen date,
  sessions_count bigint,
  legacy boolean
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
  WITH my_tenants AS (
    SELECT unnest(public.tenant_admin_ids(auth.uid())) AS tenant_id
  ),
  v14_rows AS (
    SELECT
      p.id AS pilot_id,
      p.pseudo,
      p.first_name,
      p.last_name,
      p.email,
      p.birth_date,
      p.nationality,
      min(coalesce(s.session_date, sr.created_at::date)) AS first_seen,
      max(coalesce(s.session_date, sr.created_at::date)) AS last_seen,
      count(DISTINCT sr.session_id) AS sessions_count,
      false AS legacy
    FROM public.session_registrations sr
    JOIN my_tenants mt ON mt.tenant_id = sr.tenant_id
    JOIN public.pilots p ON p.id = sr.pilot_id
    LEFT JOIN public.sessions s ON s.id = sr.session_id
    WHERE sr.pilot_id IS NOT NULL
    GROUP BY p.id, p.pseudo, p.first_name, p.last_name, p.email, p.birth_date, p.nationality
  ),
  legacy_rows AS (
    SELECT
      NULL::uuid AS pilot_id,
      NULL::text AS pseudo,
      max(sr.first_name) AS first_name,
      max(sr.last_name) AS last_name,
      sr.email,
      NULL::date AS birth_date,
      (array_agg(sr.nationality ORDER BY coalesce(s.session_date, sr.created_at::date) DESC))[1] AS nationality,
      min(coalesce(s.session_date, sr.created_at::date)) AS first_seen,
      max(coalesce(s.session_date, sr.created_at::date)) AS last_seen,
      count(DISTINCT sr.session_id) AS sessions_count,
      true AS legacy
    FROM public.session_registrations sr
    JOIN my_tenants mt ON mt.tenant_id = sr.tenant_id
    LEFT JOIN public.sessions s ON s.id = sr.session_id
    WHERE sr.pilot_id IS NULL AND sr.email IS NOT NULL
    GROUP BY sr.email
  )
  SELECT * FROM v14_rows
  UNION ALL
  SELECT * FROM legacy_rows;
$fn$;
REVOKE ALL ON FUNCTION public.tenant_pilot_registry() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.tenant_pilot_registry() TO authenticated;
