-- =====================================================================
-- Migration v28 — Hall of Fame public (page circuit), segmente par plan
-- =====================================================================
-- Objectif metier : les records du circuit existent deja depuis la v22
-- (table track_records, scopes 'piste'/'semaine'/'mois'/'perso'), mais
-- ne sont exploites que pour declencher les cartes/emails de record
-- (card_deliveries). Ils ne sont visibles NULLE PART en dehors de ca :
-- ni sur une page publique, ni cote admin. Cette migration les rend
-- consultables :
--   1) publiquement, depuis la page circuit (results.html?v=<venue_token>,
--      routee par le QR permanent v23) via un nouvel onglet/bouton
--      "Hall of Fame" ;
--   2) cote staff (admin), sans restriction de plan, dans le sous-onglet
--      Statistiques > Hall of Fame existant (stats.js).
-- Voir claude/Backlog-idees.md > K-16 (decision du 19/08).
--
-- Segmentation commerciale tranchee avec le fondateur le 19/08 :
--   - Starter (et Free)  : record 'piste' (all-time) uniquement, cote
--                          public. C'est deja ce qui existait avant
--                          cette migration (rien ne change pour eux
--                          hormis la visibilite publique du record).
--   - Pro / Business     : + record 'semaine' (semaine ISO en cours) et
--                          'mois' (mois calendaire en cours), cote public.
--   - Staff (admin connecte)  : voit TOUJOURS les 3 scopes, quel que
--                          soit le plan du circuit — c'est un outil de
--                          pilotage interne, pas une fonctionnalite
--                          facturee (cf. my_hall_of_fame() ci-dessous).
--   - Export (XLSX)      : cote client (stats.js > exportStatsXLSX()),
--                          les colonnes semaine/mois de la feuille
--                          "Hall of Fame" ne sont incluses QUE si le
--                          plan resolu est pro/business — meme regle
--                          que l'affichage public. Comme l'admin a deja
--                          recu la donnee complete via my_hall_of_fame()
--                          (point precedent), il ne s'agit ici que d'un
--                          filtre sur le contenu du fichier genere, pas
--                          d'une nouvelle fuite de donnees.
--
-- Principe de securite (repris de plan.js) : le filtrage Starter/Pro de
-- la RPC PUBLIQUE se fait ICI, cote serveur, jamais cote client — un
-- circuit Starter ne doit jamais recevoir les champs semaine/mois dans
-- la reponse HTTP, meme masques en CSS.
--
-- 100% ADDITIF : aucune table, colonne ou policy existante n'est
-- modifiee ni supprimee. Rejouable sans perte de donnee (create or
-- replace / grant, aucun drop).
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1. RPC publique — page circuit (visiteur anonyme, via ?v=<venue_token>)
-- ---------------------------------------------------------------------
-- Meme pattern que public_venue_sessions (v23) : token permanent du
-- circuit, SECURITY DEFINER, search_path fige, zero donnee nominative
-- au-dela du pseudo (display_name) deja public sur la page resultats.

