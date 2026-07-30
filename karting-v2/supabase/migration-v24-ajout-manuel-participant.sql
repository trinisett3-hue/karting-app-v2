-- =====================================================================
-- Migration v24 — Recherche pilote pour l'ajout manuel d'un participant
-- =====================================================================
-- Contexte : un pilote se presente sans telephone (ou refuse le QR). Le
-- personnel du circuit doit pouvoir l'inscrire depuis l'admin, en trois
-- chemins :
--   1. il est deja venu     -> on retrouve son profil (cette fonction)
--   2. c'est sa premiere fois -> register_new_pilot() existant, avec le
--      jeton d'inscription de la session en cours (aucune nouvelle RPC)
--   3. il reste anonyme     -> is_unknown = true, aucun e-mail, aucun envoi
--
-- find_pilot_by_query() ne convient pas au cas 1 : elle exige une
-- correspondance EXACTE sur l'e-mail ou le pseudo. A l'accueil, on tape un
-- debut de nom. D'ou cette recherche partielle, reservee aux admins.
--
-- 100 % ADDITIF : aucune table, colonne ou policy touchee.
-- =====================================================================


-- ---------------------------------------------------------------------
-- Recherche partielle de pilotes, reservee aux admins du circuit
-- ---------------------------------------------------------------------
-- Confidentialite : on ne cherche PAS dans toute la table pilots (qui est
-- commune a tous les circuits). Un admin ne voit que les pilotes ayant
-- deja couru chez LUI — exactement le meme perimetre que l'onglet
-- Registre (tenant_pilot_registry).

create or replace function public.admin_search_pilots(_query text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, private, pg_temp
as $$
declare
  v_q text := lower(trim(coalesce(_query, '')));
begin
  -- Deux caracteres minimum : evite qu'un "a" ne renvoie tout le fichier.
  if length(v_q) < 2 then
    return '[]'::jsonb;
  end if;

  if auth.uid() is null then
    return '[]'::jsonb;
  end if;

  return coalesce((
    select jsonb_agg(x order by x->>'last_seen' desc nulls last)
      from (
        select jsonb_build_object(
                 'id',             p.id,
                 'pseudo',         p.pseudo,
                 'first_name',     p.first_name,
                 'last_name',      p.last_name,
                 'email',          p.email,
                 'nationality',    p.nationality,
                 'sessions_count', count(distinct sr.session_id),
                 'last_seen',      max(coalesce(s.session_date, sr.created_at::date))
               ) as x
          from public.session_registrations sr
          join unnest(public.tenant_admin_ids(auth.uid())) as mt(tenant_id)
            on mt.tenant_id = sr.tenant_id
          join public.pilots p on p.id = sr.pilot_id
          left join public.sessions s on s.id = sr.session_id
         where sr.pilot_id is not null
           and (
                lower(p.pseudo)     like '%' || v_q || '%'
             or lower(p.first_name) like '%' || v_q || '%'
             or lower(p.last_name)  like '%' || v_q || '%'
             or lower(p.email)      like '%' || v_q || '%'
           )
         group by p.id, p.pseudo, p.first_name, p.last_name, p.email, p.nationality
         limit 20
      ) q
  ), '[]'::jsonb);
end;
$$;

-- Jamais accessible a un visiteur anonyme : cette fonction renvoie des
-- e-mails et des noms civils.
revoke execute on function public.admin_search_pilots(text) from public, anon;
grant  execute on function public.admin_search_pilots(text) to authenticated;
