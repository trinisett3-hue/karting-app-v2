-- ============================================================
-- MIGRATION ADDITIVE — v15 (2026-07-28)
-- Registre clients (RGPD, suppression complète) + support des filtres de
-- dates/export CSV côté Statistiques (aucun changement de schéma requis
-- pour ces deux derniers, tout est côté front — voir stats.js/registry.js).
-- ============================================================
-- Ce fichier ne modifie AUCUNE colonne ni ligne existante : il ajoute
-- uniquement des fonctions SECURITY DEFINER, réservées à `authenticated`
-- (PAS anon — contrairement aux RPCs publiques de la v14, celles-ci sont
-- des opérations d'administration réservées aux comptes admin connectés).
--
-- À appliquer manuellement sur le projet Supabase (yfgrvfdjakjnmryhtpgo),
-- comme migration-v2.sql / migration-v13 / migration-v14 — ce fichier
-- n'est pas rejoué automatiquement.
-- ============================================================

-- --------------------------------------------------------------
-- 1) tenant_admin_ids — ensemble des tenant_id administrés par l'utilisateur
--    authentifié appelant (via tenant_users).
-- --------------------------------------------------------------
-- Un même compte peut administrer plusieurs circuits (tenant_users a une
-- ligne par (user_id, tenant_id)) : le registre et les suppressions ci-
-- dessous doivent donc raisonner sur un ENSEMBLE de tenants, pas un seul.
CREATE OR REPLACE FUNCTION public.tenant_admin_ids(_user_id uuid)
RETURNS uuid[]
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
  SELECT coalesce(array_agg(tenant_id), ARRAY[]::uuid[])
    FROM public.tenant_users
   WHERE user_id = _user_id;
