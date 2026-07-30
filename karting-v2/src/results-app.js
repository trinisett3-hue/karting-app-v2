// Point d'entrée de la page publique de résultats (results.html).
// Câble le module public-results.js sur le HTML : thème, navigation entre pages,
// bouton PDF complet, puis chargement des données au démarrage.
import * as results from './modules/public-results.js';

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
    listPilots: results.listExportPilots,
    setOrient: results.setPdfOrient,
    pilotPDFBytes: results.pilotPDFBytes,
    fullPDFBytes: results.fullPDFBytes,
  };
}
