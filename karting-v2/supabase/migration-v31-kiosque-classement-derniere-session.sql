create or replace function public.my_kiosk_ranking()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, private, pg_temp
as $$
declare
  v_tenant  uuid;
  v_session public.sessions;
  v_team_on boolean;
  v_track_best numeric;
begin
  v_tenant := private.current_tenant_id();
  if v_tenant is null then
    return null;
  end if;

  -- Derniere session PUBLIEE du circuit : c'est elle que le public vient de
  -- courir, donc celle qui doit s'afficher a l'accueil. Meme critere que la
  -- page publique (status results_published OU results_published_at pose).
  select * into v_session
    from public.sessions s
   where s.tenant_id = v_tenant
     and (s.status = 'results_published' or s.results_published_at is not null)
   order by coalesce(s.results_published_at, s.created_at) desc
   limit 1;

  if v_session.id is null then
    return jsonb_build_object('session', null, 'rows', '[]'::jsonb);
  end if;

  v_team_on := coalesce(v_session.team_mode, false)
               and private.tenant_has_team_mode(v_session.tenant_id);

  -- Meilleur tour absolu du circuit, toutes sessions publiees confondues :
  -- sert a signaler un record de piste battu ou egale pendant cette session.
  select min(l.lap_time_seconds) into v_track_best
    from public.laps l
    join public.sessions s2 on s2.id = l.session_id
   where s2.tenant_id = v_tenant
     and (s2.status = 'results_published' or s2.results_published_at is not null);

  return jsonb_build_object(
    'session', jsonb_build_object(
      'id',            v_session.id,
      'title',         v_session.title,
      'session_date',  v_session.session_date,
      'session_type',  v_session.session_type,
      'starts_at',     v_session.starts_at,
      'published_at',  v_session.results_published_at,
      'team_mode',     v_team_on,
      'results_token', v_session.public_results_token,
      'track_best',    v_track_best
    ),
    'rows', coalesce((
      select jsonb_agg(jsonb_build_object(
               'pos',        ranked.rn,
               'pilot',      ranked.display_name,
               'unknown',    ranked.is_unknown,
               'nat',        ranked.nationality,
               'kart',       ranked.kart_number,
               'scheme',     ranked.avatar_scheme,
               'photo',      ranked.photo_url,
               'best_lap',   ranked.best_lap,
               'laps_count', ranked.laps_count,
               'has_time',   ranked.best_lap is not null,
               'gap',        case when ranked.best_lap is null then null
                                  else round((ranked.best_lap - ranked.leader_best)::numeric, 3) end,
               'is_record',  ranked.best_lap is not null and v_track_best is not null
                             and ranked.best_lap <= v_track_best,
               'team_name',  ranked.team_name,
               'team_color', ranked.team_color
             ) order by ranked.rn)
        from (
          select t.*,
                 row_number() over (order by t.best_lap asc nulls last, t.kart_number asc nulls last) as rn,
                 min(t.best_lap) over () as leader_best
            from (
              select r.display_name, r.nationality, r.kart_number, r.avatar_scheme,
                     coalesce(r.is_unknown, false) as is_unknown,
                     d.photo_url,
                     b.best_lap,
                     coalesce(b.laps_count, 0) as laps_count,
                     case when v_team_on then vt.name  else null end as team_name,
                     case when v_team_on then vt.color else null end as team_color
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
            ) t
        ) ranked
    ), '[]'::jsonb)
  );
end;
$$;

revoke execute on function public.my_kiosk_ranking() from public, anon;
grant  execute on function public.my_kiosk_ranking() to authenticated;
