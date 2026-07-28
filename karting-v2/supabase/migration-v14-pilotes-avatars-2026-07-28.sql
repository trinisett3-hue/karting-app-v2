-- ============================================================
-- MIGRATION ADDITIVE — v14 (2026-07-28)
-- Identité pilote plateforme-entière (pseudo unique) + carrousel d'avatars
-- de session (register.html en 3 écrans : première fois / déjà pilote /
-- session+avatar).
-- ============================================================
-- Ce fichier ne modifie AUCUNE colonne ni ligne existante :
--   - `drivers` n'est pas touchée (obsolète depuis le retrait de la photo en
--     v13, conservée telle quelle — voir migration-v13, register.js).
--   - `session_registrations` ne reçoit que des colonnes ADDITIVES,
--     nullables, sans jamais toucher aux colonnes déjà en place
--     (display_name/email/first_name/last_name restent la source de vérité
--     lue par tout le code existant — sessions.js, results.js,
--     public-results.js — donc AUCUNE régression sur ce qui existe déjà).
--
-- À appliquer manuellement sur le projet Supabase (yfgrvfdjakjnmryhtpgo),
-- comme migration-v2.sql / migration-v13 — ce fichier n'est pas rejoué
-- automatiquement.
-- ============================================================

-- --------------------------------------------------------------
-- 1) TABLE pilots — identité GLOBALE, plateforme-entière
-- --------------------------------------------------------------
-- Volontairement PAS de tenant_id : l'unicité du pseudo et la recherche
-- "déjà pilote sur ce circuit" (écran 1b) sont demandées cross-tenant par
-- le client — un pilote qui a déjà couru sur un autre circuit Trinisette
-- doit être retrouvable ici, et son pseudo lui est acquis partout.
-- C'est un choix produit explicite (voir demande client), pas un oubli.
CREATE TABLE IF NOT EXISTS public.pilots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  email TEXT NOT NULL,
  pseudo TEXT NOT NULL,
  birth_date DATE,
  created_at TIMESTAMPTZ DEFAULT now(),
  -- Aucun accent, aucun caractère spécial, aucun espace : lettres/chiffres/
  -- tiret/underscore/point uniquement. Refusé net (pas de translittération
  -- silencieuse) — c'est la même règle que côté front (register.js) ET
  -- revalidée ici, jamais confiance au seul client.
  CONSTRAINT pilots_pseudo_format CHECK (pseudo ~ '^[A-Za-z0-9_.-]+$')
);

-- Unicité insensible à la casse, sur toute la plateforme (pas de tenant_id
-- dans la clé : voir remarque ci-dessus).
CREATE UNIQUE INDEX IF NOT EXISTS pilots_email_lower_uidx ON public.pilots (lower(email));
CREATE UNIQUE INDEX IF NOT EXISTS pilots_pseudo_lower_uidx ON public.pilots (lower(pseudo));

-- RLS activée, AUCUNE policy anon/authenticated directe. `pilots` contient
-- des emails de tous les circuits : l'exposer en lecture anonyme, même
-- partiellement, viderait de son sens la restriction déjà appliquée à
-- `drivers` dans le passé (voir Audit-securite-Supabase-v2.md). Tout accès
-- passe par les fonctions SECURITY DEFINER de la section 3, qui ne
-- renvoient jamais l'email à un appelant anonyme (find_pilot_by_query).
ALTER TABLE public.pilots ENABLE ROW LEVEL SECURITY;
-- (Volontairement : zéro CREATE POLICY ici pour `anon` / `authenticated`.)

-- --------------------------------------------------------------
-- 2) session_registrations — colonnes additives
-- --------------------------------------------------------------
ALTER TABLE public.session_registrations ADD COLUMN IF NOT EXISTS pilot_id UUID REFERENCES public.pilots(id);
ALTER TABLE public.session_registrations ADD COLUMN IF NOT EXISTS avatar_scheme INT;

