-- Migration v33 — 02/09/2026
-- Hygiene technique, sans changement de comportement fonctionnel.
--
-- 1. Trois cles etrangeres `team_id` n'ont pas d'index couvrant : chaque
--    suppression d'une ecurie force un balayage complet des tables filles, et
--    les jointures du Mode Ecurie n'ont aucun index a se mettre sous la dent.
--    Invisible a 21 pilotes, mesurable des la premiere saison chargee.
--
-- 2. Les policies `tenant_teams_rw` et `session_teams_rw` appellent auth.uid()
--    sans l'envelopper dans un sous-select : Postgres la reevalue une fois PAR
--    LIGNE au lieu d'une fois par requete. `(select auth.uid())` est evalue une
--    seule fois puis reutilise. Le predicat est identique, seul le plan change.
--
-- 3. `register_new_pilot` existe en deux versions exposees a `anon` : celle a 7
--    arguments (utilisee par register.js et manual-add.js) et celle a 8
--    arguments avec `_parental_consent`, residu du chantier consentement mineur
--    implemente le 24/08 puis annule le meme jour (migration v31). Aucun code
--    ne l'appelle -- verifie par grep sur tout le depot, zero occurrence de
--    `_parental_consent` hors migrations. Une signature morte reste une
--    signature appelable : on la supprime.

create index if not exists idx_session_registrations_team on public.session_registrations(team_id);
create index if not exists idx_session_teams_team          on public.session_teams(team_id);
create index if not exists idx_tenant_teams_team           on public.tenant_teams(team_id);

drop policy if exists tenant_teams_rw on public.tenant_teams;
create policy tenant_teams_rw on public.tenant_teams
  as permissive for all to authenticated
  using      (tenant_id in (select tu.tenant_id from public.tenant_users tu where tu.user_id = (select auth.uid())))
  with check (tenant_id in (select tu.tenant_id from public.tenant_users tu where tu.user_id = (select auth.uid())));

drop policy if exists session_teams_rw on public.session_teams;
create policy session_teams_rw on public.session_teams
  as permissive for all to authenticated
  using      (tenant_id in (select tu.tenant_id from public.tenant_users tu where tu.user_id = (select auth.uid())))
  with check (tenant_id in (select tu.tenant_id from public.tenant_users tu where tu.user_id = (select auth.uid())));

drop function if exists public.register_new_pilot(text, text, text, text, date, text, text, boolean);
