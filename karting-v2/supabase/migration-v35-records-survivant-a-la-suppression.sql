-- =====================================================================================
-- v35 — Un record ne survit plus aux donnees dont il est issu (04/09/2026)
--
-- SYMPTOME : le record all-time du circuit, affiche publiquement (page Hall of Fame du QR
-- permanent, ecran TV du kiosque), valait 1 seconde. Aucun ecran ne permettait de le
-- corriger, et supprimer la session fautive ne changeait rien.
--
-- CAUSE REELLE, mesuree : 162 des 266 lignes de track_records pointaient sur une inscription
-- supprimee. detect_records_and_enqueue_cards() est un trigger AFTER INSERT sur laps -- il
-- ne repasse jamais. Et les cles etrangeres de track_records sont en ON DELETE SET NULL :
-- supprimer une session vide les pointeurs mais LAISSE la ligne de record, temps fige, pour
-- toujours. Le record survivait litteralement aux donnees qui l'avaient produit.
--
-- Ce n'est donc pas un probleme de qualite de donnees ni de valeur aberrante : c'est un
-- record orphelin. Un seuil de plausibilite aurait masque le symptome sans toucher la cause,
-- au prix d'un reglage par circuit (une piste indoor de 300 m et un exterieur de 1 200 m
-- n'ont pas le meme plancher) et d'un risque de refuser un vrai chrono.
--
-- CORRECTIF : un rebuild deterministe depuis les tours reellement presents, declenche a
-- chaque suppression de tours. laps cascade deja depuis sessions et session_registrations,
-- donc ce seul trigger couvre les trois chemins : un tour, une inscription, une session
-- entiere. Le circuit corrige en supprimant la ligne fautive ; le record se recalcule seul
-- sur le meilleur tour restant. Rien a parametrer, aucune regle nouvelle a expliquer.
--
-- Le rebuild est complet par tenant plutot que chirurgical : supprimer des tours est un
-- geste rare et manuel, et un rebuild complet reste juste dans le temps la ou une mise a
-- jour ciblee de quatre portees finit toujours par diverger.
-- =====================================================================================

create or replace function private.rebuild_track_records(p_tenant uuid)
returns void
language plpgsql
security definer
set search_path to 'public', 'private', 'pg_temp'
as $$
begin
  if p_tenant is null then
    return;
  end if;

  delete from public.track_records where tenant_id = p_tenant;

  insert into public.track_records
    (tenant_id, scope, period_key, lap_time_seconds, registration_id, session_id, achieved_at)
  select distinct on (c.scope, c.period_key)
    p_tenant, c.scope, c.period_key, c.lap_time_seconds, c.registration_id, c.session_id, c.achieved_at
  from (
    select
      x.scope, x.period_key, l.lap_time_seconds, l.registration_id, l.session_id,
      coalesce(l.created_at, now()) as achieved_at
    from public.laps l
    join public.session_registrations r on r.id = l.registration_id
    join public.sessions s              on s.id = l.session_id
    cross join lateral (
      values
        ('perso',   coalesce(r.pilot_id::text, r.id::text)),
        ('piste',   'all'),
        ('semaine', to_char(coalesce(s.session_date, s.starts_at::date, current_date), 'IYYY"-W"IW')),
        ('mois',    to_char(coalesce(s.session_date, s.starts_at::date, current_date), 'YYYY-MM'))
    ) as x(scope, period_key)
    where l.tenant_id = p_tenant
      and l.lap_time_seconds is not null
      and l.lap_time_seconds > 0
  ) c
  order by c.scope, c.period_key, c.lap_time_seconds asc, c.achieved_at asc;
end;
$$;

revoke execute on function private.rebuild_track_records(uuid) from public, anon, authenticated;

create or replace function public.rebuild_records_after_lap_delete()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'private', 'pg_temp'
as $$
declare
  v_tenant uuid;
begin
  for v_tenant in select distinct tenant_id from deleted_laps where tenant_id is not null loop
    perform private.rebuild_track_records(v_tenant);
  end loop;
  return null;
end;
$$;

revoke execute on function public.rebuild_records_after_lap_delete() from public, anon, authenticated;

drop trigger if exists trg_rebuild_records_after_lap_delete on public.laps;

create trigger trg_rebuild_records_after_lap_delete
after delete on public.laps
referencing old table as deleted_laps
for each statement
execute function public.rebuild_records_after_lap_delete();

comment on function private.rebuild_track_records(uuid) is
  'Reconstruit integralement public.track_records pour un tenant a partir des tours reellement presents. Appelee par le trigger de suppression de tours ; garantit qu''aucun record ne survit aux donnees dont il est issu.';
