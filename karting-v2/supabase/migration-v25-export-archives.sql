-- =====================================================================
-- Migration v25 — Export des sessions archivees (CSV / XLSX)
-- =====================================================================
-- Contexte : l'onglet Archives listait les sessions mais ne permettait
-- aucune extraction. Le gerant veut un fichier exploitable (compta,
-- frequentation, remplissage) sans ouvrir chaque session une par une.
--
-- Pourquoi une RPC et pas des selects cote client : les compteurs
-- (inscriptions, participants, tours, meilleur tour) exigent une
-- agregation par session. Le faire au navigateur imposerait N+1 requetes
-- pour un export qui peut porter sur des centaines de sessions.
--
-- Perimetre : uniquement les tenants dont auth.uid() est admin. Aucune
-- donnee nominative n'est renvoyee (pas de nom, pas d'e-mail) : c'est un
-- export statistique de sessions, pas un fichier de pilotes.
--
-- 100 % ADDITIF : aucune table, colonne ou policy touchee.
-- =====================================================================

create or replace function public.admin_archived_sessions_export(
  _from date default null,
  _to   date default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, private, pg_temp
as $$
begin
  if auth.uid() is null then
    return '[]'::jsonb;
  end if;

  return coalesce((
    select jsonb_agg(x order by x->>'session_date' desc, x->>'starts_at' desc)
      from (
        select jsonb_build_object(
                 'id',                    s.id,
                 'title',                 s.title,
                 'session_type',          s.session_type,
                 'circuit_name',          s.circuit_name,
                 'session_date',          s.session_date,
                 'starts_at',             s.starts_at,
                 'created_at',            s.created_at,
                 -- Terminaison et archivage sont le meme evenement dans
                 -- l'app (confirmTerminerSession pose archived_at) : une
                 -- seule valeur, exposee sous les deux intitules cote UI.
                 'archived_at',           s.archived_at,
                 'results_published_at',  s.results_published_at,
                 'status',                s.status,
                 'max_karts',             s.max_karts,
                 'laps_planned',          s.laps_count,
                 'incident_count',        s.incident_count,
                 'interruption_minutes',  s.interruption_minutes,
                 'has_internal_notes',    (coalesce(s.internal_notes, '') <> ''),
                 'inscriptions_count',    coalesce(r.inscriptions, 0),
                 'participants_count',    coalesce(r.with_kart, 0),
                 'anonymous_count',       coalesce(r.anonymous, 0),
                 'with_email_count',      coalesce(r.with_email, 0),
                 'known_pilots_count',    coalesce(r.known_pilots, 0),
                 'racers_count',          coalesce(l.racers, 0),
                 'laps_recorded',         coalesce(l.laps, 0),
                 'best_lap_seconds',      l.best_lap,
                 'avg_lap_seconds',       l.avg_lap
               ) as x
          from public.sessions s
          join unnest(public.tenant_admin_ids(auth.uid())) as mt(tenant_id)
            on mt.tenant_id = s.tenant_id
          left join lateral (
            select count(*)                                              as inscriptions,
                   count(*) filter (where sr.kart_number is not null)    as with_kart,
                   count(*) filter (where sr.is_unknown)                 as anonymous,
                   count(*) filter (where coalesce(sr.email, '') <> '')  as with_email,
                   count(*) filter (where sr.pilot_id is not null)       as known_pilots
              from public.session_registrations sr
             where sr.session_id = s.id
          ) r on true
          left join lateral (
            select count(*)                          as laps,
                   count(distinct lp.registration_id) as racers,
                   min(lp.lap_time_seconds)          as best_lap,
                   round(avg(lp.lap_time_seconds), 3) as avg_lap
              from public.laps lp
             where lp.session_id = s.id
          ) l on true
         where s.archived_at is not null
           and (_from is null or s.session_date >= _from)
           and (_to   is null or s.session_date <= _to)
      ) q
  ), '[]'::jsonb);
end;
$$;

revoke execute on function public.admin_archived_sessions_export(date, date) from public, anon;
grant  execute on function public.admin_archived_sessions_export(date, date) to authenticated;
