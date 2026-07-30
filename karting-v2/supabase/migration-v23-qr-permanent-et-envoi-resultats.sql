-- =====================================================================
-- Migration v23 — QR permanent imprime + envoi automatique des resultats
-- =====================================================================
-- Objectif metier : le pilote n'a plus rien a scanner a la fin de la
-- session. Il recoit ses resultats par e-mail. Le QR devient un objet
-- physique permanent (plaque imprimee, expediee par voie postale) qui
-- pointe vers une page d'accueil du circuit, et non plus vers une
-- session precise.
--
-- 100 % ADDITIF : aucune colonne, table ou policy existante n'est
-- supprimee ni modifiee de facon destructrice. Rejouable sans perte de
-- donnee (if not exists / or replace / update conditionnels).
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1. Token public permanent du circuit (pour la plaque QR imprimee)
-- ---------------------------------------------------------------------
-- Contrairement a sessions.public_registration_token, qui est jetable et
-- change a chaque session, ce token vit aussi longtemps que le circuit.
-- C'est lui qui est encode dans le QR imprime.

alter table public.tenants
  add column if not exists public_venue_token text;

-- Backfill : un token pour chaque circuit qui n'en a pas encore.
update public.tenants
   set public_venue_token = replace(gen_random_uuid()::text, '-', '')
 where public_venue_token is null;

alter table public.tenants
  alter column public_venue_token set default replace(gen_random_uuid()::text, '-', '');

create unique index if not exists tenants_public_venue_token_idx
  on public.tenants (public_venue_token);


-- ---------------------------------------------------------------------
-- 2. Horodatage de la publication des resultats
-- ---------------------------------------------------------------------
-- Necessaire pour la fenetre glissante de 6 h de la page publique :
-- sessions.status ne dit pas QUAND les resultats ont ete publies.

alter table public.sessions
  add column if not exists results_published_at timestamptz;

-- Backfill raisonnable pour les sessions deja publiees : on retombe sur
-- l'horaire de debut, faute de mieux. Aucune donnee ecrasee.
update public.sessions
   set results_published_at = coalesce(starts_at, session_date::timestamptz, created_at)
 where status = 'results_published'
   and results_published_at is null;

create index if not exists sessions_results_published_at_idx
  on public.sessions (tenant_id, results_published_at desc)
  where status = 'results_published';


-- ---------------------------------------------------------------------
-- 3. Plaques QR expediees (suivi prestataire)
-- ---------------------------------------------------------------------
-- Toutes les plaques d'un meme circuit portent la MEME url : un seul
-- token par circuit, donc un seul visuel a imprimer en n exemplaires.

create table if not exists public.qr_plaques (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  encoded_url text not null,
  quantity    int  not null default 1 check (quantity > 0),
  shipped_at  date,
  tracking    text,
  note        text,
  created_at  timestamptz not null default now()
);

create index if not exists qr_plaques_tenant_idx on public.qr_plaques (tenant_id);

alter table public.qr_plaques enable row level security;

drop policy if exists qr_plaques_auth on public.qr_plaques;

-- Le circuit voit ses propres plaques (lecture/ecriture). Le prestataire
-- passe par le service_role cote back-office, jamais par le frontend.
create policy qr_plaques_auth on public.qr_plaques
  for all using      (tenant_id is not null and tenant_id = private.current_tenant_id())
           with check (tenant_id is not null and tenant_id = private.current_tenant_id());


-- ---------------------------------------------------------------------
-- 4. RPC publique de la page d'accueil du circuit (visiteur anonyme)
-- ---------------------------------------------------------------------
-- Expose STRICTEMENT le minimum : de quoi rejoindre une session ouverte
-- et de quoi ouvrir des resultats publies recents. Aucun e-mail, aucun
-- nom de pilote, aucune liste d'inscrits, aucun identifiant interne
-- au-dela de ceux deja publics.

