-- =====================================================================
-- Migration v29 — Mode kiosque (K-28) : Hall of Fame top 20 par catégorie
-- =====================================================================
-- Contexte produit (décisions du 25/08 avec le fondateur, dernier mot) :
--   L'écran kiosque (TV/mini-PC à l'accueil) n'est PAS une page publique.
--   C'est un affichage géré par le STAFF, sur l'ordinateur de l'admin,
--   depuis un navigateur DÉJÀ connecté à l'admin (session Supabase
--   normale, persistée comme sur admin.html). Il n'y a donc AUCUN besoin
--   d'un jeton public dédié ni d'une nouvelle RPC anonyme : contrairement
--   aux tentatives précédentes (v29 kiosk_token, abandonnée avant d'être
--   appliquée — jamais poussée en prod), rien ici n'élargit ce qu'un
--   visiteur anonyme peut lire.
--
--   Deux écrans, tous les deux consommés par kiosk.html (page staff,
--   authentifiée) :
--   1) Le classement PDF que reçoivent les pilotes (classement.pdf, déjà
--      généré à la publication et stocké dans le bucket privé
--      session-exports — voir session_assets, kind='full_pdf'). Aucune
--      RPC nécessaire : la policy de lecture existante
--      "exports lisibles par les admins du circuit" couvre déjà ce cas
--      via un client Supabase authentifié (storage.createSignedUrl côté
--      front, avec la session de l'admin).
--   2) Hall of Fame TOP 20 par type de session (catégorie), avec avatar
--      et nationalité — objet de cette migration, seule chose qui manque
--      réellement côté SQL. Calculé à la volée depuis laps/sessions
--      (comme la tentative précédente), mais AUTHENTIFIÉ et sans
--      restriction de plan (même philosophie que my_hall_of_fame() —
--      outil de pilotage interne, pas une fonctionnalité facturée) :
--      pas de gating pro/business à faire, le staff voit tout.
--
-- 100% ADDITIF : aucune table, colonne ou policy existante n'est modifiée
-- ni supprimée. Rejouable sans perte de donnée (create or replace, aucun
-- drop). Seules les sessions au statut 'results_published' sont comptées.
-- =====================================================================

create or replace function public.my_hall_of_fame_top20()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid;
begin
  v_tenant := private.current_tenant_id();
  if v_tenant is null then
    return null;
  end if;

  return jsonb_build_object(
    'types', (
      select coalesce(jsonb_agg(rec order by rec->>'session_type'), '[]'::jsonb)
        from (
          select distinct s.session_type
            from public.sessions s
           where s.tenant_id = v_tenant
             and s.status = 'results_published'
             and s.session_type is not null
             and trim(s.session_type) <> ''
        ) types
        cross join lateral (
          select jsonb_build_object(
            'session_type', types.session_type,
            'rows', (
              -- row_number() (fenêtre) et jsonb_agg (agrégat) ne peuvent pas
              -- cohabiter dans la même liste de projection : le rang est
              -- calculé dans un niveau intermédiaire (ranked), agrégé ensuite.
              select coalesce(jsonb_agg(jsonb_build_object(
                       'pos',          ranked.rn,
                       'pilot',        ranked.display_name,
                       'nat',          ranked.nationality,
                       'lap_time_s',   ranked.best_time,
                       'achieved_at',  ranked.achieved_at,
                       'kart',         ranked.kart_number,
                       'scheme',       ranked.avatar_scheme,
                       'photo',        ranked.photo_url
                     ) order by ranked.rn), '[]'::jsonb)
                from (
                  select t.*, row_number() over (order by t.best_time asc) as rn
                    from (
                      -- meilleur tour par pilote (registration) pour ce type
                      -- de session, puis les 20 premiers seulement.
                      select r.display_name, r.nationality, r.kart_number, r.avatar_scheme,
                             d.photo_url, bl.best_time, bl.achieved_at
                        from (
                          select distinct on (l.registration_id)
                                 l.registration_id, l.lap_time_seconds as best_time, l.created_at as achieved_at
                            from public.laps l
                            join public.sessions s2 on s2.id = l.session_id
                           where s2.tenant_id = v_tenant
                             and s2.status = 'results_published'
                             and s2.session_type = types.session_type
                           order by l.registration_id, l.lap_time_seconds asc
                        ) bl
                        join public.session_registrations r on r.id = bl.registration_id
                        left join public.drivers d on d.id = r.driver_id
                       order by bl.best_time asc
                       limit 20
                    ) t
                ) ranked
            )
          ) as rec
        ) built
       where built.rec->'rows' <> '[]'::jsonb
    )
  );
end;
$$;

revoke execute on function public.my_hall_of_fame_top20() from public, anon;
grant  execute on function public.my_hall_of_fame_top20() to authenticated;


-- ---------------------------------------------------------------------
-- Reste à faire (hors SQL)
-- ---------------------------------------------------------------------
-- - kiosk.html / kiosk.js (nouvelle page, staff authentifié) : écran 1 =
--   PDF classement.pdf de la dernière session publiée (signed URL via le
--   client Supabase authentifié, storage privé session-exports, policy
--   déjà en place) ; écran 2 = my_hall_of_fame_top20() ci-dessus.