-- Contrainte de plage séparée (pas inline) pour rester un ADD COLUMN pur et
-- idempotent si ce fichier est relu : ADD CONSTRAINT n'a pas d'équivalent
-- "IF NOT EXISTS" natif avant PG 15, on protège donc avec un bloc DO.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'session_registrations_avatar_scheme_range'
  ) THEN
    ALTER TABLE public.session_registrations
      ADD CONSTRAINT session_registrations_avatar_scheme_range
      CHECK (avatar_scheme IS NULL OR avatar_scheme BETWEEN 0 AND 23);
  END IF;
END $$;

-- Un avatar ne peut être pris qu'une fois PAR SESSION (pas par tenant, pas
-- globalement) : deux circuits différents, ou deux sessions du même
-- circuit, peuvent réutiliser le même avatar_scheme en parallèle sans
-- conflit. Index partiel : les lignes sans avatar choisi (avatar_scheme
-- NULL — tout l'historique pré-v14) n'entrent jamais dans cette contrainte.
CREATE UNIQUE INDEX IF NOT EXISTS session_registrations_session_avatar_uidx
  ON public.session_registrations (session_id, avatar_scheme)
  WHERE avatar_scheme IS NOT NULL;

-- ============================================================
-- 3) FONCTIONS SECURITY DEFINER, anon-callable — même style que
--    public.public_site_config() (voir Cloisonnement-plan-Pro-et-
--    risques-lancement.md, Annexe A) : recevoir un token/paramètre,
--    ne renvoyer que le strict nécessaire, jamais de lecture directe
--    de table depuis le front pour ces cas.
-- ============================================================

-- --------------------------------------------------------------
-- 3a) find_pilot_by_query — écran 1b ("Déjà pilote sur ce circuit")
-- --------------------------------------------------------------
-- Cherche un pilote par email OU pseudo, cross-tenant (voir table pilots).
-- Ne renvoie JAMAIS l'email : un visiteur qui ne connaît que le pseudo d'un
-- pilote ne doit pas pouvoir en déduire son adresse. `id` est nécessaire au
-- front pour rattacher l'inscription (session_registrations.pilot_id) ; il
-- n'est pas plus sensible qu'un jeton opaque, il n'apparaît dans aucune API
-- REST publique (RLS de `pilots` fermée, voir section 1).
CREATE OR REPLACE FUNCTION public.find_pilot_by_query(_query text)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
  SELECT jsonb_build_object('id', p.id, 'pseudo', p.pseudo, 'first_name', p.first_name)
    FROM public.pilots p
   WHERE lower(p.email) = lower(trim(_query))
      OR lower(p.pseudo) = lower(trim(_query))
   LIMIT 1;
$fn$;
REVOKE ALL ON FUNCTION public.find_pilot_by_query(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.find_pilot_by_query(text) TO anon, authenticated;

-- --------------------------------------------------------------
-- 3b) check_pseudo_available — vérification live côté formulaire (écran 1a)
-- --------------------------------------------------------------
-- Utilisée pour un retour immédiat pendant la saisie. Ce n'est qu'un
-- CONFORT : register_new_pilot() revalide indépendamment à l'insertion,
-- donc une réponse ici périmée par une course (deux onglets, deux pilotes
-- au même instant) ne peut pas créer de doublon — voir 3c.
CREATE OR REPLACE FUNCTION public.check_pseudo_available(_pseudo text)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
  SELECT (_pseudo ~ '^[A-Za-z0-9_.-]+$')
     AND NOT EXISTS (SELECT 1 FROM public.pilots WHERE lower(pseudo) = lower(trim(_pseudo)));
$fn$;
REVOKE ALL ON FUNCTION public.check_pseudo_available(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.check_pseudo_available(text) TO anon, authenticated;

-- --------------------------------------------------------------
-- 3c) register_new_pilot — écran 1a ("Première fois sur ce circuit")
-- --------------------------------------------------------------
-- Revalide TOUT côté serveur : format du pseudo (regex identique à la
-- contrainte CHECK, vérifiée ici en amont pour renvoyer un message clair
-- plutôt que le texte brut d'une violation de contrainte) et unicité
-- (email + pseudo). Le index unique posé en section 1 reste le filet de
-- sécurité final contre une course entre deux inscriptions concurrentes :
-- si elle se produit, l'INSERT lève quand même une exception (capturée
-- ci-dessous et reformulée), jamais un pseudo dupliqué en base.
CREATE OR REPLACE FUNCTION public.register_new_pilot(
  _first_name text,
  _last_name text,
  _email text,
  _pseudo text,
  _birth_date date
)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  v_pseudo text := trim(_pseudo);
  v_email text := trim(_email);
  v_id uuid;
