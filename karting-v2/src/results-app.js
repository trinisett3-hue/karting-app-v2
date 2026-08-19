// Point d'entrée de la page publique de résultats (results.html).
// Câble le module public-results.js sur le HTML : thème, navigation entre pages,
// bouton PDF complet, puis chargement des données au démarrage.
// ?v= : cache-buster. public-results.js est servi avec un long cache HTTP
// (Cloudflare Pages, 4h) — sans ce paramètre, un admin ayant déjà ouvert la
// page de résultats dans la même fenêtre de 4h continue de générer les PDF et
// cartes avec l'ANCIEN code après un déploiement, en silence (aucune erreur :
// juste des fonctionnalités absentes). Vécu en direct le 19/08 avec les
// cartes d'écurie. A incrémenter à chaque changement de ce fichier.
import * as results from './modules/public-results.js?v=20260819b';

results.initTheme();
results.initNav();
results.initPdfFullButton();
const ready = results.load();

/* 🆕 v28 — passerelle d'export pour les pièces jointes.
   Activée UNIQUEMENT par ?export=1, donc jamais présente sur la page que
   consultent les pilotes : rien de nouveau n'est exposé au public. L'admin
   charge cette même page dans une iframe cachée de même origine au moment de
   la publication, attend `ready`, puis demande un PDF à la fois.
   `ready` est la promesse de load() : la résoudre garantit que le classement,
   le thème, le logo et les avatars sont en place avant tout rendu. */
if (new URLSearchParams(window.location.search).get('export') === '1') {
  window.__kartingExport = {
    version: 1,
    ready: ready.then(() => true),
         // 🆕 30/07 : ready se resolvait toujours a true, meme quand load() echoue
         // (session archivee ou lien invalide) — generateSessionPDFs() n'avait
         // alors aucun moyen de detecter l'echec et continuait silencieusement
         // avec un classement vide. `ok` porte le vrai resultat de load().
         ok: ready,
    listPilots: results.listExportPilots,
    setOrient: results.setPdfOrient,
    pilotPDFBytes: results.pilotPDFBytes,
    fullPDFBytes: results.fullPDFBytes,
    positionCardPNGBytes: results.positionCardPNGBytes,
    recordCardPNGBytes: results.recordCardPNGBytes,
    teamCardPNGBytes: results.teamCardPNGBytes,
    teamStandingsCardPNGBytes: results.teamStandingsCardPNGBytes,
    listExportTeams: results.listExportTeams,
  };
}
