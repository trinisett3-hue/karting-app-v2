-- =====================================================================================
-- v36 — Hall of Fame par type de session, generalise (04/09/2026)
--
-- Demande client : "top 10 pour l'onglet, et 20 par type de session sur l'ecran".
--
-- La moitie ecran EXISTAIT DEJA : my_hall_of_fame_top20() (v30, 26/08) renvoie le top 20 par
-- type, un pilote par ligne, sessions publiees seulement, et kiosk-app.js fait deja defiler
-- les categories. Rien a construire de ce cote -- verifie dans le code avant d'ecrire une
-- ligne.
--
-- On ne duplique donc pas ce corps pour l'onglet : on le generalise avec une limite, et
-- top20() devient un simple appel. Une seule implementation derriere les deux affichages,
-- donc jamais un classement d'ecran qui diverge du classement d'onglet.
--
-- _include_untyped : le kiosque n'affiche que des categories nommees (false, comportement
-- strictement inchange). L'onglet du staff montre aussi les sessions sans type, sous une
-- ligne explicite, pour que ses totaux restent verifiables.
--
-- Effet de bord assume, corrige ici : my_records_by_session_type() (v34) comptait TOUS les
-- tours alors que le Hall of Fame ne compte que les sessions publiees. Les deux blocs
-- voisins du meme onglet pouvaient donc afficher un record different du 1er du top 10 --
-- la pire sorte d'incoherence, celle qui fait douter des deux chiffres a la fois. Aligne sur
-- les sessions publiees, regle deja appliquee partout ailleurs pour un record.
-- =====================================================================================

create or replace function public.my_hall_of_fame_by_type(
  _limit integer default 10,
  _include_untyped boolean default false
)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public', 'private', 'pg_temp'
as $$
declare
  v_tenant uuid;
  v_limit  integer := greatest(1, least(coalesce(_limit, 10), 100));
begin
  v_tenant := private.current_tenant_id();
  if v_tenant is null then
    return null;
  end if;

  return jsonb_build_object(
    'types', (
      select coalesce(jsonb_agg(built.rec order by built.rec->>'session_type'), '[]'::jsonb)
        from (
          select distinct coalesce(nullif(btrim(s.session_type), ''), '') as session_type
            from public.sessions s
           where s.tenant_id = v_tenant
             and s.status = 'results_published'
             and (
               (s.session_type is not null and btrim(s.session_type) <> '')
               or coalesce(_include_untyped, false)
             )
        ) types
        cross join lateral (
          select jsonb_build_object(
            'session_type', types.session_type,
            'rows', (
              select coalesce(jsonb_agg(jsonb_build_object(
                       'pos',         ranked.rn,
                       'pilot',       ranked.display_name,
                       'nat',         ranked.nationality,
                       'lap_time_s',  ranked.best_time,
                       'achieved_at', ranked.achieved_at,
                       'kart',        ranked.kart_number,
                       'scheme',      ranked.avatar_scheme,
                       'photo',       ranked.photo_url
                     ) order by ranked.rn), '[]'::jsonb)
                from (
                  select t.*, row_number() over (order by t.best_time asc, t.achieved_at asc) as rn
                    from (
                      select r.display_name, r.nationality, r.kart_number, r.avatar_scheme,
                             d.photo_url, bl.best_time, bl.achieved_at
                        from (
                          select distinct on (l.registration_id)
                                 l.registration_id,
                                 l.lap_time_seconds as best_time,
                                 l.created_at       as achieved_at
                            from public.laps l
                            join public.sessions s2 on s2.id = l.session_id
                           where s2.tenant_id = v_tenant
                             and s2.status = 'results_published'
                             and coalesce(nullif(btrim(s2.session_type), ''), '') = types.session_type
                             and l.lap_time_seconds is not null
                             and l.lap_time_seconds > 0
                           order by l.registration_id, l.lap_time_seconds asc
                        ) bl
                        join public.session_registrations r on r.id = bl.registration_id
                        left join public.drivers d on d.id = r.driver_id
                       order by bl.best_time asc
                       limit v_limit
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

revoke execute on function public.my_hall_of_fame_by_type(integer, boolean) from public, anon;
grant  execute on function public.my_hall_of_fame_by_type(integer, boolean) to authenticated;

create or replace function public.my_hall_of_fame_top20()
returns jsonb
language sql
stable
security definer
set search_path to 'public', 'private', 'pg_temp'
as $$
  select public.my_hall_of_fame_by_type(20, false);
$$;

revoke execute on function public.my_hall_of_fame_top20() from public, anon;
grant  execute on function public.my_hall_of_fame_top20() to authenticated;

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
      l.lap_time_seconds, r.display_name, s.session_date, s.id as session_id
    from public.laps l
    join public.session_registrations r on r.id = l.registration_id
    join public.sessions s              on s.id = r.session_id
    where l.tenant_id = v_tenant
      and s.tenant_id = v_tenant
      and s.status = 'results_published'
      and l.lap_time_seconds is not null
      and l.lap_time_seconds > 0
  ),
  agg as (
    select type_value, count(*) as laps_total, count(distinct session_id) as sessions_total,
           min(lap_time_seconds) as best
    from base group by type_value
  ),
  who as (
    select distinct on (b.type_value)
      b.type_value, b.display_name, b.session_date, b.lap_time_seconds
    from base b
    join agg a on a.type_value = b.type_value and a.best = b.lap_time_seconds
    order by b.type_value, b.session_date asc, b.display_name asc
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'type_value',  a.type_value,
           'lap_time_s',  a.best,
           'pilot',       w.display_name,
           'achieved_at', w.session_date,
           'laps',        a.laps_total,
           'sessions',    a.sessions_total
         ) order by a.best asc), '[]'::jsonb)
    into v_out
    from agg a join who w on w.type_value = a.type_value;

  return coalesce(v_out, '[]'::jsonb);
end;
$$;
