// =====================================================================
// PONT D'EXPORT PDF — IFRAME CACHEE VERS LA PAGE PUBLIQUE DE RESULTATS
//
// Extrait de publish-pdfs.js (30/07) pour etre partage avec l'apercu de
// Parametres > PDF & export (settings.js), qui a besoin exactement du meme
// mecanisme : charger results.html?export=1 dans une iframe cachee de meme
// origine et attendre que window.__kartingExport apparaisse (voir
// results-app.js). Cf. le commentaire d'origine dans publish-pdfs.js pour le
// POURQUOI (moteur de rendu soigne, non duplique, parite octet pour octet
// avec ce que le pilote recoit).
//
// L'iframe est positionnee hors ecran mais avec de VRAIES dimensions :
// display:none donnerait une mise en page de taille zero et html2canvas
// produirait des pages vides.

export const IFRAME_LOAD_TIMEOUT = 45000; // chargement de la page + donnees
export const BRIDGE_TIMEOUT = 60000;      // fin de load() cote public (RPC + avatars)
export const PDF_TIMEOUT = 120000;        // rendu d'un document (grille tres fournie)

export function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('Delai depasse : ' + label)), ms); }),
  ]).finally(() => clearTimeout(timer));
}

// URL RELATIVE volontairement : APP_CONFIG.baseUrl peut pointer sur le domaine
// de production alors qu'on travaille en local, et l'iframe serait alors d'une
// autre origine — window.__kartingExport deviendrait inaccessible. Repartir de
// window.location garantit la meme origine, donc l'acces direct au pont.
export function exportUrl(token) {
  // Racine de l'origine courante, et non un chemin relatif : selon la facon
  // dont Cloudflare Pages sert admin.html (avec ou sans extension, avec ou
  // sans slash final), un « results.html » relatif pourrait resoudre vers un
  // sous-dossier inexistant. Les pages du projet sont toutes a la racine.
  const u = new URL('/results.html', window.location.origin);
  u.searchParams.set('result', token);
  u.searchParams.set('export', '1');
  return u.toString();
}

export function openHiddenFrame(url) {
  const iframe = document.createElement('iframe');
  iframe.setAttribute('aria-hidden', 'true');
  iframe.setAttribute('tabindex', '-1');
  iframe.setAttribute('title', 'Generation des PDF');
  iframe.style.cssText =
    'position:fixed;left:-20000px;top:0;width:1280px;height:1000px;border:0;opacity:0;pointer-events:none';
  const loaded = new Promise((resolve, reject) => {
    iframe.addEventListener('load', () => resolve(), { once: true });
    iframe.addEventListener('error', () => reject(new Error('Page de resultats illisible')), { once: true });
  });
  iframe.src = url;
  document.body.appendChild(iframe);
  return { iframe, loaded };
}

// Les scripts de type module sont differes : ils s'executent avant l'evenement
// load. Le pont devrait donc etre la des `loaded`. On sonde quand meme, une
// seconde au plus : c'est le genre de garantie qui coute peu et evite un echec
// non reproductible.
export async function waitForBridge(iframe) {
  for (let i = 0; i < 40; i++) {
    const api = iframe.contentWindow && iframe.contentWindow.__kartingExport;
    if (api) return api;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('Pont d\'export absent (page publique non chargee ?)');
}
