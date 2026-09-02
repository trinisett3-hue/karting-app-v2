-- Migration v32 — 02/09/2026
-- Correctifs RGPD prepares le 25/08, appliques par la passe technique.
--
-- 1. anonymize_stale_pilots() n'anonymisait pas completement : elle effacait
--    first_name / last_name / email / birth_date mais laissait `pseudo` et
--    `nationality`. Or un pseudo de karting est tres souvent un prenom ou un
--    surnom reconnaissable. Une donnee qui permet encore d'identifier une
--    personne reste une donnee personnelle : ce que faisait la fonction etait
--    une pseudonymisation, pas une anonymisation, et l'obligation de duree de
--    conservation annoncee dans le DPA n'etait donc pas reellement satisfaite.
--
-- 2. La meme fonction, declaree SECURITY DEFINER, etait executable par `anon` :
--    appelable sans authentification via POST /rest/v1/rpc/anonymize_stale_pilots.
--    Inerte aujourd'hui (aucun pilote n'atteint 3 ans d'inactivite, la base date
--    de juillet 2026) mais en 2029 le meme appel deviendrait une anonymisation
--    de masse declenchable par un inconnu.
--
-- Contraintes prises en compte : pilots.pseudo est NOT NULL et soumis au check
-- pilots_pseudo_format (^[A-Za-z0-9_.-]+$) -- on ne peut donc ni le vider ni y
-- mettre n'importe quoi ; il est remplace par une valeur neutre derivee de
-- l'UUID. pilots.nationality est nullable.
--
-- Aucun code client n'appelle cette fonction (verifie par grep sur tout le
-- depot) : le REVOKE est sans effet de bord. Le job pg_cron
-- `purge-pilotes-inactifs-3ans` s'execute avec les droits du proprietaire de la
-- base et n'est pas affecte par un REVOKE sur anon / authenticated.

create or replace function public.anonymize_stale_pilots()
returns integer
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_count integer;
begin
  with last_activity as (
    select p.id as pilot_id,
           coalesce(max(s.session_date), p.created_at::date) as last_seen
      from public.pilots p
      left join public.session_registrations sr on sr.pilot_id = p.id
      left join public.sessions s on s.id = sr.session_id
     group by p.id, p.created_at
  ),
  stale as (
    select pilot_id from last_activity
     where last_seen < (current_date - interval '3 years')
  ),
  anonymized as (
    update public.pilots
       set first_name  = 'Pilote',
           last_name   = 'Anonymise',
           email       = 'anonymise-' || id || '@supprime.trinisette.fr',
           -- pseudo est NOT NULL et contraint par pilots_pseudo_format :
           -- valeur neutre et unique plutot qu'un vidage impossible.
           pseudo      = 'anon-' || left(id::text, 8),
           nationality = null,
           birth_date  = null,
           parental_consent_at = null
     where id in (select pilot_id from stale)
       and email not like 'anonymise-%@supprime.trinisette.fr'
     returning id
  )
  select count(*) into v_count from anonymized;

  return v_count;
end;
$function$;

-- L'ordre compte : `create or replace` reattribue les droits par defaut,
-- le REVOKE doit donc venir apres.
revoke execute on function public.anonymize_stale_pilots() from anon, authenticated, public;
