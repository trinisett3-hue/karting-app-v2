-- =====================================================================
-- Migration v22 — Cartes de resultat partageables : records + file e-mail
-- =====================================================================
-- Applique sur le projet Supabase le 2026-07-29 en trois etapes :
--   20260729163340  cards_records_and_email_outbox
--   20260729163402  cards_record_detection_trigger
--   20260729163935  lock_down_record_trigger_function
-- Ce fichier les regroupe pour que le schema reste reconstructible depuis Git.
--
-- 100 % ADDITIF : aucune table, colonne ou policy existante n'est modifiee
-- ni supprimee. Rejouable sans perte de donnee (if not exists / or replace).
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1. Tables : suivi des records + file d'envoi e-mail
-- ---------------------------------------------------------------------

create table if not exists public.track_records (
  tenant_id        uuid not null,
  scope            text not null check (scope in ('perso','piste','semaine','mois')),
  period_key       text not null,
  lap_time_seconds numeric not null,
  registration_id  uuid references public.session_registrations(id) on delete set null,
  session_id       uuid references public.sessions(id) on delete set null,
  achieved_at      timestamptz not null default now(),
  primary key (tenant_id, scope, period_key)
);

create table if not exists public.card_deliveries (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null,
  session_id      uuid references public.sessions(id) on delete cascade,
  registration_id uuid references public.session_registrations(id) on delete cascade,
  channel         text not null default 'email',
  email           text,
  kind            text not null check (kind in ('position','record')),
  scope           text check (scope in ('perso','piste','semaine','mois')),
  card_concept    text,
  status          text not null default 'pending' check (status in ('pending','sent','failed','skipped')),
  attempts        int  not null default 0,
  payload         jsonb not null default '{}'::jsonb,
  last_error      text,
  created_at      timestamptz not null default now(),
  sent_at         timestamptz
);

create index if not exists card_deliveries_pending_idx
  on public.card_deliveries (tenant_id, status, created_at)
  where status = 'pending';
create index if not exists card_deliveries_session_idx
  on public.card_deliveries (session_id);

-- Une seule carte de chaque nature par pilote et par session.
create unique index if not exists card_deliveries_unique_idx
  on public.card_deliveries (registration_id, kind, coalesce(scope, ''));

alter table public.track_records   enable row level security;
alter table public.card_deliveries enable row level security;

drop policy if exists track_records_auth   on public.track_records;
drop policy if exists card_deliveries_auth on public.card_deliveries;

create policy track_records_auth on public.track_records
  for all using  (tenant_id is not null and tenant_id = private.current_tenant_id())
           with check (tenant_id is not null and tenant_id = private.current_tenant_id());

create policy card_deliveries_auth on public.card_deliveries
  for all using  (tenant_id is not null and tenant_id = private.current_tenant_id())
           with check (tenant_id is not null and tenant_id = private.current_tenant_id());


-- ---------------------------------------------------------------------
-- 2. Detection automatique des records a chaque tour enregistre
-- ---------------------------------------------------------------------
-- L'envoi n'est JAMAIS manuel : ce declencheur alimente card_deliveries.

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
  v_hit    boolean := false;
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
      -- precedent existait et vient d'etre battu.
      if v_best is not null then
        v_hit := true;
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

  -- Tout record entraine aussi l'envoi de la carte position.
  if v_hit then
    insert into public.card_deliveries
      (tenant_id, session_id, registration_id, email, kind, scope, payload)
    values
      (new.tenant_id, new.session_id, new.registration_id, v_email, 'position', null,
       jsonb_build_object('date', v_date))
    on conflict do nothing;
  end if;

  return new;
end;
$$;

drop trigger if exists laps_detect_records on public.laps;
create trigger laps_detect_records
  after insert on public.laps
  for each row execute function public.detect_records_and_enqueue_cards();


-- ---------------------------------------------------------------------
-- 3. Durcissement : la fonction de trigger ne doit jamais etre appelable
--    en RPC (/rest/v1/rpc/) par un client anon ou authenticated.
-- ---------------------------------------------------------------------

revoke execute on function public.detect_records_and_enqueue_cards() from public, anon, authenticated;


-- ---------------------------------------------------------------------
-- Reste a faire (hors SQL)
-- ---------------------------------------------------------------------
-- Une Edge Function doit consommer card_deliveries (status = 'pending')
-- et envoyer l'e-mail au pilote avec : la carte PNG, le PDF pilote et le
-- PDF complet de la session, puis passer la ligne a 'sent'.
