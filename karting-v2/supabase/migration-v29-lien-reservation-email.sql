-- =====================================================================
-- Migration v29 — Lien de réservation dans l'e-mail de résultats
-- =====================================================================
-- Demande du 25/08 : le circuit doit pouvoir renseigner un lien de
-- réservation, repris comme bouton d'appel à l'action ("Réserver une
-- prochaine séance") dans l'e-mail de résultats envoyé à chaque pilote.
--
-- Aucune nouvelle colonne : le lien vit dans app_settings.value.booking_url
-- (même mécanisme que card_qr_url, colonne déjà jsonb — voir settings.js).
-- Cette migration ne fait que faire remonter cette valeur dans le payload
-- lu par l'Edge Function send-result-emails, en joignant app_settings dans
-- claim_card_deliveries().
--
-- 100 % ADDITIF : nouvelle clé 'booking_url' ajoutée au jsonb_build_object,
-- aucune clé existante retirée ni renommée, aucune ligne touchée.
-- =====================================================================

CREATE OR REPLACE FUNCTION public.claim_card_deliveries(_limit integer DEFAULT 100)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'private', 'pg_temp'
AS $function$
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
           'booking_url',      nullif(trim(coalesce(cfg.value->>'booking_url', '')), ''),
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
    left join public.tenants t on t.id = m.tenant_id
    left join public.app_settings cfg on cfg.tenant_id = m.tenant_id and cfg.key = 'global';

  return v_rows;
end;
$function$;

-- État au 25/08/2026, soir : déjà appliquée en base directement par le dev IT
-- (session hors jeudi, à la demande explicite de Stéphane) et vérifiée sur
-- pièces. Ce fichier documente le changement dans le dépôt, comme convenu.