BEGIN
  IF _first_name IS NULL OR trim(_first_name) = '' THEN
    RAISE EXCEPTION 'Prénom manquant.' USING ERRCODE = '22023';
  END IF;
  IF _last_name IS NULL OR trim(_last_name) = '' THEN
    RAISE EXCEPTION 'Nom manquant.' USING ERRCODE = '22023';
  END IF;
  IF v_email IS NULL OR v_email = '' OR v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' THEN
    RAISE EXCEPTION 'Email invalide.' USING ERRCODE = '22023';
  END IF;
  IF v_pseudo IS NULL OR v_pseudo = '' THEN
    RAISE EXCEPTION 'Pseudo manquant.' USING ERRCODE = '22023';
  END IF;
  IF v_pseudo !~ '^[A-Za-z0-9_.-]+$' THEN
    RAISE EXCEPTION 'Pseudo invalide : pas d''accents, utilise uniquement lettres/chiffres/tiret/underscore.' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (SELECT 1 FROM public.pilots WHERE lower(pseudo) = lower(v_pseudo)) THEN
    RAISE EXCEPTION 'Ce pseudo est déjà pris.' USING ERRCODE = '23505';
  END IF;
  IF EXISTS (SELECT 1 FROM public.pilots WHERE lower(email) = lower(v_email)) THEN
    RAISE EXCEPTION 'Cet email est déjà associé à un pilote — utilise "Déjà pilote sur ce circuit".' USING ERRCODE = '23505';
  END IF;

  BEGIN
    INSERT INTO public.pilots (first_name, last_name, email, pseudo, birth_date)
    VALUES (trim(_first_name), trim(_last_name), v_email, v_pseudo, _birth_date)
    RETURNING id INTO v_id;
  EXCEPTION WHEN unique_violation THEN
    -- Filet de course : deux inscriptions concurrentes avec le même pseudo/
    -- email ont franchi les checks ci-dessus en même temps. L'index unique
    -- (section 1) a tranché ; on renvoie un message identique aux checks
    -- explicites, pour que le front n'ait qu'un seul cas à gérer.
    RAISE EXCEPTION 'Ce pseudo ou cet email est déjà pris.' USING ERRCODE = '23505';
  END;

  RETURN v_id;
END;
$fn$;
REVOKE ALL ON FUNCTION public.register_new_pilot(text, text, text, text, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.register_new_pilot(text, text, text, text, date) TO anon, authenticated;

-- --------------------------------------------------------------
-- 3d) session_taken_avatars — écran 2 (carrousel)
-- --------------------------------------------------------------
-- Liste des avatar_scheme déjà pris DANS CETTE SESSION, pour que le
-- carrousel les saute. Ne fuit rien de sensible (juste des entiers 0-23),
-- donc pas besoin de restreindre par tenant/token : l'id de session est
-- déjà un UUID non énumérable, obtenu via le flux normal d'inscription.
CREATE OR REPLACE FUNCTION public.session_taken_avatars(_session_id uuid)
RETURNS int[]
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
  SELECT coalesce(array_agg(avatar_scheme ORDER BY avatar_scheme), ARRAY[]::int[])
    FROM public.session_registrations
   WHERE session_id = _session_id
     AND avatar_scheme IS NOT NULL;
