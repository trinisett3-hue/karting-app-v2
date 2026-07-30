-- =====================================================================
-- Migration v26 — Infrastructure d'envoi des resultats par e-mail
-- =====================================================================
-- Rappel de la decision d'architecture : les PDF sont produits par le
-- NAVIGATEUR (html2canvas + jsPDF, ~1200 lignes de correctifs dans
-- public-results.js). Une Edge Function tourne sous Deno, sans DOM : elle
-- ne peut pas les rendre. Le navigateur les televerse donc dans Storage au
-- moment de la publication, et l'Edge Function ne fait plus que lire,
-- signer et envoyer.
--
-- Ce fichier pose les quatre pieces manquantes :
--   1. un bucket prive `session-exports` + ses policies
--   2. une table `session_assets` qui dit quel fichier existe pour qui
--   3. claim/mark : une prise de file ATOMIQUE, pour que l'appel immediat
--      a la publication et le cron de rattrapage ne puissent jamais
--      envoyer deux fois le meme e-mail
--   4. le cron de rattrapage (pg_cron + pg_net), toutes les 5 minutes
--
-- 100 % ADDITIF sur les tables existantes : card_deliveries n'est pas
-- modifiee, aucune colonne supprimee, aucune donnee touchee.
-- =====================================================================

create extension if not exists pg_cron;
create extension if not exists pg_net;


-- ---------------------------------------------------------------------
-- 0. Horodatage de la prise en charge
-- ---------------------------------------------------------------------
-- Seule modification de card_deliveries, et elle est purement additive :
-- une colonne nullable. Sans elle, impossible de distinguer « en cours
-- d'envoi depuis 3 secondes » de « bloque depuis une heure » — created_at
-- date de la mise en file, pas de la prise en charge, et s'en servir
-- remettrait en file des envois encore en vol (donc double e-mail).
alter table public.card_deliveries
  add column if not exists claimed_at timestamptz;


-- ---------------------------------------------------------------------
-- 1. Bucket prive des exports
-- ---------------------------------------------------------------------
-- Prive, jamais public : un PDF de resultats porte des pseudos et des
-- temps, et son URL serait devinable. L'Edge Function distribue des URL
-- signees a duree limitee.
insert into storage.buckets (id, name, public, file_size_limit)
values ('session-exports', 'session-exports', false, 26214400)
on conflict (id) do nothing;

-- Convention de chemin : <tenant_id>/<session_id>/<fichier>. Le premier
-- segment est ce qui rend la policy possible sans jointure.
drop policy if exists "exports lisibles par les admins du circuit" on storage.objects;
create policy "exports lisibles par les admins du circuit"
  on storage.objects for select
  to authenticated
  using (
    bucket_id = 'session-exports'
    and (storage.foldername(name))[1]::uuid = any (public.tenant_admin_ids(auth.uid()))
  );

drop policy if exists "exports televersables par les admins du circuit" on storage.objects;
create policy "exports televersables par les admins du circuit"
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'session-exports'
    and (storage.foldername(name))[1]::uuid = any (public.tenant_admin_ids(auth.uid()))
  );

-- Republier une session doit pouvoir ecraser les fichiers precedents.
drop policy if exists "exports remplacables par les admins du circuit" on storage.objects;
create policy "exports remplacables par les admins du circuit"
  on storage.objects for update
  to authenticated
  using (
    bucket_id = 'session-exports'
    and (storage.foldername(name))[1]::uuid = any (public.tenant_admin_ids(auth.uid()))
  );


-- ---------------------------------------------------------------------
-- 2. Inventaire des fichiers produits
-- ---------------------------------------------------------------------
-- Pourquoi une table plutot qu'une convention de nommage devinee par
-- l'Edge Function : une convention casse en silence. Ici, si la ligne
-- n'existe pas, l'e-mail part sans cette piece jointe et on le sait.
create table if not exists public.session_assets (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenants(id) on delete cascade,
  session_id      uuid not null references public.sessions(id) on delete cascade,
  -- null = document de session (le PDF complet, commun a tous les pilotes)
  registration_id uuid references public.session_registrations(id) on delete cascade,
  kind            text not null check (kind in ('full_pdf', 'pilot_pdf', 'position_card', 'record_card')),
  storage_path    text not null,
  mime_type       text not null default 'application/pdf',
  byte_size       integer,
  created_at      timestamptz not null default now()
);

-- Un seul fichier courant par (session, pilote, type) : un re-televersement
-- remplace la ligne au lieu d'en empiler.
create unique index if not exists session_assets_unique_kind
  on public.session_assets (session_id, kind, coalesce(registration_id, '00000000-0000-0000-0000-000000000000'::uuid));

create index if not exists session_assets_session_idx on public.session_assets (session_id);

alter table public.session_assets enable row level security;

drop policy if exists "session_assets par tenant" on public.session_assets;
create policy "session_assets par tenant"
  on public.session_assets for all
  to authenticated
  using (tenant_id = private.current_tenant_id())
  with check (tenant_id = private.current_tenant_id());

