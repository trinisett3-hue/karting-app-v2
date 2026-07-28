-- ============================================================
-- MIGRATION ADDITIVE — v18 (2026-07-28)
-- 1) La nationalite choisie a la premiere inscription (ecran 1a) devient
--    DEFINITIVE, portee par pilots.nationality (identite globale), au lieu
--    d'etre redemandee a chaque reconnexion (ecran 1b) : register_new_pilot()
--    la stocke, find_pilot_by_query() la restitue pour que le front la
--    reutilise silencieusement.
-- 2) update_pilot_info() / update_legacy_registration_info() : nouvel
--    editeur admin (onglet Registre) pour corriger les informations d'un
--    client apres coup, meme garde d'autorisation que delete_pilot_completely
--    / delete_legacy_registration (admin d'au moins un tenant ou ce
--    pilote/cette inscription a couru).
-- 3) set_pilot_nationality_if_unset() (v18b) : pilotes crees AVANT cette
--    migration (nationality NULL) — l'ecran 1b peut leur demander une
--    derniere fois et la figer, sans jamais ecraser une valeur deja posee.
--
-- À appliquer manuellement sur le projet Supabase (yfgrvfdjakjnmryhtpgo),
-- comme les migrations precedentes — ce fichier n'est pas rejoue
-- automatiquement. Deja applique en production le 2026-07-28 (v18 + v18b).
-- ============================================================

-- --------------------------------------------------------------
-- 1) pilots.nationality
-- --------------------------------------------------------------
ALTER TABLE public.pilots ADD COLUMN IF NOT EXISTS nationality TEXT;

-- --------------------------------------------------------------
-- 2) register_new_pilot — ajoute _nationality (parametre additif avec
--    defaut, cf. section 3c de la migration v14 : signature compatible avec
--    les appels existants a 5 arguments).
-- --------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.register_new_pilot(
  _first_name text,
  _last_name text,
  _email text,
  _pseudo text,
  _birth_date date,
  _nationality text DEFAULT NULL
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
    RAISE EXCEPTION 'Prenom manquant.' USING ERRCODE = '22023';
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
    RAISE EXCEPTION 'Ce pseudo est deja pris.' USING ERRCODE = '23505';
  END IF;
  IF EXISTS (SELECT 1 FROM public.pilots WHERE lower(email) = lower(v_email)) THEN
    RAISE EXCEPTION 'Cet email est deja associe a un pilote — utilise "Deja pilote sur ce circuit".' USING ERRCODE = '23505';
  END IF;

  BEGIN
    INSERT INTO public.pilots (first_name, last_name, email, pseudo, birth_date, nationality)
    VALUES (trim(_first_name), trim(_last_name), v_email, v_pseudo, _birth_date, nullif(trim(_nationality), ''))
    RETURNING id INTO v_id;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'Ce pseudo ou cet email est deja pris.' USING ERRCODE = '23505';
  END;

  RETURN v_id;
END;
$fn$;
REVOKE ALL ON FUNCTION public.register_new_pilot(text, text, text, text, date, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.register_new_pilot(text, text, text, text, date, text) TO anon, authenticated;

-- --------------------------------------------------------------
-- 3) find_pilot_by_query — restitue desormais la nationalite deja
--    enregistree, pour que l'ecran 1b ne la redemande plus jamais.
-- --------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.find_pilot_by_query(_query text)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
  SELECT jsonb_build_object('id', p.id, 'pseudo', p.pseudo, 'first_name', p.first_name, 'nationality', p.nationality)
    FROM public.pilots p
   WHERE lower(p.email) = lower(trim(_query))
      OR lower(p.pseudo) = lower(trim(_query))
   LIMIT 1;
$fn$;
REVOKE ALL ON FUNCTION public.find_pilot_by_query(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.find_pilot_by_query(text) TO anon, authenticated;

-- --------------------------------------------------------------
-- 4) update_pilot_info — editeur admin (Registre) pour un pilote v14+.
-- --------------------------------------------------------------
-- Meme garde d'autorisation que delete_pilot_completely : admin d'au moins
-- un tenant ou ce pilote a une inscription. Revalide pseudo/email comme
-- register_new_pilot, en excluant la propre ligne du pilote de la recherche
-- d'unicite (sinon un pilote ne pourrait jamais re-soumettre son propre
-- pseudo/email inchange).
CREATE OR REPLACE FUNCTION public.update_pilot_info(
  _pilot_id uuid,
  _first_name text,
  _last_name text,
  _email text,
  _pseudo text,
  _birth_date date,
  _nationality text
)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  v_pseudo text := trim(_pseudo);
  v_email text := trim(_email);
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM public.session_registrations sr
      JOIN public.tenant_users tu ON tu.tenant_id = sr.tenant_id
     WHERE sr.pilot_id = _pilot_id
       AND tu.user_id = auth.uid()
  ) THEN
    RAISE EXCEPTION 'Non autorise.' USING ERRCODE = '42501';
  END IF;

  IF _first_name IS NULL OR trim(_first_name) = '' THEN
    RAISE EXCEPTION 'Prenom manquant.' USING ERRCODE = '22023';
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
  IF EXISTS (SELECT 1 FROM public.pilots WHERE lower(pseudo) = lower(v_pseudo) AND id <> _pilot_id) THEN
    RAISE EXCEPTION 'Ce pseudo est deja pris.' USING ERRCODE = '23505';
  END IF;
  IF EXISTS (SELECT 1 FROM public.pilots WHERE lower(email) = lower(v_email) AND id <> _pilot_id) THEN
    RAISE EXCEPTION 'Cet email est deja associe a un autre pilote.' USING ERRCODE = '23505';
  END IF;

  UPDATE public.pilots
     SET first_name = trim(_first_name),
         last_name = trim(_last_name),
         email = v_email,
         pseudo = v_pseudo,
         birth_date = _birth_date,
         nationality = nullif(trim(_nationality), '')
   WHERE id = _pilot_id;