create or replace function public.public_venue_sessions(_venue_token text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid;
  v_name   text;
  v_logo   text;
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

  select a.value->>'logo_url' into v_logo
    from public.app_settings a
   where a.tenant_id = v_tenant and a.key = 'global'
   limit 1;

  return jsonb_build_object(
    'venue_name', v_name,
    'logo_url',   v_logo,
    -- Sessions ouvertes a l'inscription, du jour uniquement.
    'open_sessions', coalesce((
      select jsonb_agg(jsonb_build_object(
               'title',              s.title,
               'starts_at',          s.starts_at,
               'circuit_name',       s.circuit_name,
               'registration_token', s.public_registration_token
             ) order by s.starts_at nulls last)
        from public.sessions s
       where s.tenant_id = v_tenant
         and s.status = 'registration_open'
         and s.archived_at is null
         and s.public_registration_token is not null
         and coalesce(s.session_date, s.starts_at::date) = current_date
    ), '[]'::jsonb),
    -- Resultats publies dans les 6 dernieres heures (demi-journee glissante).
    'recent_results', coalesce((
      select jsonb_agg(jsonb_build_object(
               'title',         s.title,
               'starts_at',     s.starts_at,
               'published_at',  s.results_published_at,
               'results_token', s.public_results_token
             ) order by s.results_published_at desc)
        from public.sessions s
       where s.tenant_id = v_tenant
         and s.status = 'results_published'
         and s.archived_at is null
         and s.public_results_token is not null
         and s.results_published_at > now() - interval '6 hours'
    ), '[]'::jsonb)
  );
end;
$$;

grant execute on function public.public_venue_sessions(text) to anon, authenticated;


-- ---------------------------------------------------------------------
-- 5. Cartes position : pour TOUT LE MONDE, a la publication
-- ---------------------------------------------------------------------
-- Correction de v22 : la carte position n'y etait enfilee que si un
-- record venait d'etre battu, donc la majorite des pilotes ne recevait
-- rien. Elle doit partir pour chaque inscrit ayant un e-mail.

create or replace function public.enqueue_position_cards(_session_id uuid)
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid;
  v_date   date;
  v_count  int := 0;
begin
  select s.tenant_id, coalesce(s.session_date, s.starts_at::date, current_date)
    into v_tenant, v_date
    from public.sessions s
   where s.id = _session_id;

  if v_tenant is null then
    return 0;
  end if;

  -- Reserve au personnel du circuit : un anonyme ne doit pas pouvoir
  -- declencher des envois.
  if v_tenant <> private.current_tenant_id() then
    raise exception 'acces refuse';
  end if;

  -- Un pilote sans e-mail (ajout manuel anonyme) ne genere aucun envoi.
  with ins as (
    insert into public.card_deliveries
      (tenant_id, session_id, registration_id, email, kind, scope, payload)
    select v_tenant, _session_id, r.id, r.email, 'position', null,
           jsonb_build_object('date', v_date)
      from public.session_registrations r
     where r.session_id = _session_id
       and r.email is not null
       and length(trim(r.email)) > 3
    on conflict do nothing
    returning 1
  )
  select count(*) into v_count from ins;

  return v_count;
end;
$$;

revoke execute on function public.enqueue_position_cards(uuid) from public, anon;
grant  execute on function public.enqueue_position_cards(uuid) to authenticated;


-- Le declencheur de records ne s'occupe plus de la carte position : il
-- ne gere que les records. Le reste de la logique v22 est inchange.
create or replace function public.detect_records_and_enqueue_cards()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_date   date;
  v_email  text;
  v_pilot  text;
  v_scope  text;
  v_key    text;
  v_best   numeric;
begin
  if new.lap_time_seconds is null or new.lap_time_seconds <= 0 then
    return new;
  end if;

  select coalesce(s.session_date, s.starts_at::date, current_date)
    into v_date
    from public.sessions s where s.id = new.session_id;
  v_date := coalesce(v_date, current_date);

  select r.email, coalesce(r.pilot_id::text, r.id::text)
    into v_email, v_pilot
    from public.session_registrations r where r.id = new.registration_id;

  foreach v_scope in array array['perso','piste','semaine','mois'] loop
    v_key := case v_scope
      when 'perso'   then coalesce(v_pilot, new.registration_id::text)
      when 'piste'   then 'all'
      when 'semaine' then to_char(v_date, 'IYYY"-W"IW')
      else                to_char(v_date, 'YYYY-MM')
    end;

    select lap_time_seconds into v_best
      from public.track_records
     where tenant_id = new.tenant_id and scope = v_scope and period_key = v_key;

    if v_best is null or new.lap_time_seconds < v_best then
      insert into public.track_records
        (tenant_id, scope, period_key, lap_time_seconds, registration_id, session_id, achieved_at)
      values
        (new.tenant_id, v_scope, v_key, new.lap_time_seconds, new.registration_id, new.session_id, now())
      on conflict (tenant_id, scope, period_key) do update
        set lap_time_seconds = excluded.lap_time_seconds,
            registration_id  = excluded.registration_id,
            session_id       = excluded.session_id,
            achieved_at      = excluded.achieved_at;

      -- Un premier temps n'est pas un record : on ne notifie que si un
      -- precedent existait et vient d'etre battu. Et jamais sans e-mail.
      if v_best is not null and v_email is not null and length(trim(v_email)) > 3 then
        insert into public.card_deliveries
          (tenant_id, session_id, registration_id, email, kind, scope, payload)
        values
          (new.tenant_id, new.session_id, new.registration_id, v_email, 'record', v_scope,
           jsonb_build_object('time', new.lap_time_seconds, 'prev', v_best,
                              'delta', round(v_best - new.lap_time_seconds, 3),
                              'period_key', v_key, 'date', v_date))
        on conflict do nothing;
      end if;
    end if;
  end loop;

  return new;
end;
$$;

revoke execute on function public.detect_records_and_enqueue_cards() from public, anon, authenticated;


-- ---------------------------------------------------------------------
-- 6. File d'envoi : on n'envoie que ce qui est publie
-- ---------------------------------------------------------------------
-- Les cartes record sont enfilees tour par tour, donc bien avant la fin
-- de la session. L'Edge Function ne doit consommer une ligne que si la
-- session correspondante est publiee : c'est la publication qui declenche
-- l'envoi, et elle seule.

create or replace view public.card_deliveries_ready as
  select d.*
    from public.card_deliveries d
    join public.sessions s on s.id = d.session_id
   where d.status = 'pending'
     and s.status = 'results_published'
     and d.email is not null
     and length(trim(d.email)) > 3;

-- security_invoker : la vue ne doit surtout pas contourner les policies
-- RLS de card_deliveries. Sans cela une vue appartenant a postgres lit
-- toutes les lignes de tous les circuits.
alter view public.card_deliveries_ready set (security_invoker = true);

revoke all on public.card_deliveries_ready from anon;


-- ---------------------------------------------------------------------
-- Reste a faire (hors SQL)
-- ---------------------------------------------------------------------
-- L'Edge Function consomme card_deliveries_ready, REGROUPE PAR PILOTE
-- (registration_id) et envoie UN SEUL e-mail contenant : le PDF complet
-- de la session, le PDF du pilote, la carte position, et les cartes
-- record eventuelles. Puis elle passe toutes les lignes du groupe a
-- 'sent' (ou 'failed' avec last_error).
