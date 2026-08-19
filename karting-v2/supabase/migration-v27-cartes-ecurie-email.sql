-- =====================================================================
-- Migration v27 — Cartes d'écurie dans les e-mails de résultats
-- =====================================================================
-- Constat du 19/08 : le mode Écurie génère bien deux visuels supplémentaires
-- (teamCardPNGBytes, teamStandingsCardPNGBytes dans public-results.js,
-- exposés via le pont d'export __kartingExport), mais generateSessionPDFs()
-- (publish-pdfs.js) ne les a jamais appelés. Résultat vécu en direct : un
-- pilote en session Écurie reçoit son e-mail de résultats sans une seule
-- ligne sur le championnat constructeur.
--
-- Cette migration ne fait qu'ouvrir la porte côté base : elle étend la liste
-- des `kind` autorisés dans session_assets pour que le prochain televersement
-- (fait par publish-pdfs.js) ne soit pas rejeté par la contrainte CHECK.
--
-- 100 % ADDITIF : aucune ligne existante touchée, aucune colonne supprimée,
-- seule la liste de valeurs autorisées s'agrandit.
-- =====================================================================

alter table public.session_assets
  drop constraint if exists session_assets_kind_check;

alter table public.session_assets
  add constraint session_assets_kind_check
  check (kind in (
    'full_pdf', 'pilot_pdf', 'position_card', 'record_card',
    -- team_standings_card : le tableau complet du championnat constructeur,
    -- un seul par session (registration_id null) — comme full_pdf, il se
    -- joint automatiquement à TOUS les e-mails de la session (voir la
    -- jointure de claim_card_deliveries : "registration_id is null OR ...").
    'team_standings_card',
    -- team_card : la carte de l'écurie du pilote destinataire (position au
    -- championnat, roster) — un asset par pilote, comme position_card.
    'team_card'
  ));
