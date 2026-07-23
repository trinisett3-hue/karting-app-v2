// Point d'entrée de la page publique de résultats (results.html).
// Câble le module public-results.js sur le HTML : thème, navigation entre pages,
// bouton PDF complet, puis chargement des données au démarrage.
import * as results from './modules/public-results.js';

results.initTheme();
results.initNav();
results.initPdfFullButton();
results.load();