$fn$;
REVOKE ALL ON FUNCTION public.tenant_admin_ids(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.tenant_admin_ids(uuid) TO authenticated;

-- --------------------------------------------------------------
-- 2) tenant_pilot_registry — liste "clients" (registre RGPD) pour
--    l'admin connecté, agrégée sur TOUS les tenants qu'il administre.
-- --------------------------------------------------------------
-- Deux familles de lignes UNIONées :
--   a) pilotes v14+ (identité globale `pilots`, jointe via
--      session_registrations.pilot_id) — sessions_count compte
--      uniquement les sessions des tenants administrés par l'appelant
--      (un pilote ayant aussi couru ailleurs ne fait pas gonfler ce
--      total avec les sessions d'un autre circuit).
--   b) inscriptions "legacy" pré-v14 (pas de pilots row, juste un email
--      capturé directement sur session_registrations) — une ligne par
--      email distinct, avec pilot_id = NULL et legacy = true. Elles
--      contiennent des données personnelles (email) au sens RGPD, elles
--      doivent donc apparaître dans le registre au même titre.
CREATE OR REPLACE FUNCTION public.tenant_pilot_registry()
RETURNS TABLE (
  pilot_id uuid,
  pseudo text,
  first_name text,
  last_name text,
  email text,
  birth_date date,
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
      min(coalesce(s.session_date, sr.created_at::date)) AS first_seen,
      max(coalesce(s.session_date, sr.created_at::date)) AS last_seen,
      count(DISTINCT sr.session_id) AS sessions_count,
      false AS legacy
    FROM public.session_registrations sr
    JOIN my_tenants mt ON mt.tenant_id = sr.tenant_id
    JOIN public.pilots p ON p.id = sr.pilot_id
    LEFT JOIN public.sessions s ON s.id = sr.session_id
    WHERE sr.pilot_id IS NOT NULL
    GROUP BY p.id, p.pseudo, p.first_name, p.last_name, p.email, p.birth_date
  ),
  legacy_rows AS (
    SELECT
      NULL::uuid AS pilot_id,
      NULL::text AS pseudo,
      max(sr.first_name) AS first_name,
      max(sr.last_name) AS last_name,
      sr.email,
      NULL::date AS birth_date,
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

-- --------------------------------------------------------------
-- 3) delete_pilot_completely — suppression RGPD COMPLÈTE (hard delete,
--    pas une anonymisation) d'un pilote v14+.
-- --------------------------------------------------------------
-- ATTENTION — CONSÉQUENCE PLATEFORME-ENTIÈRE, DÉLIBÉRÉE :
-- `pilots` est une table GLOBALE, SANS tenant_id (voir migration-v14 :
-- l'identité/pseudo d'un pilote est partagée entre tous les circuits
-- Trinisette par choix produit explicite). Il en découle qu'un admin qui
-- vérifie administrer AU MOINS UN tenant où ce pilote a une inscription
-- (`session_registrations`) est autorisé à déclencher la suppression
-- COMPLÈTE de son identité et de tout son historique de courses — y
-- compris sur des circuits qu'il n'administre PAS lui-même. Ce n'est pas
-- un bug de cloisonnement : c'est la conséquence directe et acceptée du
-- modèle "pseudo unique cross-tenant" demandé par le client. Les
-- opérateurs humains doivent en avoir conscience avant de cliquer
-- "Supprimer" dans le Registre (voir registry.js > confirmDeletePilot,
-- qui l'explique dans le texte de confirmation).
--
-- Suppression demandée EXPLICITEMENT en dur (pas une anonymisation) :
-- laps -> session_registrations -> pilots, dans cet ordre pour respecter
-- les clés étrangères.
CREATE OR REPLACE FUNCTION public.delete_pilot_completely(_pilot_id uuid)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM public.session_registrations sr
      JOIN public.tenant_users tu ON tu.tenant_id = sr.tenant_id
     WHERE sr.pilot_id = _pilot_id
       AND tu.user_id = auth.uid()
  ) THEN
    RAISE EXCEPTION 'Non autorisé.' USING ERRCODE = '42501';
  END IF;

  DELETE FROM public.laps
   WHERE registration_id IN (
     SELECT id FROM public.session_registrations WHERE pilot_id = _pilot_id
   );

  DELETE FROM public.session_registrations WHERE pilot_id = _pilot_id;

  DELETE FROM public.pilots WHERE id = _pilot_id;
END;
$fn$;
REVOKE ALL ON FUNCTION public.delete_pilot_completely(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.delete_pilot_completely(uuid) TO authenticated;

-- --------------------------------------------------------------
-- 4) delete_legacy_registration — suppression RGPD complète d'UNE
--    inscription pré-v14 (pas d'identité globale, donc tenant-scopée).
-- --------------------------------------------------------------
-- Contrairement à delete_pilot_completely, il n'y a ici aucune identité
-- partagée entre tenants : l'appelant doit administrer LE tenant
-- propriétaire de cette inscription précise. Le garde `pilot_id IS NULL`
-- dans le DELETE final empêche formellement cette fonction d'être
-- détournée pour supprimer une ligne v14 (rattachée à un pilote global)
-- sans passer par delete_pilot_completely, ce qui laisserait des laps
-- incohérents pour ce pilote sur d'autres tenants.
CREATE OR REPLACE FUNCTION public.delete_legacy_registration(_registration_id uuid)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  v_tenant_id uuid;
BEGIN
  SELECT tenant_id INTO v_tenant_id
    FROM public.session_registrations
   WHERE id = _registration_id AND pilot_id IS NULL;

  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'Non autorisé.' USING ERRCODE = '42501';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.tenant_users
     WHERE tenant_id = v_tenant_id AND user_id = auth.uid()
  ) THEN
    RAISE EXCEPTION 'Non autorisé.' USING ERRCODE = '42501';
  END IF;

  DELETE FROM public.laps WHERE registration_id = _registration_id;
  DELETE FROM public.session_registrations WHERE id = _registration_id AND pilot_id IS NULL;
