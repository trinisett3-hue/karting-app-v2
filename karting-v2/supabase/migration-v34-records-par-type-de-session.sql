-- =====================================================================================
-- v34 — Records par type de session (03/09/2026)
--
-- Demande client : "les records par type de session".
--
-- my_hall_of_fame() (v28) lit la table materialisee public.track_records, qui ne connait
-- que trois portees : piste / semaine / mois. Y ajouter une dimension "type de session"
-- aurait voulu dire etendre le trigger de detection de record ET rejouer tout l'historique
-- pour remplir les lignes manquantes. Disproportionne : on agrege ici a la volee.
--
-- Cout : un parcours de laps filtre par tenant (idx_laps_tenant) avec deux jointures sur
-- cle primaire. A l'echelle d'un circuit de karting loisir — quelques dizaines de milliers
-- de tours par an — c'est instantane. Si un jour ca ne l'est plus, la reponse sera une vue
-- materialisee rafraichie a la publication des resultats, pas un index de plus.
--
-- Choix de perimetre, volontaires :
--   * Les sessions SANS type ne sont pas ecartees : elles remontent sous la valeur '' et
--     l'interface les affiche en "Non renseigne". Un total qui ne tombe pas juste fait
--     douter de tout l'onglet, y compris des chiffres justes.
--   * On renvoie la VALEUR du type (session_type), jamais un libelle. Le libelle appartient
--     a l'organisation, il vit dans app_settings.value.session_types et peut etre renomme :
--     c'est sessionTypeLabel() cote navigateur qui traduit, avec repli sur la valeur si le
--     type a ete supprime. Aucune table de correspondance dupliquee en base.
--   * En cas d'egalite au millieme, le record revient a la session la PLUS ANCIENNE : un
--     record se prend, il ne se reprend pas a egalite.
--
-- Reserve au staff connecte : revoke sur anon, comme my_hall_of_fame et my_kiosk_ranking.
-- =====================================================================================

create or replace function public.my_records_by_session_type()
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public', 'private', 'pg_temp'
as $$
declare
  v_tenant uuid;
  v_out    jsonb;
begin
  v_tenant := private.current_tenant_id();
  if v_tenant is null then
    return null;
  end if;

  with base as (
    select
      coalesce(nullif(btrim(s.session_type), ''), '') as type_value,
      l.lap_time_seconds,
      r.display_name,
      s.session_date,
      s.id as session_id
    from public.laps l
    join public.session_registrations r on r.id = l.registration_id
    join public.sessions s              on s.id = r.session_id
    where l.tenant_id = v_tenant
      and s.tenant_id = v_tenant
      and l.lap_time_seconds is not null
      and l.lap_time_seconds > 0
  ),
  agg as (
    select
      type_value,
      count(*)                  as laps_total,
      count(distinct session_id) as sessions_total,
      min(lap_time_seconds)     as best
    from base
    group by type_value
  ),
  who as (
    select distinct on (b.type_value)
      b.type_value, b.display_name, b.session_date, b.lap_time_seconds
    from base b
    join agg a on a.type_value = b.type_value and a.best = b.lap_time_seconds
    order by b.type_value, b.session_date asc, b.display_name asc
  )
  select coalesce(
           jsonb_agg(
             jsonb_build_object(
               'type_value',  a.type_value,
               'lap_time_s',  a.best,
               'pilot',       w.display_name,
               'achieved_at', w.session_date,
               'laps',        a.laps_total,
               'sessions',    a.sessions_total
             )
             order by a.best asc
           ),
           '[]'::jsonb)
    into v_out
    from agg a
    join who w on w.type_value = a.type_value;

  return coalesce(v_out, '[]'::jsonb);
end;
$$;

revoke execute on function public.my_records_by_session_type() from public, anon;
grant  execute on function public.my_records_by_session_type() to authenticated;

comment on function public.my_records_by_session_type() is
  'Meilleur tour par type de session pour le tenant courant. Renvoie la valeur brute de '
  'sessions.session_type (chaine vide pour les sessions sans type) : la traduction en '
  'libelle appartient au navigateur (state.js sessionTypeLabel). Staff uniquement.';