$fn$;
REVOKE ALL ON FUNCTION public.session_taken_avatars(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.session_taken_avatars(uuid) TO anon, authenticated;

-- --------------------------------------------------------------
-- 3e) public_registration_config — thème/logo/pack d'avatars pour
--     register.html, même pattern que public.public_site_config()
--     (voir Cloisonnement-plan-Pro-et-risques-lancement.md, Annexe A).
-- --------------------------------------------------------------
-- register.html n'a aujourd'hui AUCUNE lecture de thème/logo/pack d'avatars
-- (vérifié : ni site-config.js ni signature-avatar.js/kart-avatar.js ne
-- sont importés par register.js avant cette migration). Cette fonction
-- comble ce manque en réutilisant EXACTEMENT le même mécanisme que les
-- résultats publics : private.avatar_config(tenant_id) reste la seule
-- source de vérité pour le cloisonnement Pro (elle redescend elle-même sur
-- 'classic' si l'entitlement manque ou si l'abonnement a expiré) — cette
-- fonction ne fait AUCUN arbitrage de plan, elle relaie ce que
-- private.avatar_config() a déjà décidé, exactement comme public_site_config().
CREATE OR REPLACE FUNCTION public.public_registration_config(_registration_token text)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
  SELECT jsonb_build_object(
           'avatar_pack',       av->>'pack',
           'avatar_type',       av->>'type',
           'avatar_small_type', av->>'small_type',
           'avatar_outline',    (av->>'outline')::boolean,
           'avatar_background', av->>'background',
           'circuit_name',      s.circuit_name,
           'logo_url',          a.value->>'logo_url'
         )
    FROM public.sessions s
    LEFT JOIN public.app_settings a
      ON a.tenant_id = s.tenant_id AND a.key = 'global'
    CROSS JOIN LATERAL (SELECT private.avatar_config(s.tenant_id) AS av) cfg
   WHERE s.public_registration_token = _registration_token
   LIMIT 1;
$fn$;
REVOKE ALL ON FUNCTION public.public_registration_config(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.public_registration_config(text) TO anon, authenticated;

-- ============================================================
-- 4) TRIGGER — remplit email/first_name/last_name depuis pilots quand
--    pilot_id est renseigné (écrans 1a ET 1b)
-- ============================================================
-- Pourquoi un trigger et pas le front qui envoie les 3 champs directement :
-- à l'écran 1b ("Déjà pilote"), le front ne connaît QUE id/pseudo/first_name
-- du pilote retrouvé — find_pilot_by_query() ne renvoie JAMAIS l'email (voir
-- 3a), précisément pour qu'un visiteur qui ne connaît que le pseudo d'un
-- pilote ne puisse pas en déduire son adresse. Le front ne peut donc pas
-- écrire l'email lui-même dans ce cas. Un trigger BEFORE INSERT, en
-- SECURITY DEFINER (même schéma que autofill_tenant_id, déjà en place),
-- lit `pilots` — RLS-fermée à anon — et complète ces 3 colonnes à partir de
-- pilot_id, quelle que soit la valeur envoyée par le client. Ecran 1a
-- (nouveau pilote) passe par le même chemin : le front peut continuer à
-- envoyer first_name/last_name/email en clair (il vient de les saisir), le
-- trigger les écrase avec la version SERVEUR (celle réellement insérée par
-- register_new_pilot()) pour qu'aucun écart ne puisse s'introduire entre
-- `pilots` et `session_registrations`.
-- display_name (le PSEUDO, visible publiquement) n'est PAS touché ici :
-- il reste sous le contrôle exclusif du front, comme avant cette migration.
CREATE OR REPLACE FUNCTION public.fill_registration_from_pilot()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  p RECORD;
BEGIN
  IF NEW.pilot_id IS NOT NULL THEN
    SELECT first_name, last_name, email INTO p FROM public.pilots WHERE id = NEW.pilot_id;
    IF FOUND THEN
      NEW.first_name := p.first_name;
      NEW.last_name := p.last_name;
      NEW.email := p.email;
    END IF;
  END IF;
  RETURN NEW;
END;
$fn$;
-- Fonction de trigger uniquement : jamais appelable en RPC (même durcissement
-- que autofill_tenant_id()/handle_new_user(), voir Audit-securite-Supabase-v2.md).
REVOKE ALL ON FUNCTION public.fill_registration_from_pilot() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_fill_registration_from_pilot ON public.session_registrations;
CREATE TRIGGER trg_fill_registration_from_pilot
  BEFORE INSERT OR UPDATE OF pilot_id ON public.session_registrations
  FOR EACH ROW EXECUTE FUNCTION public.fill_registration_from_pilot();