END;
$fn$;
REVOKE ALL ON FUNCTION public.delete_legacy_registration(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.delete_legacy_registration(uuid) TO authenticated;

-- ============================================================
-- 5) À EXÉCUTER SÉPARÉMENT — gating "thèmes premium" de results.html
--    derrière le plan Pro (entitlement `premium_themes`).
-- ============================================================
-- Volontairement NON inclus dans les DDL additives ci-dessus : ceci touche
-- aux entitlements commerciaux (plans.entitlements, donc potentiellement
-- au comportement de facturation perçu par des tenants déjà en prod). À
-- relire et exécuter à la main, séparément, quand la fonctionnalité
-- "thèmes premium" de results.html sera prête côté front.
--
-- UPDATE public.plans
--    SET entitlements = entitlements || '{"premium_themes": true}'::jsonb
--  WHERE code IN ('pro', 'business');

-- --------------------------------------------------------------
-- 6) my_theme_entitlement — RPC lisant l'entitlement `premium_themes`
--    pour l'admin connecté, exposée au picker de thèmes (settings.js).
-- --------------------------------------------------------------
-- CORRIGÉ après relecture directe du schéma live (pg_get_functiondef) :
-- la première version de cette fonction supposait `subscriptions.tenant_id`
-- — cette colonne n'existe pas (subscriptions est lié à `organizations`,
-- pas directement à `tenants`) et la fonction aurait échoué à la création.
-- Le projet a DÉJÀ deux fonctions internes qui font exactement cette
-- résolution correctement :
--   - private.tenant_plan_code(_tenant)      → plan_override sinon le
--     plan_code de l'abonnement actif/trialing/past_due de l'organisation
--     du tenant (via tenants.organization_id → subscriptions.organization_id),
--     repli sur 'starter'.
--   - private.tenant_has_entitlement(_tenant, _key) → lit
--     plans.entitlements->>_key pour le plan résolu ci-dessus.
-- On les réutilise telles quelles au lieu de dupliquer cette logique une
-- 2e fois (exactement ce que private.avatar_config() fait déjà pour les
-- avatars) — c'est la seule source de vérité pour "quel est le plan
-- effectif de ce tenant".
CREATE OR REPLACE FUNCTION public.my_theme_entitlement()
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  v_tenant_id uuid;
BEGIN
  SELECT (public.tenant_admin_ids(auth.uid()))[1] INTO v_tenant_id;

  IF v_tenant_id IS NULL THEN
    RETURN jsonb_build_object('entitled', false, 'plan', 'starter');
  END IF;

  RETURN jsonb_build_object(
    'entitled', private.tenant_has_entitlement(v_tenant_id, 'premium_themes'),
    'plan',     private.tenant_plan_code(v_tenant_id)
  );
END;
$fn$;
REVOKE ALL ON FUNCTION public.my_theme_entitlement() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.my_theme_entitlement() TO authenticated;

-- --------------------------------------------------------------
-- ⚠️ LACUNE CONNUE (hors périmètre de cette passe, à ne PAS corriger à
-- l'aveugle) : public_site_config() — qui alimente results.html côté
-- pilote/public — renvoie vraisemblablement settings.results_theme tel
-- quel, SANS revalider l'entitlement `premium_themes` du tenant à ce
-- moment-là. Si un tenant downgrade après avoir choisi un thème premium,
-- results.html continuerait donc d'afficher ce thème premium jusqu'à ce
-- que l'admin en change manuellement depuis les Paramètres. Le gating
-- actuel (picker + selectResultsTheme côté admin) empêche seulement de
-- SÉLECTIONNER un thème premium sans entitlement, pas de continuer à
-- SERVIR un thème premium déjà enregistré après une perte d'entitlement.
-- À corriger dans une passe dédiée à public_site_config(), en s'inspirant
-- de private.avatar_config(tenant_id) qui, elle, retombe déjà sur
-- 'classic' côté serveur quand l'entitlement avatar manque.
-- --------------------------------------------------------------