END;
$fn$;
REVOKE ALL ON FUNCTION public.update_pilot_info(uuid, text, text, text, text, date, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.update_pilot_info(uuid, text, text, text, text, date, text) TO authenticated;

-- --------------------------------------------------------------
-- 5) update_legacy_registration_info — editeur admin pour une inscription
--    "legacy" pre-v14 (pas de pilots row : email/nom captures directement
--    sur session_registrations).
-- --------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.update_legacy_registration_info(
  _registration_id uuid,
  _first_name text,
  _last_name text,
  _email text,
  _nationality text
)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  v_email text := trim(_email);
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM public.session_registrations sr
      JOIN public.tenant_users tu ON tu.tenant_id = sr.tenant_id
     WHERE sr.id = _registration_id
       AND tu.user_id = auth.uid()
       AND sr.pilot_id IS NULL
  ) THEN
    RAISE EXCEPTION 'Non autorise.' USING ERRCODE = '42501';
  END IF;

  IF v_email IS NULL OR v_email = '' OR v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' THEN
    RAISE EXCEPTION 'Email invalide.' USING ERRCODE = '22023';
  END IF;

  UPDATE public.session_registrations
     SET first_name = nullif(trim(_first_name), ''),
         last_name = nullif(trim(_last_name), ''),
         email = v_email,
         nationality = nullif(trim(_nationality), '')
   WHERE id = _registration_id;
END;
$fn$;
REVOKE ALL ON FUNCTION public.update_legacy_registration_info(uuid, text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.update_legacy_registration_info(uuid, text, text, text, text) TO authenticated;

-- --------------------------------------------------------------
-- 6) set_pilot_nationality_if_unset — pilotes crees AVANT v18 (nationality
--    NULL) : l'ecran 1b peut leur demander une derniere fois et la figer,
--    sans jamais ecraser une valeur deja posee (anon-callable mais no-op si
--    nationality n'est pas NULL — empeche un tiers connaissant un pseudo de
--    modifier la nationalite d'un pilote deja renseigne).
-- --------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.set_pilot_nationality_if_unset(_pilot_id uuid, _nationality text)
RETURNS void
LANGUAGE sql SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
  UPDATE public.pilots
     SET nationality = nullif(trim(_nationality), '')
   WHERE id = _pilot_id
     AND nationality IS NULL;
$fn$;
REVOKE ALL ON FUNCTION public.set_pilot_nationality_if_unset(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.set_pilot_nationality_if_unset(uuid, text) TO anon, authenticated;