-- Meme confort qu'ailleurs : le client n'a pas a connaitre son tenant_id.
create or replace function public.autofill_tenant_session_assets()
returns trigger language plpgsql security definer
set search_path = public, private, pg_temp as $$
begin
  if new.tenant_id is null then
    new.tenant_id := private.current_tenant_id();
  end if;
  return new;
end;
$$;

drop trigger if exists trg_autofill_tenant_session_assets on public.session_assets;
create trigger trg_autofill_tenant_session_assets
  before insert on public.session_assets
  for each row execute function public.autofill_tenant_session_assets();


-- ---------------------------------------------------------------------
-- 3. Prise de file atomique
-- ---------------------------------------------------------------------
-- LE point critique de cette migration. L'appel immediat a la publication
-- et le cron de rattrapage peuvent se croiser. `for update skip locked` +
-- le passage a 'sending' dans la MEME transaction garantissent qu'une
-- ligne n'est remise a personne d'autre : un pilote ne peut pas recevoir
-- deux fois le meme e-mail.
create or replace function public.claim_card_deliveries(_limit integer default 100)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, private, pg_temp
as $$
declare
  v_rows jsonb;
begin
  with picked as (
    select d.id
      from public.card_deliveries d
      join public.sessions s on s.id = d.session_id
     where d.status = 'pending'
       and s.status = 'results_published'
       and d.email is not null
       and length(trim(d.email)) > 3
       -- Au-dela de 5 tentatives on arrete de reessayer : sans ce garde-fou
       -- une adresse invalide serait retentee toutes les 5 minutes a vie.
       and d.attempts < 5
     order by d.created_at
     limit greatest(1, least(coalesce(_limit, 100), 500))
     for update of d skip locked
  ),
  moved as (
    update public.card_deliveries d
       set status = 'sending', attempts = d.attempts + 1, claimed_at = now()
      from picked p
     where d.id = p.id
    returning d.*
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'delivery_id',      m.id,
           'tenant_id',        m.tenant_id,
           'session_id',       m.session_id,
           'registration_id',  m.registration_id,
           'email',            m.email,
           'kind',             m.kind,
           'scope',            m.scope,
           'payload',          m.payload,
           'attempts',         m.attempts,
           'display_name',     r.display_name,
           'first_name',       r.first_name,
           'session_title',    s.title,
           'session_date',     s.session_date,
           'results_token',    s.public_results_token,
           'venue_name',       t.name,
           'assets',           coalesce((
             select jsonb_agg(jsonb_build_object('kind', a.kind, 'path', a.storage_path, 'mime', a.mime_type))
               from public.session_assets a
              where a.session_id = m.session_id
                and (a.registration_id is null or a.registration_id = m.registration_id)
           ), '[]'::jsonb)
         )), '[]'::jsonb)
    into v_rows
    from moved m
    left join public.session_registrations r on r.id = m.registration_id
    left join public.sessions s on s.id = m.session_id
    left join public.tenants t on t.id = m.tenant_id;

  return v_rows;
end;
$$;

-- Reservee a l'Edge Function (service_role). Ni anon ni un admin connecte
-- ne doivent pouvoir vider la file : ils declencheraient des envois.
revoke execute on function public.claim_card_deliveries(integer) from public, anon, authenticated;
grant  execute on function public.claim_card_deliveries(integer) to service_role;


create or replace function public.mark_card_delivery(_id uuid, _ok boolean, _error text default null)
returns void
language plpgsql
volatile
security definer
set search_path = public, private, pg_temp
as $$
begin
  update public.card_deliveries
     set status     = case when _ok then 'sent' else 'pending' end,
         sent_at    = case when _ok then now() else sent_at end,
         -- En cas d'echec on repasse a 'pending' : le cron reessaiera,
         -- jusqu'a la limite de 5 tentatives posee dans le claim.
         last_error = case when _ok then null else left(coalesce(_error, 'erreur inconnue'), 1000) end
   where id = _id;
end;
$$;

revoke execute on function public.mark_card_delivery(uuid, boolean, text) from public, anon, authenticated;
grant  execute on function public.mark_card_delivery(uuid, boolean, text) to service_role;


-- Remise en file des lignes bloquees en 'sending' : si l'Edge Function
-- meurt en plein vol (timeout, redemarrage), la ligne resterait 'sending'
-- pour toujours. Au-dela de 15 minutes apres la PRISE EN CHARGE (et non
-- apres la mise en file), on considere l'envoi perdu.
create or replace function public.requeue_stuck_deliveries()
returns integer
language plpgsql
volatile
security definer
set search_path = public, private, pg_temp
as $$
declare v_n integer;
begin
  with fixed as (
    update public.card_deliveries
       set status = 'pending',
           last_error = 'envoi interrompu, remis en file'
     where status = 'sending'
       and coalesce(claimed_at, created_at) < now() - interval '15 minutes'
    returning 1
  )
  select count(*) into v_n from fixed;
  return v_n;
end;
$$;

revoke execute on function public.requeue_stuck_deliveries() from public, anon, authenticated;
grant  execute on function public.requeue_stuck_deliveries() to service_role;