create or replace function public.public_venue_hall_of_fame(_venue_token text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant   uuid;
  v_name     text;
  v_cfg      jsonb;
  v_logo     text;
  v_theme    text;
  v_display  text;
  v_plan     text;
  v_key_sem  text;
  v_key_mois text;
begin
  if _venue_token is null or length(trim(_venue_token)) < 16 then
    return null;
  end if;

  select t.id, t.name into v_tenant, v_name
    from public.tenants t
   where t.public_venue_token = trim(_venue_token)
   limit 1;

  if v_tenant is null then
    return null;
  end if;

  -- Meme lecture de app_settings.global que public_venue_sessions (v23),
  -- pour que l'entete (logo, theme, nom affiche) soit identique entre les
  -- deux ecrans de la page circuit.
  select a.value into v_cfg
    from public.app_settings a
   where a.tenant_id = v_tenant and a.key = 'global'
   limit 1;

  v_logo    := nullif(trim(coalesce(v_cfg->>'logo_url', '')), '');
  v_theme   := nullif(trim(coalesce(v_cfg->>'results_theme', '')), '');
  v_display := coalesce(nullif(trim(coalesce(v_cfg->>'circuit_name', '')), ''), v_name);

  -- Meme source de verite que partout ailleurs dans le projet pour
  -- resoudre le plan effectif d'un tenant (voir plan.js, my_theme_entitlement()).
  v_plan     := private.tenant_plan_code(v_tenant);
  v_key_sem  := to_char(current_date, 'IYYY"-W"IW');
  v_key_mois := to_char(current_date, 'YYYY-MM');

  return jsonb_build_object(
    'venue_name',    v_display,
    'logo_url',      v_logo,
    'results_theme', coalesce(v_theme, 'classic'),
    'plan', v_plan,

    -- Record piste (all-time) : toujours renvoye, quel que soit le plan.
    'piste', (
      select jsonb_build_object(
               'pilot',       r.display_name,
               'lap_time_s',  tr.lap_time_seconds,
               'achieved_at', tr.achieved_at
             )
        from public.track_records tr
        join public.session_registrations r on r.id = tr.registration_id
       where tr.tenant_id = v_tenant and tr.scope = 'piste' and tr.period_key = 'all'
       limit 1
    ),

    -- Semaine / mois : null pour Starter. Le filtrage est fait dans la
    -- requete elle-meme (case when), donc la donnee ne quitte jamais le
    -- serveur pour un tenant qui n'y a pas droit.
    'semaine', case when v_plan in ('pro', 'business') then (
      select jsonb_build_object(
               'pilot',       r.display_name,
               'lap_time_s',  tr.lap_time_seconds,
               'achieved_at', tr.achieved_at
             )
        from public.track_records tr
        join public.session_registrations r on r.id = tr.registration_id
       where tr.tenant_id = v_tenant and tr.scope = 'semaine' and tr.period_key = v_key_sem
       limit 1
    ) else null end,

    'mois', case when v_plan in ('pro', 'business') then (
      select jsonb_build_object(
               'pilot',       r.display_name,
               'lap_time_s',  tr.lap_time_seconds,
               'achieved_at', tr.achieved_at
             )
        from public.track_records tr
        join public.session_registrations r on r.id = tr.registration_id
       where tr.tenant_id = v_tenant and tr.scope = 'mois' and tr.period_key = v_key_mois
       limit 1
    ) else null end
  );
end;
$$;

grant execute on function public.public_venue_hall_of_fame(text) to anon, authenticated;


-- ---------------------------------------------------------------------
-- 2. RPC authentifiee — panneau admin (staff), TOUJOURS sans restriction
-- ---------------------------------------------------------------------
-- A l'inverse de la RPC publique ci-dessus, celle-ci ne filtre jamais par
-- plan : le staff du circuit doit voir piste/semaine/mois quel que soit
-- son abonnement (decision produit du 19/08 — c'est un outil de pilotage
-- interne, pas une fonctionnalite vendue). Le filtrage par plan n'existe
-- QUE pour l'export XLSX genere a partir de cette meme donnee, cote
-- front (voir stats.js > exportStatsXLSX()).

create or replace function public.my_hall_of_fame()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant   uuid;
  v_key_sem  text;
  v_key_mois text;
begin
  v_tenant := private.current_tenant_id();
  if v_tenant is null then
    return null;
  end if;

  v_key_sem  := to_char(current_date, 'IYYY"-W"IW');
  v_key_mois := to_char(current_date, 'YYYY-MM');

  return jsonb_build_object(
    'plan', private.tenant_plan_code(v_tenant),
    'piste', (
      select jsonb_build_object('pilot', r.display_name, 'lap_time_s', tr.lap_time_seconds, 'achieved_at', tr.achieved_at)
        from public.track_records tr
        join public.session_registrations r on r.id = tr.registration_id
       where tr.tenant_id = v_tenant and tr.scope = 'piste' and tr.period_key = 'all'
       limit 1
    ),
    'semaine', (
      select jsonb_build_object('pilot', r.display_name, 'lap_time_s', tr.lap_time_seconds, 'achieved_at', tr.achieved_at)
        from public.track_records tr
        join public.session_registrations r on r.id = tr.registration_id
       where tr.tenant_id = v_tenant and tr.scope = 'semaine' and tr.period_key = v_key_sem
       limit 1
    ),
    'mois', (
      select jsonb_build_object('pilot', r.display_name, 'lap_time_s', tr.lap_time_seconds, 'achieved_at', tr.achieved_at)
        from public.track_records tr
        join public.session_registrations r on r.id = tr.registration_id
       where tr.tenant_id = v_tenant and tr.scope = 'mois' and tr.period_key = v_key_mois
       limit 1
    )
  );
end;
$$;

revoke execute on function public.my_hall_of_fame() from public, anon;
grant  execute on function public.my_hall_of_fame() to authenticated;


-- ---------------------------------------------------------------------
-- Reste a faire (hors SQL, voir la PR associee)
-- ---------------------------------------------------------------------
-- - public-results.js : onglet/bouton "Hall of Fame" sur la page circuit,
--   consomme public_venue_hall_of_fame(), affiche 'semaine'/'mois' si
--   presents dans la reponse (donc jamais pour un tenant Starter).
-- - admin.html / stats.js : bloc "Records actuels (piste/semaine/mois)"
--   dans le sous-onglet Statistiques > Hall of Fame existant, consomme
--   my_hall_of_fame() (staff = toujours tout). Colonnes semaine/mois de
--   la feuille XLSX "Hall of Fame" filtrees par plan a l'export.
