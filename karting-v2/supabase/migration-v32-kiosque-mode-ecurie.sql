-- =====================================================================
-- Migration v32 — Kiosque : mode Écurie sur l'écran classement
--                 + données du championnat constructeur (3e écran)
-- =====================================================================
-- my_kiosk_ranking() (v31) renvoyait déjà le nom et la couleur d'écurie de
-- chaque pilote, mais rien qui permette au kiosque de DISTINGUER une session
-- écurie d'une session normale : ni les points (le PDF en affiche une colonne
-- en mode écurie), ni le classement par écurie.
--
-- Cette migration ajoute, sans rien retirer :
--   session.points_scale       le barème de points de la session
--   rows[].team_id / .points   l'écurie et les points de chaque pilote
--   teams[]                    le championnat constructeur, déjà classé
--
-- Le calcul reproduit exactement computeTeamStandings() / pointsForPosition()
-- de karting-v2/src/modules/teams.js — c'est ce même calcul qui alimente la
-- page publique, les cartes partageables et le PDF, et les deux ne doivent
-- jamais diverger :
--   * un pilote SANS chrono ne marque pas (sa place vient de la sentinelle de
--     tri, pas d'un résultat en piste) ;
--   * une écurie est classée sur le total de points, puis, à égalité, sur la
--     position moyenne de ses pilotes ;
--   * tiebroken signale une égalité réellement départagée aux positions, pour
--     que l'écran l'annonce au lieu de la faire passer pour une victoire nette.
--
-- 100 % ADDITIF : aucune table, colonne ou policy touchée. Rejouable.
-- =====================================================================

create or replace function public.my_kiosk_ranking()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, private, pg_temp
as $$
declare
  v_tenant     uuid;
  v_session    public.sessions;
  v_team_on    boolean;
  v_track_best numeric;
  v_scale      jsonb;
begin
  v_tenant := private.current_tenant_id();
  if v_tenant is null then
    return null;
  end if;

  select * into v_session
    from public.sessions s
   where s.tenant_id = v_tenant
     and (s.status = 'results_published' or s.results_published_at is not null)
   order by coalesce(s.results_published_at, s.created_at) desc
   limit 1;

  if v_session.id is null then
    return jsonb_build_object('session', null, 'rows', '[]'::jsonb, 'teams', '[]'::jsonb);
  end if;

  v_team_on := coalesce(v_session.team_mode, false)
               and private.tenant_has_team_mode(v_session.tenant_id);

  -- Même barème par défaut que public_session_results() et teams.js.
  v_scale := coalesce(v_session.points_scale, '[25,18,15,12,10,8,6,4,2,1]'::jsonb);

  select min(l.lap_time_seconds) into v_track_best
    from public.laps l
    join public.sessions s2 on s2.id = l.session_id
   where s2.tenant_id = v_tenant
     and (s2.status = 'results_published' or s2.results_published_at is not null);

  return (
    with base as (
      select r.display_name,
             coalesce(r.is_unknown, false) as is_unknown,
             r.nationality, r.kart_number, r.avatar_scheme,
             d.photo_url,
             b.best_lap,
             coalesce(b.laps_count, 0) as laps_count,
             case when v_team_on then r.team_id else null end as team_id,
             case when v_team_on then vt.name    else null end as team_name,
             case when v_team_on then vt.color   else null end as team_color,
             case when v_team_on then vt.short   else null end as team_short
        from public.session_registrations r
        left join (
          select l.registration_id,
                 min(l.lap_time_seconds) as best_lap,
                 count(*)                as laps_count
            from public.laps l
           where l.session_id = v_session.id
           group by l.registration_id
        ) b on b.registration_id = r.id
        left join public.drivers d on d.id = r.driver_id
        left join public.v_tenant_team_catalog vt
               on vt.tenant_id = v_session.tenant_id and vt.team_id = r.team_id
       where r.session_id = v_session.id
    ),
    ranked as (
      select base.*,
             row_number() over (order by base.best_lap asc nulls last,
                                         base.kart_number asc nulls last) as rn,
             min(base.best_lap) over () as leader_best
        from base
    ),
    scored as (
      -- Points : barème[position-1], et 0 pour qui n'a pas de chrono.
      select ranked.*,
             case when ranked.best_lap is null then 0
                  else coalesce((v_scale ->> (ranked.rn - 1)::int)::numeric, 0) end as points
        from ranked
    ),
    team_agg as (
      select scored.team_id,
             max(scored.team_name)  as team_name,
             max(scored.team_color) as team_color,
             max(scored.team_short) as team_short,
             sum(scored.points)     as points,
             avg(scored.rn)         as avg_pos,
             count(*)               as members
        from scored
       where scored.team_id is not null
         and scored.best_lap is not null
       group by scored.team_id
    ),
    team_ranked as (
      select team_agg.*,
             row_number() over (order by team_agg.points desc, team_agg.avg_pos asc) as rank,
             lag(team_agg.points)  over (order by team_agg.points desc, team_agg.avg_pos asc) as pts_prev,
             lead(team_agg.points) over (order by team_agg.points desc, team_agg.avg_pos asc) as pts_next
        from team_agg
    )
    select jsonb_build_object(
      'session', jsonb_build_object(
        'id',            v_session.id,
        'title',         v_session.title,
        'session_date',  v_session.session_date,
        'session_type',  v_session.session_type,
        'starts_at',     v_session.starts_at,
        'published_at',  v_session.results_published_at,
        'team_mode',     v_team_on,
        'points_scale',  v_scale,
        'results_token', v_session.public_results_token,
        'track_best',    v_track_best
      ),
      'rows', coalesce((
        select jsonb_agg(jsonb_build_object(
                 'pos',        scored.rn,
                 'pilot',      scored.display_name,
                 'unknown',    scored.is_unknown,
                 'nat',        scored.nationality,
                 'kart',       scored.kart_number,
                 'scheme',     scored.avatar_scheme,
                 'photo',      scored.photo_url,
                 'best_lap',   scored.best_lap,
                 'laps_count', scored.laps_count,
                 'has_time',   scored.best_lap is not null,
                 'gap',        case when scored.best_lap is null then null
                                    else round((scored.best_lap - scored.leader_best)::numeric, 3) end,
                 'is_record',  scored.best_lap is not null and v_track_best is not null
                               and scored.best_lap <= v_track_best,
                 'points',     case when v_team_on then scored.points else null end,
                 'team_id',    scored.team_id,
                 'team_name',  scored.team_name,
                 'team_color', scored.team_color
               ) order by scored.rn)
          from scored
      ), '[]'::jsonb),
      'teams', case when not v_team_on then '[]'::jsonb else coalesce((
        select jsonb_agg(jsonb_build_object(
                 'rank',       tr.rank,
                 'team_id',    tr.team_id,
                 'name',       tr.team_name,
                 'short',      tr.team_short,
                 'color',      tr.team_color,
                 'points',     tr.points,
                 'avg_pos',    round(tr.avg_pos::numeric, 2),
                 'members',    tr.members,
                 'tiebroken',  (tr.pts_prev is not null and tr.pts_prev = tr.points)
                               or (tr.pts_next is not null and tr.pts_next = tr.points),
                 'pilots',     coalesce((
                    select jsonb_agg(jsonb_build_object(
                             'pos',      s2.rn,
                             'pilot',    s2.display_name,
                             'unknown',  s2.is_unknown,
                             'nat',      s2.nationality,
                             'kart',     s2.kart_number,
                             'scheme',   s2.avatar_scheme,
                             'photo',    s2.photo_url,
                             'best_lap', s2.best_lap,
                             'points',   s2.points
                           ) order by s2.rn)
                      from scored s2
                     where s2.team_id = tr.team_id and s2.best_lap is not null
                 ), '[]'::jsonb)
               ) order by tr.rank)
          from team_ranked tr
      ), '[]'::jsonb) end
    )
  );
end;
$$;

revoke execute on function public.my_kiosk_ranking() from public, anon;
grant  execute on function public.my_kiosk_ranking() to authenticated;
