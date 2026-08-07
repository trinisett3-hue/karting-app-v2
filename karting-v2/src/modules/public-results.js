// Module de la page publique de résultats (results.html) — accès par QR code / lien,
// sans auth. Reprend à l'identique la logique de l'ancien results.html monofichier :
// résolution de session par public_results_token, classement (temps total), podium,
// top 10, classement complet, détail tour par tour (avec secteurs), export PDF.
import { db } from '../lib/supabase.js';
// Chargement paresseux (30/07, audit du 28/07 section 1.2) : kart-avatar.js
// (486 Ko) et pilot-avatar.js (161 Ko) ne sont plus importes statiquement ici --
// un tenant donne n'utilise jamais qu'un seul des deux (avatar_mode), l'autre
// etait du poids mort telecharge par CHAQUE visiteur qui scanne un QR, avant
// meme qu'une seule donnee de course n'apparaisse. ensureAvatarModuleLoaded()
// importe dynamiquement le seul module necessaire une fois PDF_AVATAR_MODE
// connu (voir load(), juste apres await loadSiteConfig() -- meme ordre garanti
// que pour le theme/logo, cf. commentaire "AVANT tout rendu" plus bas).
let kartAvatarSVG, kartAvatarDataURL, pilotAvatarSVG, pilotAvatarDataURL;
let _avatarModuleLoaded = false;
async function ensureAvatarModuleLoaded() {
  if (_avatarModuleLoaded) return;
  if (PDF_AVATAR_MODE === 'pilot_kart' || PDF_AVATAR_MODE === 'pilot') {
    const m = await import('./pilot-avatar.js');
    pilotAvatarSVG = m.pilotAvatarSVG;
    pilotAvatarDataURL = m.pilotAvatarDataURL;
  } else {
    const m = await import('./kart-avatar.js');
    kartAvatarSVG = m.kartAvatarSVG;
    kartAvatarDataURL = m.kartAvatarDataURL;
  }
  _avatarModuleLoaded = true;
}
import { loadSiteConfig } from './site-config.js';
import { qrSVG } from './qr.js';
import {
  signatureAvatarsActive,
  signatureAvatarHTML,
  prewarmSignatureAvatarDataURLs,
  signatureAvatarDataURLSync
} from './signature-avatar.js';

const FLAGS = { FR: '🇫🇷', BE: '🇧🇪', LU: '🇱🇺', DE: '🇩🇪', CH: '🇨🇭', NL: '🇳🇱', IT: '🇮🇹', ES: '🇪🇸', GB: '🇬🇧', US: '🇺🇸', OTHER: '🏁' };
const PAGE1MAX = 10;
const NO_TIME = 999999; // valeur sentinelle : toujours trié en dernier

let allResults = [];
let sessionInfo = null;
let resultsToken = null; // jeton public de la session : requis par les RPC token-gated
// 🆕 v28 : caches du palmares. Cles par session / par pseudo, vides a chaque
// load(). Indispensables des qu'on genere les fiches de toute la grille d'un
// coup (voir buildPilotPDF) : sans eux, 20 pilotes x N sessions d'historique
// declenchent des centaines d'appels RPC identiques.
const rankingCache = new Map();
const palmaresCache = new Map();
let currentPage = 1;

// Réglage « secteurs » (Paramètres › Apparence), lu depuis app_settings.global.
// Affiché uniquement si value.sectors_enabled === true (Paramètres › Apparence).
let PDF_SHOW_SECTORS = false;
function sectorsEnabled() { return PDF_SHOW_SECTORS !== false; }

// Réglage « Apparence des avatars » (Paramètres › Apparence), lu depuis app_settings.global.
//   'kart'       (défaut) : avatar kart existant, un dessin par numéro de kart.
//   'pilot_kart' : nouveau jeu de bustes pilote illustrés, numéro de kart affiché dessus.
//   'pilot'      : même jeu de bustes pilote, sans numéro affiché (combinaison neutre).
let PDF_AVATAR_MODE = 'kart';

// 🆕 v19 : logo du circuit (Paramètres › Apparence), lu depuis app_settings.global
// via public_site_config — déjà affiché sur cette page web (voir plus bas), mais pas
// encore repris dans les 2 exports PDF (Fiche pilote / Classement complet). Mémorisé
// ici pour que downloadPilotPDF()/downloadFullPDF() puissent y accéder sans refaire
// l'appel réseau.
let PDF_LOGO_URL = null;

// Nom du circuit (Parametres > Sessions, developpement reel 30/07) — lu depuis
// app_settings.global.circuit_name via public_site_config, exactement comme
// PDF_LOGO_URL ci-dessus (meme mecanisme, meme RPC). Devient la SOURCE DE VERITE
// affichee sur cette page et dans les exports quand renseigne ; sessions.circuit_name
// (par session) reste le repli pour les sessions plus anciennes ou tant que ce
// reglage global n'a pas ete rempli — voir l'ecrasement juste apres la lecture de
// `session` dans load() ci-dessous.
// Noms de circuit dedies au rendu PDF (Parametres > Identite du circuit).
// circuit_name reste la source de verite AFFICHEE PARTOUT AILLEURS (page web
// publique, cartes partageables, apercus). Les deux champs ci-dessous ne
// concernent QUE les exports PDF : l'en-tete (zone etroite de la fiche pilote,
// d'ou une limite de caracteres plus courte cote admin) et le pied de page.
// Vides => on retombe sur circuit_name : aucun reglage obligatoire.
let PDF_CIRCUIT_HEAD = ''; let PDF_CIRCUIT_FOOT = '';
let SITE_CIRCUIT_NAME = null; let CARD_POSITION_PICKS = []; let CARD_RECORD_PICKS = {}; let CARD_TAGLINE = ''; let CARD_ADDRESS = ''; let CARD_QR_URL = '';

// Génère la source d'un avatar (kart ou pilote selon le réglage courant), pour un
// <img src> — utilisé aussi bien dans les exports PDF que sur la page web publique.
function genAvatarDataURL(kart, opts) {
  // Pack Signature (plan Premium) : le PDF doit utiliser le même avatar que l'écran.
  // signatureAvatarDataURLSync() lit un cache préchauffé par prewarm… en tête des
  // deux exports ; s'il est vide (pack cassé, kart non préchauffé) on retombe
  // silencieusement sur l'avatar classique.
  if (signatureAvatarsActive()) {
    const sig = signatureAvatarDataURLSync(kart, opts);
    if (sig) return sig;
  }
  if (PDF_AVATAR_MODE === 'pilot_kart') return pilotAvatarDataURL ? pilotAvatarDataURL(kart, kart) : null;
  if (PDF_AVATAR_MODE === 'pilot') return pilotAvatarDataURL ? pilotAvatarDataURL(kart, null, { hidePlate: true }) : null;
  // avatar_scheme (session_registrations) prioritaire : opts.scheme, déjà
  // supporté par kartAvatarSVG/kartAvatarDataURL, doit être transmis ici —
  // avant ce correctif il était silencieusement perdu (opts non transmis).
  return kartAvatarDataURL ? kartAvatarDataURL(kart, opts) : null;
}
// Même chose en SVG inline (utilisé pour les placeholders sans photo sur la page web).
function genAvatarSVG(kart, opts) {
  if (PDF_AVATAR_MODE === 'pilot_kart') return pilotAvatarSVG ? pilotAvatarSVG(kart, kart, opts) : '';
  if (PDF_AVATAR_MODE === 'pilot') return pilotAvatarSVG ? pilotAvatarSVG(kart, null, { ...opts, hidePlate: true }) : '';
  return kartAvatarSVG ? kartAvatarSVG(kart, opts) : '';
}

/* Nom du circuit : UNE seule fonction, plus aucun litteral en dur.
   Ordre de priorite : reglage global (Parametres > Identite du circuit),
   puis sessions.circuit_name herite, puis un repli neutre. */
function circuitName() {
  const g = String(SITE_CIRCUIT_NAME || '').trim();
  if (g) return g;
  const s = String((sessionInfo && sessionInfo.circuit_name) || '').trim();
  return s || 'Circuit';
}
// En-tete des PDF : champ dedie s'il est rempli, sinon le nom du circuit.
function circuitNamePdfHead() { return String(PDF_CIRCUIT_HEAD || '').trim() || circuitName(); }
// Pied de page des PDF : idem.
function circuitNamePdfFoot() { return String(PDF_CIRCUIT_FOOT || '').trim() || circuitName(); }

/* ------------------------------------------------------------------
THEME — Lu depuis app_settings (key='global'), défini dans
admin.html > Paramètres > Apparence.
------------------------------------------------------------------ */
export function initTheme() {
const MAP = {
classic: 'classic', dark: 'classic', neon: 'neon', carbon: 'carbon',
// v15 : thèmes premium (plan Premium/Business) — manquaient de cette table,
// donc my_theme_entitlement() avait beau autoriser le thème choisi dans
// Paramètres, initTheme() le retombait silencieusement sur 'classic' ici
// (MAP[theme] || 'classic') faute d'entrée correspondante. Même impact sur
// l'export PDF, qui lit exactement le même data-theme sur <html>.
checkered: 'checkered', endurance: 'endurance', pitlane: 'pitlane',
champagne: 'champagne', arctic: 'arctic',
};
// Passe par le RPC public_site_config (SECURITY DEFINER) au lieu d'une lecture
// directe d'app_settings : c'est Postgres, pas le navigateur, qui decide si ce
// tenant a droit au pack Signature (private.avatar_config() force pack='classic'
// si l'entitlement manque ou si l'abonnement a expire). Meme forme de JSON dans
// cfg.settings que l'ancien data.value -- seule la source change.
loadSiteConfig().then((cfg) => {
const data = { value: cfg.settings };
const theme = data.value && data.value.results_theme;
PDF_SHOW_SECTORS = !!(data.value && data.value.sectors_enabled);
PDF_AVATAR_MODE = (data.value && data.value.avatar_mode) || 'kart';
const wmBadge = document.getElementById('wm-badge');
if (wmBadge) wmBadge.style.display = (cfg.avatars && cfg.avatars.plan === 'starter') ? 'inline-flex' : 'none';
if (theme) document.documentElement.setAttribute('data-theme', MAP[theme] || 'classic');
// 02/08 (client) : theme memorise pour etre applique avant le premier rendu
// (voir le script en tete de results.html) et supprimer le flash rouge.
try { localStorage.setItem('kt_theme', String(theme).trim()); } catch (e) {}
  try { if (window.__ktReveal) window.__ktReveal(); } catch (e) {}

const logoUrl = data.value && data.value.logo_url;
PDF_LOGO_URL = logoUrl || null;
SITE_CIRCUIT_NAME = (data.value && data.value.circuit_name) || null; CARD_POSITION_PICKS = Array.isArray(data.value && data.value.card_position_picks) ? data.value.card_position_picks : []; CARD_RECORD_PICKS = (data.value && data.value.card_record_picks) || {}; CARD_TAGLINE = (data.value && data.value.card_tagline) || ''; CARD_ADDRESS = (data.value && data.value.card_address) || ''; CARD_QR_URL = String((data.value && data.value.card_qr_url) || '').trim(); PDF_CIRCUIT_HEAD = String((data.value && data.value.circuit_name_pdf_header) || '').trim(); PDF_CIRCUIT_FOOT = String((data.value && data.value.circuit_name_pdf_footer) || '').trim();
// 31/07 : le nom du circuit est pose des le retour de la config, sans attendre
// load() — la page ne doit jamais afficher de nom en dur, meme brievement, ni
// sur le chemin d'erreur (session archivee, jeton invalide).
const nameEl = document.getElementById('circuit-name');
if (nameEl) nameEl.textContent = circuitName();
document.title = 'Resultats — ' + circuitName();

if (logoUrl) {
const header = document.querySelector('.circuit-header');
if (header && !document.getElementById('circuit-logo')) {
// Le logo doit apparaître à DROITE du nom du circuit, sans pousser le nom en
// dessous sur mobile : on le positionne en absolu dans le coin supérieur droit du
// header (qui est déjà `position:relative`), plutôt qu'en flex-row qui wrappait
// sous le nom dès que celui-ci était large (cas des écrans de téléphone).
const img = document.createElement('img');
img.id = 'circuit-logo';
img.src = logoUrl;
img.alt = 'Logo du circuit';
img.style.cssText = 'position:absolute;top:14px;right:14px;max-height:40px;max-width:110px;object-fit:contain;display:block;z-index:2';
header.appendChild(img);
}
}

// 02/08 (client) : "enleve l'option plan du circuit pour le moment partout".
// L'option est retiree de l'UI, des preferences et de la page publique. La colonne
// app_settings.value.track_map_url est nettoyee cote base ; rien d'autre n'en depend.
}).catch(() => {});
}

/* ------------------------------------------------------------------
HELPERS
------------------------------------------------------------------ */
function flagOf(nat) { return FLAGS[nat] || FLAGS.OTHER; }

// Avatar du podium : la photo du pilote si elle existe, sinon l'avatar kart (dessin
// coloré selon le numéro de kart, avec ce numéro affiché dessus).
// Un `src` invalide (chaîne vide, "null" littérale, URL cassée) laissait
// avant un <img> vide affiché comme un simple rond sombre — cercles noirs
// vus sur le site au lieu de l'avatar kart illustré. On valide la chaîne
// ET on pose un onerror qui bascule sur l'avatar kart si le chargement
// échoue quand même (photo supprimée du storage, etc.).
function pdfxLikeValidSrc(src) {
const p = typeof src === 'string' ? src.trim() : '';
const bad = !p || p.toLowerCase() === 'null' || p.toLowerCase() === 'undefined';
const looksLikeUrl = /^(https?:)?\/\//.test(p) || p.startsWith('data:') || p.startsWith('/');
return (!bad && looksLikeUrl) ? p : '';
}
// scheme : session_registrations.avatar_scheme (0-23) de l'inscrit, s'il en a
// choisi un explicitement au moment de l'inscription (nouveau parcours) —
// prioritaire sur la déduction historique depuis le numéro de kart. `null`/
// `undefined` reproduit exactement le comportement d'avant (repli sur kart).
function avatarHTML(src, kart, alt, cls = '', scheme) {
const p = pdfxLikeValidSrc(src);
if (p) {
const fallback = genAvatarDataURL(kart, { scheme });
return `<img class="pilot-avatar ${cls}" src="${p}" alt="${alt}" loading="lazy" crossorigin="anonymous" width="200" height="280" onerror="this.onerror=null;this.src='${fallback}'">`;
}
if (signatureAvatarsActive()) {
return `<div class="pilot-avatar-placeholder kart sigav-host ${cls}">${signatureAvatarHTML(kart, { title: alt, scheme })}</div>`;
}
return `<div class="pilot-avatar-placeholder kart ${cls}" role="img" aria-label="${alt}">${genAvatarSVG(kart, { title: alt, scheme })}</div>`;
}
function rankAvatarHTML(src, kart, scheme) {
const p = pdfxLikeValidSrc(src);
if (p) {
const fallback = genAvatarDataURL(kart, { scheme });
return `<img src="${p}" alt="" loading="lazy" crossorigin="anonymous" width="57" height="57" onerror="this.onerror=null;this.src='${fallback}'">`;
}
if (signatureAvatarsActive()) {
return `<div class="rank-avatar-placeholder kart sigav-host">${signatureAvatarHTML(kart, { small: true, scheme })}</div>`;
}
return `<div class="rank-avatar-placeholder kart">${genAvatarSVG(kart, { scheme })}</div>`;
}

/* Temps stockés en SECONDES dans Supabase (colonne laps.lap_time_seconds) */
function fmtTime(sec) {
const n = Number(sec);
if (!Number.isFinite(n) || n <= 0 || n >= 9000) return '--';
if (n >= 60) { const m = Math.floor(n / 60); const s = (n % 60).toFixed(3).padStart(6, '0'); return `${m}:${s}`; }
return `${n.toFixed(3)}s`;
}
function fmtGap(diffSec) {
if (diffSec == null || !Number.isFinite(diffSec)) return '--';
if (diffSec >= 60) { const m = Math.floor(diffSec / 60); const s = (diffSec % 60).toFixed(3).padStart(6, '0'); return `+${m}:${s}`; }
return `+${diffSec.toFixed(3)}s`;
}
function fmtSessionDate(d) {
if (!d) return '--';
return new Date(d + 'T12:00:00').toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });
}
/* Badge écart/temps, partagé podium + listes : au 1er on affiche son temps, sinon l'écart, sinon '--' */
function gapBadge(d) {
if (!d.hasTime) return '--';
return d.gap === 0 ? fmtTime(d.bestLap) : fmtGap(d.gap);
}

/* ------------------------------------------------------------------
RENDER — PODIUM (top 3) — classement = MEILLEUR TOUR de chaque pilote,
identique a l'admin (results.js > loadRanking). Le temps cumule n'est plus
utilise pour classer : il penalisait les pilotes ayant boucle le plus de tours.
------------------------------------------------------------------ */
function renderPodium(items) {
const wrap = document.getElementById('podium-wrap');
if (!items || !items.length) {
wrap.innerHTML = `<div class="empty-state"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg><p>Aucun résultat disponible</p></div>`;
return;
}
const posClass = ['', 'p1', 'p2', 'p3'];
wrap.innerHTML = items.map(d => {
const cls = posClass[d.pos] || '';
const gapTxt = gapBadge(d);
return `<article class="podium-card ${cls}" aria-label="P${d.pos} — ${d.name}">
<div class="pos-badge" aria-hidden="true">${d.pos}</div>
<div class="pilot-photo-wrap">${avatarHTML(d.photo, d.kart, `Photo de ${d.name}`, '', d.scheme)}</div>
<div class="pilot-name-band">
<div class="pilot-name ${d.isUnknown ? 'unknown' : ''}"><span class="pilot-flag" aria-hidden="true">${flagOf(d.nat)}</span>${d.name}</div>
<div class="pilot-info-bar">
<span class="pilot-kart">KART&nbsp;<strong>${d.kart ?? '-'}</strong></span>
<span class="pilot-gap ${d.pos === 1 ? 'leader' : ''} ${!d.hasTime ? 'no-data' : ''}" aria-label="Écart : ${gapTxt}">${gapTxt}</span>
</div>
</div>
</article>`;
}).join('');
}

/* ------------------------------------------------------------------
RENDER — une ligne de classement, réutilisée par le Top 10 (page 1)
et le Classement complet (page 2, avec le nombre de tours en plus)
------------------------------------------------------------------ */
function rankRowHTML(d, extraLine) {
const gapTxt = gapBadge(d);
const isLdr = d.hasTime && d.gap === 0;
return `<article class="top10-row" role="listitem" aria-label="P${d.pos} — ${d.name}">
<span class="rank-pos" aria-hidden="true">${d.pos}</span>
<div class="rank-avatar" aria-hidden="true">${rankAvatarHTML(d.photo, d.kart, d.scheme)}</div>
<div class="rank-main">
<div class="rank-name ${d.isUnknown ? 'unknown' : ''}"><span class="rank-flag" aria-hidden="true">${flagOf(d.nat)}</span>${d.name}</div>
<div class="rank-kartline">KART&nbsp;<span class="kart-num">${d.kart ?? '-'}</span>${extraLine ? ' · ' + extraLine : ''}</div>
</div>
<span class="rank-gap ${isLdr ? 'leader' : ''} ${!d.hasTime ? 'no-data' : ''}" aria-label="Écart : ${gapTxt}">${gapTxt}</span>
</article>`;
}

function renderTop10(items) {
const container = document.getElementById('top10-rows');
if (!items || !items.length) {
container.innerHTML = `<div class="empty-state"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg><p>Aucun pilote classé</p></div>`;
return;
}
container.innerHTML = items.map(d => rankRowHTML(d)).join('');
}

function renderPage2(items) {
const container = document.getElementById('page2-ranking');
if (!container) return;
if (!items || !items.length) {
container.innerHTML = `<div class="empty-state"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg><p>Aucun classement disponible</p></div>`;
return;
}
const count = items.length;
const density = Math.max(.48, Math.min(1, 12 / Math.max(count, 1)));
container.style.setProperty('--page2-count', String(count));
container.style.setProperty('--page2-density', String(density));
container.classList.toggle('is-ultra-dense', count > 16);
container.innerHTML = items.map(d => rankRowHTML(d, d.hasTime ? `${d.lapsCount} TOUR${d.lapsCount > 1 ? 'S' : ''}` : null)).join('');
}

/* ------------------------------------------------------------------
RENDER — PAGE 3 : détail tour par tour (accordéon dépliable)
------------------------------------------------------------------ */
function renderAccordion(items) {
const wrap = document.getElementById('page3-accordion');
if (!wrap) return;
if (!items || !items.length) {
wrap.innerHTML = `<div class="empty-state"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg><p>Aucun tour enregistré</p></div>`;
return;
}
wrap.innerHTML = items.map(d => {
const chips = d.lapsArr.map(l => {
const isBest = d.bestLap != null && l.time === d.bestLap;
return `<div class="lap-chip ${isBest ? 'best' : ''}"><div class="lc-idx">Tour ${l.idx}</div><div class="lc-time">${fmtTime(l.time)}</div></div>`;
}).join('') || `<div class="lap-chip-empty">Aucun tour enregistré.</div>`;
return `<article class="acc-item">
<div class="acc-head">
<span class="rank-pos acc-toggle" aria-hidden="true">${d.pos}</span>
<div class="rank-avatar acc-toggle" aria-hidden="true">${rankAvatarHTML(d.photo, d.kart, d.scheme)}</div>
<div class="rank-main acc-toggle">
<div class="rank-name ${d.isUnknown ? 'unknown' : ''}"><span class="rank-flag" aria-hidden="true">${flagOf(d.nat)}</span>${d.name}</div>
<div class="rank-kartline">KART&nbsp;<span class="kart-num">${d.kart ?? '-'}</span></div>
</div>
<span class="rank-gap leader" aria-label="Meilleur tour">${d.bestLap != null ? fmtTime(d.bestLap) : '--'}</span>
<button type="button" class="acc-icon-btn acc-pdf-btn" title="Télécharger la fiche pilote" aria-label="Télécharger la fiche pilote">${PDF_ICON}</button>
<button type="button" class="acc-icon-btn acc-toggle" aria-label="Afficher le détail des tours">${CHEVRON_ICON}</button>
</div>
<div class="acc-body"><div class="acc-body-inner">${chips}</div></div>
</article>`;
}).join('');

wrap.querySelectorAll('.acc-item').forEach((item, i) => {
item.querySelectorAll('.acc-toggle').forEach(el => el.addEventListener('click', () => item.classList.toggle('open')));
const pdfBtn = item.querySelector('.acc-pdf-btn');
if (pdfBtn) pdfBtn.addEventListener('click', (e) => { e.stopPropagation(); downloadPilotPDF(items[i], pdfBtn); });
});
}

// 🆕 QR code unique : un seul QR doit permettre d'atteindre aussi bien les
// résultats que l'inscription de LA MÊME session. public_session_results()
// relaie désormais sessions.public_registration_token dans son bloc
// 'session' (clé 'registration_token') — voir migration v28. Quand il est
// présent, le lien "Inscription" de la pilule de nav pointe vers cette
// session précise ; sinon (inscriptions fermées / aucun jeton actif pour
// cette session) il reste volontairement sur register.html nu plutôt que
// d'être masqué, par cohérence avec le choix symétrique côté register.js
// (applyResultsNavLink).
function applyRegistrationNavLink(session) {
  const link = document.getElementById('nav-register-link');
  if (!link) return;
  // 31/07 (correctif navigation) : le jeton de circuit ?v= doit survivre au
  // changement d'onglet, sinon on retombe sur "register.html" nu (lien mort).
  // Le circuit prime : avec ?v=, l'onglet Inscription affiche toujours
  // "Choisis ta session" avec les sessions actives du circuit.
  const p = new URLSearchParams(window.location.search);
  const venueToken = p.get('v') || p.get('venue');
  if (venueToken) {
    link.href = 'register?v=' + encodeURIComponent(venueToken);
  } else if (session && session.registration_token) {
    link.href = 'register?session=' + encodeURIComponent(session.registration_token);
  }
  prefetchNav(link.href);
}

// 02/08 (client) : "il faut que le clic soit plus fluide". Deux causes mesurees :
// (1) les liens pointaient vers *.html, ce qui declenche une redirection 308 de
//     Cloudflare Pages a CHAQUE clic (un aller-retour reseau complet perdu) ;
// (2) la page cible etait telechargee seulement au clic. On la prefetch des que
//     le lien est connu : le basculement devient quasi instantane.
function prefetchNav(href) {
  try {
    if (!href || document.querySelector('link[rel="prefetch"][data-nav]')) return;
    const l = document.createElement('link');
    l.rel = 'prefetch'; l.href = href; l.setAttribute('data-nav', '1');
    document.head.appendChild(l);
  } catch (e) {}
}


/* ------------------------------------------------------------------
CHARGEMENT DES DONNÉES RÉELLES (Supabase)
Règles de gestion :
- la session est retrouvée via ?result=TOKEN (public_results_token) ;
- le classement se fait sur le TEMPS TOTAL (somme des lap_time_seconds),
exactement comme loadRanking() côté admin — pas le meilleur tour seul ;
- un pilote sans aucun tour importé apparaît quand même, avec '--' ;
- un numéro de kart configuré (max_karts) mais jamais attribué à un
inscrit apparaît en fin de classement, marqué "Kart libre" ;
- la nationalité vient d'abord de l'inscription, puis du profil pilote.
------------------------------------------------------------------ */
/* ------------------------------------------------------------------
PAGE VENUE — le "QR unique" du circuit (31/07)
Les QR par session ont ete supprimes cote admin : il n'y a plus qu'UN
seul QR permanent, affiche a l'accueil du circuit, qui pointe vers
results.html?v=<public_venue_token>. Cette page s'actualise toute
seule : elle liste les sessions ouvertes a l'inscription du jour et
les resultats publies recemment, via le RPC public_venue_sessions
(SECURITY DEFINER, aucune donnee nominative exposee).
Le lien direct ?result=TOKEN envoye par e-mail continue de fonctionner
exactement comme avant : on ne passe ici QUE si ?result est absent.
------------------------------------------------------------------ */
function venueTime(iso) {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  } catch (e) { return ''; }
}

// 01/08 : la fenetre publique est de 3 h, "aujourd'hui / hier" n'avait donc
// plus aucun sens. On affiche a la place le nombre de participants, la seule
// information qui aide reellement le pilote a reconnaitre sa session.
function venuePeople(n) {
  const v = Number(n || 0);
  if (!v) return '';
  return v + (v > 1 ? ' participants' : ' participant');
}

function venueRow(href, tag, title, meta, hot) {
  return `<a class="venue-row${hot ? ' hot' : ''}" href="${href}">
<span class="venue-tag">${escapeHTML(tag)}</span>
<span class="venue-txt"><b>${escapeHTML(title)}</b><i>${escapeHTML(meta)}</i></span>
<svg class="venue-chev" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18l6-6-6-6"/></svg>
</a>`;
}

// Onglets en pilule centree. Volontairement AUTONOMES : ils ne sont plus
// greffes dans l'entete de la page resultats (voir renderVenuePicker).
function venueTabs(active, otherHref) {
  const reg = active === 'register'
    ? '<span>Inscription</span>'
    : '<a href="' + otherHref + '">Inscription</a>';
  const res = active === 'results'
    ? '<span>Résultats</span>'
    : '<a href="' + otherHref + '">Résultats</a>';
  return '<nav class="venue-tabs" aria-label="Navigation">' + reg + res + '</nav>';
}

function venueHero(logoUrl, circuit, title, sub) {
  // Le logo de Parametres est affiche tel quel : plus de fond accentue
  // derriere lui. Sans logo, on n'affiche rien du tout plutot qu'un pave.
  const logo = logoUrl
    ? '<img src="' + escapeHTML(logoUrl) + '" alt="">'
    : '';
  return '<div class="venue-hero">' +
    (logo ? '<div class="venue-logo">' + logo + '</div>' : '') +
    (circuit ? '<div class="venue-circuit">' + escapeHTML(circuit) + '</div>' : '') +
    '<h1 class="venue-title">' + escapeHTML(title) + '</h1>' +
    (sub ? '<p class="venue-sub">' + escapeHTML(sub) + '</p>' : '') +
    '</div>';
}

/* Coque commune : voir le meme bloc dans register.js. Aucune couleur en dur,
   tout descend des variables de theme. */
const VENUE_CSS = `<style id="venue-shell-css">
/* Coque commune aux deux ecrans de selection (resultats + inscription).
   Texte STRICTEMENT identique dans public-results.js et register.js : c'est
   ce qui garantit que la pastille d'onglets tombe au meme pixel et que la
   colonne a la meme largeur quand on passe d'un onglet a l'autre.
   Les tokens des deux pages different (--c-* cote resultats, --* cote
   inscription) : on les lit en cascade avec repli, donc aucune couleur en dur
   n'est imposee, le theme de Parametres > Apparence decide toujours. */
html.venue-mode,html.venue-mode body{height:auto;min-height:100%}
html.venue-mode body{display:block!important;margin:0!important;padding:0!important;align-items:stretch!important;justify-content:flex-start!important}
#venue-root{display:block;width:100%}
.venue-wrap{width:100%;max-width:33rem;margin:0 auto;padding:1.6rem 1.15rem 3.5rem;text-align:left;box-sizing:border-box}
.venue-tabs{display:flex;justify-content:center;gap:.25rem;width:19rem;max-width:100%;margin:0 auto 2rem;padding:.19rem;border:1px solid var(--c-border,var(--bord,rgba(255,255,255,.14)));border-radius:999px;background:rgba(255,255,255,.04)}
.venue-tabs a,.venue-tabs span{flex:1 1 0;text-align:center;padding:.5rem .6rem;border-radius:999px;font-family:var(--font-body,inherit);font-size:.75rem;font-weight:700;letter-spacing:.07em;text-transform:uppercase;text-decoration:none;color:var(--c-muted,var(--mut,#8a8f9a));transition:color .15s}
.venue-tabs a:hover{color:var(--c-text,var(--txt,#fff))}
.venue-tabs span{background:var(--c-accent,var(--acc,#ffb238));color:var(--c-bg,var(--bg,#0b0b0f))}
.venue-hero{text-align:center;margin:0 0 1.75rem}
.venue-logo{display:flex;align-items:center;justify-content:center;margin:0 auto 1rem;max-width:11rem;min-height:3rem;font-size:1.6rem;line-height:1}
.venue-logo img{max-width:100%;max-height:3.4rem;width:auto;height:auto;object-fit:contain;display:block}
.venue-circuit{font-size:.72rem;font-weight:700;letter-spacing:.22em;text-transform:uppercase;color:var(--c-accent,var(--acc,#ffb238));margin:0 0 .6rem}
.venue-title{font-family:var(--font-display,inherit);font-size:clamp(1.45rem,5.2vw,1.9rem);font-weight:600;line-height:1.15;letter-spacing:0;text-transform:none;margin:0 0 .35rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.venue-sub{margin:0;font-size:.85rem;line-height:1.5;color:var(--c-muted,var(--mut,#8a8f9a))}
.venue-row{display:flex;align-items:center;gap:.8rem;padding:.95rem 1.05rem;margin:0 0 .55rem;border:1px solid var(--c-border,var(--bord,rgba(255,255,255,.14)));border-radius:.9rem;background:rgba(255,255,255,.03);text-decoration:none;color:inherit;transition:border-color .15s,transform .15s}
.venue-row:hover{border-color:var(--c-accent,var(--acc,#ffb238));transform:translateY(-1px)}
.venue-row.hot{border-color:color-mix(in srgb,var(--c-accent,var(--acc,#ffb238)) 40%,transparent);background:color-mix(in srgb,var(--c-accent,var(--acc,#ffb238)) 5%,transparent)}
.venue-tag{flex:0 0 auto;font-size:.63rem;font-weight:700;letter-spacing:.1em;text-transform:uppercase;padding:.38rem .55rem;border-radius:999px;background:rgba(255,255,255,.08);color:var(--c-muted,var(--mut,#8a8f9a));white-space:nowrap}
.venue-row.hot .venue-tag{background:var(--c-accent,var(--acc,#ffb238));color:var(--c-bg,var(--bg,#0b0b0f))}
.venue-txt{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:.19rem}
.venue-txt b{font-size:.95rem;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.venue-txt i{font-style:normal;font-size:.78rem;color:var(--c-muted,var(--mut,#8a8f9a));white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.venue-chev{flex:0 0 auto;opacity:.4}
.venue-empty{padding:1.25rem;border:1px dashed var(--c-border,var(--bord,rgba(255,255,255,.14)));border-radius:.9rem;font-size:.87rem;line-height:1.6;color:var(--c-muted,var(--mut,#8a8f9a));text-align:center}
.venue-note{margin:1.6rem 0 0;font-size:.75rem;line-height:1.6;color:var(--c-muted,var(--mut,#8a8f9a));opacity:.7;text-align:center}
</style>`;

/* 01/08 : la coque de selection ne vit plus DANS le gabarit de la page hote.
   Les deux pages ont des enveloppes tres differentes (colonne 900px + podium
   cote resultats, body centre verticalement + carte 432px cote inscription) :
   tant que la coque etait posee dedans, la pastille d'onglets sautait de
   ~130px et la colonne changeait de largeur en passant d'un onglet a l'autre.
   On monte desormais la coque en enfant direct de <body>, on masque le reste
   et on neutralise le body via html.venue-mode. Geometrie identique des deux
   cotes, par construction. */
function mountVenue(inner) {
  document.documentElement.classList.add('venue-mode');
  Array.prototype.slice.call(document.body.children).forEach(el => {
    if (el.id !== 'venue-root' && el.tagName !== 'SCRIPT') el.style.display = 'none';
  });
  let root = document.getElementById('venue-root');
  if (!root) {
    root = document.createElement('div');
    root.id = 'venue-root';
    document.body.appendChild(root);
  }
  root.innerHTML = VENUE_CSS + '<div class="venue-wrap">' + inner + '</div>';
  return root;
}

export async function renderVenuePicker(venueToken) {

  // 01/08 : l'ecran de selection n'emprunte plus RIEN a la page resultats.
  // L'entete circuit (gros bloc centre avec halo, date et libelle de session)
  // decrit une session precise : elle n'a aucun sens tant qu'aucune session
  // n'est choisie. On la masque au meme titre que le podium, le top 10, les
  // pages 2/3, le bouton PDF et la pagination.
  ['podium-title', 'page-screen-2', 'page-screen-3'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = 'none';
  });
  const t10 = document.getElementById('top10-title');
  const t10s = t10 ? t10.closest('section') : null;
  if (t10s) t10s.style.display = 'none';
  ['.circuit-header', '.pdf-btn-wrap', '.page-nav', '.results-nav'].forEach(sel => {
    document.querySelectorAll(sel).forEach(el => { el.style.display = 'none'; });
  });
  const floatSwitch = document.querySelector('.page-switch');
  if (floatSwitch) floatSwitch.remove();

  mountVenue('<div class="venue-empty">Chargement…</div>');

  const { data, error } = await db.rpc('public_venue_sessions', { _venue_token: venueToken });
  if (error || !data) {
    mountVenue('<div class="venue-empty">Lien invalide ou circuit introuvable.</div>');
    return false;
  }

  // 01/08 : le theme n'est plus fige. Sans ?result=TOKEN on ne chargeait
  // aucune config de site, la page restait donc sur son theme par defaut
  // ("classic", rouge) meme quand le circuit avait choisi autre chose dans
  // Parametres > Apparence. public_venue_sessions relaie desormais
  // app_settings.global.results_theme : c'est LUI qui decide, jamais le code.
  const theme = String(data.results_theme || '').trim();
  if (theme) document.documentElement.setAttribute('data-theme', theme);
  try { if (data.results_theme) localStorage.setItem('kt_theme', theme); } catch (e) {}
  try { if (window.__ktReveal) window.__ktReveal(); } catch (e) {}

  // Le nom affiche est celui configure dans Parametres > Identite du circuit,
  // et non le nom technique du compte (qui faisait croire aux visiteurs qu'ils
  // consultaient les donnees d'un autre circuit).
  const venueName = String(data.venue_name || '').trim();
  if (venueName) document.title = venueName;

  const done = Array.isArray(data.recent_results) ? data.recent_results.slice() : [];
  // Ordre chronologique inverse : la publication la plus recente en haut.
  done.sort((a, b) => String(b.published_at || '').localeCompare(String(a.published_at || '')));

  const rows = done.length
    ? done.map((s, i) => venueRow(
        '?result=' + encodeURIComponent(s.results_token) + '&v=' + encodeURIComponent(venueToken),
        i === 0 ? 'Dernière' : 'Résultats',
        s.title || 'Session',
        [venuePeople(s.participants), 'publié à ' + venueTime(s.published_at)].filter(Boolean).join(' · '),
        i === 0
      )).join('')
    : '<div class="venue-empty">Aucun résultat publié pour l’instant.<br>Reviens juste après ta session.</div>';

  mountVenue(
    venueTabs('results', 'register?v=' + encodeURIComponent(venueToken)) +
    venueHero(data.logo_url, venueName, 'Choisis ta session',
              'Sélectionne la session que tu viens de courir pour voir le classement.') +
    rows +
    '<p class="venue-note">Les résultats restent affichés ici pendant 3 heures.<br>Le lien reçu par e-mail, lui, reste valable.</p>'
  );
  return true;
}

export async function load() {
const params0 = new URLSearchParams(window.location.search);
const token = params0.get('result');
// 31/07 : plus de resultat "brut". Sans ?result=TOKEN, on ne tombe plus en
// erreur : si un token de circuit (?v=) est present on affiche le selecteur
// de sessions (QR unique permanent). Sinon seulement, message d'erreur.
if (!token) {
  const venueToken = params0.get('v') || params0.get('venue');
  if (venueToken) { await renderVenuePicker(venueToken); return false; }
  return fail();
}
resultsToken = token;
rankingCache.clear();
palmaresCache.clear();
// AVANT tout rendu : sinon les avatars se dessinent en repli classique tant que
// la config n'est pas revenue (course avec initTheme(), memes promesse memoisee).
await loadSiteConfig();
// PDF_AVATAR_MODE est deja connu a ce stade (initTheme() est appele en premier
// par results-app.js et attache son .then() a la MEME promesse memoisee avant
// que ce await ne s'y attache a son tour -- meme garantie d'ordre que ci-dessus).
await ensureAvatarModuleLoaded();

// Lecture publique via RPC token-gated : les tables sessions/laps/session_registrations
// ne sont plus lisibles par la cle anon (fuite RGPD : emails et noms de tous les tenants).
const { data: bundle, error: sErr } = await db.rpc('public_session_results', { _results_token: token });
const session = bundle && bundle.session ? bundle.session : null;
if (sErr || !session) return fail();
sessionInfo = session;
applyRegistrationNavLink(session);
// Le reglage global (Parametres > Sessions > Nom du circuit) prime sur le champ
// sessions.circuit_name herite — voir le commentaire sur SITE_CIRCUIT_NAME plus haut.
// Ecrase sessionInfo.circuit_name en amont pour que TOUS les usages plus bas
// (fiche PDF, classement complet, cartes partageables) en beneficient sans
// modification supplementaire.
if (SITE_CIRCUIT_NAME) sessionInfo.circuit_name = SITE_CIRCUIT_NAME;

document.getElementById('circuit-name').textContent = circuitName();
document.title = 'Resultats — ' + circuitName();
document.getElementById('session-label').textContent = session.title || '--';
document.getElementById('session-date').textContent = fmtSessionDate(session.session_date);

const lapsRes = { data: bundle.laps || [], error: null };
const regsRes = { data: bundle.registrations || [], error: null };
const driversRes = { data: bundle.drivers || [], error: null };

const driversById = new Map((driversRes.data || []).map(d => [d.id, d]));
const totals = new Map(), lapCounts = new Map(), lapDetails = new Map();
(lapsRes.data || []).forEach(l => {
if (!l.registration_id) return;
totals.set(l.registration_id, (totals.get(l.registration_id) || 0) + Number(l.lap_time_seconds || 0));
lapCounts.set(l.registration_id, (lapCounts.get(l.registration_id) || 0) + 1);
if (!lapDetails.has(l.registration_id)) lapDetails.set(l.registration_id, []);
lapDetails.get(l.registration_id).push({
idx: l.lap_index,
time: Number(l.lap_time_seconds),
sectors: [l.sector_1_seconds, l.sector_2_seconds, l.sector_3_seconds].map(v => v == null ? null : Number(v)),
});
});

const results = [];
const usedKarts = new Set();

(regsRes.data || []).forEach(r => {
const drv = r.driver_id ? driversById.get(r.driver_id) : null;
const hasTime = totals.has(r.id);
const lapsArr = (lapDetails.get(r.id) || []).sort((a, b) => a.idx - b.idx);
const bestLap = lapsArr.length ? Math.min(...lapsArr.map(l => l.time)) : null;
results.push({
// 🆕 v28 : l'identifiant d'inscription voyage jusqu'ici. Il ne sert a rien
// au rendu, mais c'est la seule cle qui permet a l'admin de rattacher la
// fiche PDF generee dans l'iframe a la bonne ligne de session_registrations
// (donc au bon destinataire). Sans lui, « toutes les fiches en piece
// jointe » serait impossible : on ne saurait pas a qui envoyer quoi.
regId: r.id,
kart: r.kart_number,
name: r.display_name || 'Inconnu',
nat: r.nationality || (drv && drv.nationality) || 'OTHER',
photo: (drv && drv.photo_url) || null,
// avatar_scheme (0-23) : présent seulement pour les inscrits passés par le
// nouveau parcours (choix explicite au carrousel d'inscription). null pour
// tous les autres — le rendu retombe alors sur l'ancien comportement
// (déduction depuis le numéro de kart), inchangé.
scheme: (r.avatar_scheme != null ? r.avatar_scheme : null),
total: hasTime ? totals.get(r.id) : NO_TIME,
lapsCount: lapCounts.get(r.id) || 0,
lapsArr, bestLap,
isUnknown: !!r.is_unknown,
hasTime,
});
if (r.kart_number != null) usedKarts.add(Number(r.kart_number));
});

// Les slots de karts non attribués (max_karts non atteint) ne doivent PAS
// apparaître comme lignes "Kart libre" dans les résultats publics — seuls
// les pilotes réellement inscrits sont affichés (retour client explicite).

// Le classement se fait sur le meilleur tour. rankTime isole cette valeur pour
// que les pilotes sans chrono restent tries en dernier (sentinelle NO_TIME).
results.forEach(r => { r.rankTime = (r.hasTime && r.bestLap != null) ? r.bestLap : NO_TIME; });
results.sort((a, b) => a.rankTime - b.rankTime);
const leader = results.find(r => r.hasTime && r.bestLap != null);
const leaderBest = leader ? leader.bestLap : 0;
results.forEach((r, i) => {
  r.gap = (r.hasTime && r.bestLap != null) ? (r.bestLap - leaderBest) : null;
  r.pos = i + 1;
});

allResults = results;
renderPodium(results.slice(0, 3));
renderTop10(results.slice(3, PAGE1MAX));
renderPage2(results);
renderAccordion(results.filter(r => r.hasTime));

document.getElementById('page-nav').style.display = 'flex';
goToPage(1);
  return true;
}

function fail() {
const msg = `<div class="empty-state">
<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
<p>Résultats indisponibles ou lien invalide</p>
</div>`;
['podium-wrap', 'top10-rows', 'page2-ranking', 'page3-accordion'].forEach(id => {
const el = document.getElementById(id);
if (el) el.innerHTML = msg;
});
  return false;
}

/* ------------------------------------------------------------------
NAVIGATION — Précédent / points / Suivant
------------------------------------------------------------------ */
export function goToPage(n) {
if (n < 1 || n > 3) return;
currentPage = n;
document.querySelectorAll('.page-screen').forEach(el => el.classList.toggle('active', el.id === `page-screen-${n}`));
document.body.classList.toggle('podium-page-active', n === 1);
document.body.classList.toggle('compact-results-page', n === 1 || n === 2);
document.querySelectorAll('.nav-dot').forEach(d => d.classList.toggle('active', Number(d.dataset.dot) === n));
// 31/07 : sur la page 1, "Precedent" n'est plus grise sans rien faire — s'il
// y a un jeton de circuit (?v=) dans l'URL, il ramene vers l'accueil resultats
// (le picker de sessions), sinon (lien direct par e-mail, pas de circuit
// connu) on garde l'ancien comportement desactive.
const venueTok0 = new URLSearchParams(window.location.search).get('v') || new URLSearchParams(window.location.search).get('venue');
const prevBtn = document.getElementById('nav-prev');
prevBtn.disabled = (n === 1 && !venueTok0);
const prevLabel = prevBtn.querySelector('span');
if (prevLabel) prevLabel.textContent = (n === 1 && venueTok0) ? 'Résultats' : 'Précédent';
document.getElementById('nav-next').disabled = (n === 3);
document.getElementById('nav-next-label').textContent = (n === 1 ? 'Classement' : 'Détails');
window.scrollTo(0, 0);
}

export function initNav() {
document.getElementById('nav-prev').addEventListener('click', () => {
  if (currentPage === 1) {
    const v = new URLSearchParams(window.location.search).get('v') || new URLSearchParams(window.location.search).get('venue');
    if (v) { window.location.href = 'results?v=' + encodeURIComponent(v); return; }
    return;
  }
  goToPage(currentPage - 1);
});
document.getElementById('nav-next').addEventListener('click', () => goToPage(currentPage + 1));
document.querySelectorAll('.nav-dot').forEach(d => d.addEventListener('click', () => goToPage(Number(d.dataset.dot))));
}

/* ------------------------------------------------------------------
EXPORT PDF (jsPDF + html2canvas) — rendu à partir des mêmes pages
HTML/CSS déjà stylées, donc le PDF suit toujours le thème actif.
Limite connue : html2canvas ne supporte pas clip-path, donc les
coins découpés des thèmes Classic/Neon apparaissent en rectangles
simples dans le PDF (l'affichage web n'est pas concerné).
------------------------------------------------------------------ */
const PDF_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M12 3v12m0 0l-4-4m4 4l4-4M5 21h14"/></svg>';
const SPIN_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M21 12a9 9 0 1 1-2.64-6.36"/></svg>';
const CHEVRON_ICON = '<svg class="acc-toggle-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M6 9l6 6 6-6"/></svg>';

function escapeHTML(value) {
const node = document.createElement('span');
node.textContent = value == null ? '' : String(value);
return node.innerHTML;
}

async function sectionToCanvas(node, width, bg, scale) {
const holder = document.getElementById('pdf-render-root');
holder.innerHTML = '';
holder.style.width = width + 'px';
const wrap = document.createElement('div');
wrap.style.width = width + 'px';
wrap.style.background = bg || '#ffffff';
wrap.appendChild(node);
holder.appendChild(wrap);
// Laisser le temps aux <img> (avatars data-URI) de se décoder avant la capture.
// NB : on ne teste QUE img.complete. Tester naturalWidth bloquait indéfiniment
// sur les SVG data-URI sans dimensions intrinsèques (naturalWidth === 0) déjà
// chargés : le prédicat restait faux et onload ne se redéclenchait jamais —
// ce qui figeait la génération dès la 2e page. Filet de sécurité à 3 s.
await Promise.all(Array.from(wrap.querySelectorAll('img')).map(img =>
img.complete ? Promise.resolve() : new Promise(res => {
let done = false;
const fin = () => { if (!done) { done = true; res(); } };
img.onload = img.onerror = fin;
setTimeout(fin, 3000);
})
));
await new Promise(r => setTimeout(r, 80));
// --- Correctif metriques de police html2canvas -------------------------
// html2canvas 1.x calcule la ligne de base de CHAQUE police via
// FontMetrics.parseMetrics() : il cree un <div> cache contenant un <span>
// "Hidden Text" et une <img> GIF 1x1 en vertical-align:baseline, puis
// deduit la baseline de (img.offsetTop - span.offsetTop + 2).
// Or le reset global de results.html declare
// `img{display:block;max-width:100%;height:auto}` : la sonde 1x1 devient un
// bloc, sort du flux en ligne, offsetTop est faux -> toutes les lignes de
// texte sont peintes trop bas puis rognees par les overflow:hidden (noms
// "manges", colonnes non centrees verticalement).
// On neutralise donc display:block UNIQUEMENT pour cette sonde, et seulement
// le temps de la capture. On ne touche surtout pas a vertical-align :
// html2canvas le repositionne lui-meme (baseline puis super) pour ses deux
// mesures, un !important casserait le calcul.
const h2cFix = document.createElement('style');
h2cFix.setAttribute('data-h2c-metrics-fix', '1');
h2cFix.textContent = 'img[width="1"][height="1"]{display:inline!important;max-width:none!important;border:0!important;margin:0!important;padding:0!important}';
document.head.appendChild(h2cFix);
// --- Elagage du clone (correctif de performance v28) -------------------
// html2canvas ne capture QUE `wrap`, mais il commence par cloner tout le
// document, puis rastérise chaque <svg> en ligne rencontré — y compris les
// 65 casques Signature affichés sur la page, à 1024x1024 chacun, à CHAQUE
// appel. Mesure faite au banc (session de 13 pilotes, Chromium) : capturer
// une simple <div> de 120x60 px coûtait 48 s ; en retirant les <svg> du
// document, 0,12 s. C'était donc 100 % de frais fixes payés par appel, sans
// rapport avec ce qu'on capture réellement.
// `ignoreElements` (supporté par html2canvas 1.4.1, cf. appendChildNode) fait
// sauter du clone tout ce qui n'est ni <head> (il porte les @font-face et le
// correctif de métriques ci-dessus), ni un ancêtre de `wrap`, ni son contenu.
// La mise en page du sous-arbre capturé n'en dépend pas : #pdf-render-root est
// en position:fixed hors écran et `wrap` a une largeur explicite.
// Gain mesuré sur la même session : classement 63 s -> 4 s, fiche pilote
// 98 s -> 7 s. Sans ce correctif, générer les 13 fiches en pièce jointe
// aurait immobilisé le navigateur de l'admin une vingtaine de minutes.
const keepInClone = (el) =>
document.head.contains(el) || el.contains(wrap) || wrap.contains(el);
let canvas;
try {
canvas = await html2canvas(wrap, { backgroundColor: bg || '#ffffff', scale: scale || 2.5, width, windowWidth: width, useCORS: true, allowTaint: false, imageTimeout: 8000, ignoreElements: (el) => !keepInClone(el) });
} finally {
h2cFix.remove();
}
holder.innerHTML = '';
return canvas;
}
function canvasHeightMm(canvas, usableWmm) { return canvas.height * usableWmm / canvas.width; }

// Couleurs du thème actif (pour que les PDF reprennent la même identité visuelle
// que la page résultats, au lieu d'un fond blanc générique).
function themeColors() {
const cs = getComputedStyle(document.documentElement);
const g = (name, fallback) => { const v = cs.getPropertyValue(name); return (v && v.trim()) || fallback; };
return {
bg: g('--c-bg', '#050608'),
surface: g('--c-surface', '#0d0f14'),
surface2: g('--c-surface-2', '#12151c'),
border: g('--c-border', 'rgba(255,255,255,.12)'),
text: g('--c-text', '#f4f5f8'),
muted: g('--c-muted', '#7a7d8a'),
accent: g('--c-accent', '#ff2a2a'),
p1: g('--c-p1-border', '#ff2a2a'),
p2: g('--c-p2-border', 'rgba(255,255,255,.4)'),
p3: g('--c-p3-border', 'rgba(180,120,50,.75)'),
};
}
function themeAccent() { return themeColors().accent; }

// Convertit un fond CSS (hex ou rgb/rgba) en RGB entier pour pdf.setFillColor.
function pdfRGB(pdf, cssColor, method) {
const el = document.createElement('div');
el.style.color = cssColor;
document.body.appendChild(el);
const rgb = getComputedStyle(el).color;
document.body.removeChild(el);
const m = rgb.match(/[\d.]+/g) || [5, 6, 8];
pdf[method](Number(m[0]), Number(m[1]), Number(m[2]));
}

function fmtPdfTime(sec) {
const n = Number(sec);
if (!Number.isFinite(n) || n < 0) return '--';
const min = Math.floor(n / 60);
const rest = (n % 60).toFixed(3).padStart(6, '0');
return `${String(min).padStart(2, '0')}:${rest}`;
}

/* ==================================================================
   PDF — IDENTITÉ VISUELLE DES MAQUETTES
   Le rendu est construit à la taille réelle d'une feuille A4 en points
   CSS (595 x 842 en portrait, 842 x 595 en paysage) avec 22px de marge
   intérieure : la capture html2canvas se pose donc 1:1 sur la page PDF,
   sans remise à l'échelle, exactement comme dans les maquettes.
   Toutes les couleurs proviennent des variables de thème --c-* de
   results.html : le PDF suit automatiquement le thème du circuit.
   ================================================================== */

/* Format demandé par l'utilisateur : 'portrait' ou 'landscape'. */
let PDF_ORIENT = 'portrait';

/* Dimensions de la feuille selon le format. */
function pdfxGeom(orient) {
  const landscape = orient === 'landscape';
  return {
    landscape,
    renderW: landscape ? 842 : 595,   // largeur de rendu en px CSS
    sheetH: landscape ? 595 : 842,    // hauteur de la feuille en px CSS
    pageW: landscape ? 297 : 210,     // largeur PDF en mm
    pageH: landscape ? 210 : 297,     // hauteur PDF en mm
    // 44 = padding de la page (22 x 2), 10 = marge de sécurité
    budgetPx: (landscape ? 595 : 842) - 44 - 10,
  };
}

/* ------------------------------------------------------------------
   Encre lisible sur fond --c-accent.

   Certains thèmes définissent --c-gap-text (l'encre du badge d'écart)
   avec la même valeur que --c-accent : sur le thème « carbon », les
   deux valent #c9a84c. Tout élément qui peignait --c-gap-text sur un
   fond --c-accent sortait donc doré sur doré, donc illisible (ligne du
   meilleur tour de la fiche pilote, carré d'initiale du circuit,
   sélecteur Portrait/Paysage actif).

   On ne se repose plus sur une variable de thème : on calcule l'encre
   à partir de la luminance réelle de l'accent, ce qui reste juste quel
   que soit le thème, présent ou futur.
   ------------------------------------------------------------------ */
let PDX_ACCENT_IS_LIGHT = false;

function pdxParseColor(str) {
  const s = String(str || '').trim();
  let m = /^#([0-9a-f]{3})$/i.exec(s);
  if (m) return [0, 1, 2].map(i => parseInt(m[1][i] + m[1][i], 16));
  m = /^#([0-9a-f]{6})$/i.exec(s);
  if (m) return [0, 2, 4].map(i => parseInt(m[1].substr(i, 2), 16));
  m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(s);
  if (m) return [1, 2, 3].map(i => Math.round(parseFloat(m[i])));
  return null;
}

function pdxRelLuminance(rgb) {
  const lin = rgb.map(v => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
}

const PDX_INK_DARK = '#141414';
const PDX_INK_LIGHT = '#ffffff';
/* Seuil WCAG AA pour du texte gras / grande taille — c'est exactement la
   nature des éléments concernés (13 à 16 px en gras, pastille en 800). */
const PDX_MIN_RATIO = 3;

function pdxContrast(l1, l2) {
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

/* Recalcule --pdx-on-accent. Appelé avant chaque construction de PDF et
   à l'initialisation du sélecteur de format : le thème peut changer en
   cours de session sans rechargement.

   Règle : on garde le blanc dès qu'il est suffisamment lisible — c'est le
   rendu actuel sur « classic », il n'y a aucune raison de le changer — et
   on ne bascule sur une encre sombre que lorsque le blanc ne passe plus,
   ce qui est le cas de l'or de « carbon » (rapport 2,3) et du cyan de
   « neon » (rapport 1,8, déjà traité en sombre aujourd'hui). */
function syncPdfOnAccentInk() {
  try {
    const root = document.documentElement;
    const cs = getComputedStyle(root);
    const rgb = pdxParseColor(cs.getPropertyValue('--c-accent')) || [255, 213, 74];
    const la = pdxRelLuminance(rgb);
    const useLight = pdxContrast(la, pdxRelLuminance([255, 255, 255])) >= PDX_MIN_RATIO;
    PDX_ACCENT_IS_LIGHT = !useLight;
    root.style.setProperty('--pdx-on-accent', useLight ? PDX_INK_LIGHT : PDX_INK_DARK);
    pdxObserveTheme();
  } catch (_) { /* pas de DOM : rien à synchroniser */ }
}

/* Le thème n'est PAS connu au chargement : results.html part sur
   data-theme="classic" et initTheme() ne remplace l'attribut qu'après la
   lecture de app_settings, donc bien après l'initialisation du sélecteur de
   format. Une synchronisation unique à l'init lisait donc le rouge de
   « classic » (contraste 3,74 sur blanc, le blanc passe) et figeait l'encre
   sur blanc — puis « carbon » arrivait et le bouton actif du sélecteur
   redevenait doré sur doré. Les PDF eux-mêmes étaient corrects, parce que
   ensurePdfStyles() resynchronise avant chaque export.

   On surveille donc data-theme et on resynchronise à chaque changement. Comme
   les règles concernées pointent var(--pdx-on-accent), la correction de la
   variable suffit : le navigateur repeint tout seul. */
let PDX_THEME_OBSERVED = false;

function pdxObserveTheme() {
  if (PDX_THEME_OBSERVED || typeof MutationObserver !== 'function') return;
  PDX_THEME_OBSERVED = true;
  new MutationObserver(syncPdfOnAccentInk).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-theme'],
  });
}

/* On amorce dès le chargement du module, sans attendre ni le sélecteur de
   format ni un premier export : l'observateur est ainsi en place quel que soit
   le chemin d'entrée, y compris sur une page qui n'a pas de bouton PDF. */
if (typeof document !== 'undefined' && document.documentElement) syncPdfOnAccentInk();

/* Sur accent clair, la pastille « MEILLEUR » doit être assombrie et non
   éclaircie, sinon elle disparaît elle aussi dans le fond. */
function pdxPageClass(landscape) {
  return 'pdfx-page ' + (landscape ? 'landscape' : 'portrait') +
    (PDX_ACCENT_IS_LIGHT ? ' pdfx-dark-pill' : '');
}

let PDF_STYLES_INJECTED = false;
function ensurePdfStyles() {
  syncPdfOnAccentInk();
  if (PDF_STYLES_INJECTED) return;
  const style = document.createElement('style');
  style.id = 'pdfx-styles';
  style.textContent = `
.pdfx-page{
  --pdx-p1:#ffd54a; --pdx-p2:#c7cbd6; --pdx-p3:#d98a4a;
  background:var(--c-bg);padding:22px;position:relative;
  font-family:var(--font-body);box-sizing:border-box;
}
.pdfx-page *{box-sizing:border-box;margin:0;padding:0}
/* Avatars PDF : voir pdfxAvatarImg() — background-size (supporte par html2canvas)
   au lieu de object-fit (non supporte). */
/* line-height >= 1.4 sur les libelles tronques : avec overflow:hidden et un
   line-height normal (~1.2) la boite fait pile la hauteur de la ligne et les
   jambages (p, g, j) se font raboter au rendu canvas. */
.pdfx-av{display:block;width:100%;height:100%;background-size:cover;background-position:center;background-repeat:no-repeat}
.pdfx-page.portrait{width:595px}
.pdfx-page.landscape{width:842px}
.pdfx-sheet{display:flex;flex-direction:column;background:var(--c-surface);border:1px solid var(--c-border);border-radius:14px;overflow:hidden}

/* ---------- Bandeau d'en-tête (classement) ---------- */
.pdfx-head-band{position:relative;padding:16px 24px;background:linear-gradient(120deg,var(--c-accent-glow,rgba(255,42,42,.35)),transparent 65%),var(--c-surface-2);border-bottom:1px solid var(--c-border);display:flex;align-items:center;justify-content:space-between;gap:16px}
.pdfx-page.landscape .pdfx-head-band{padding:14px 28px}
.pdfx-head-band::after{content:'';position:absolute;top:8px;right:8px;width:18px;height:18px;border-top:2px solid var(--c-accent);border-right:2px solid var(--c-accent);opacity:.5}
.pdfx-head-left{min-width:0;flex:1 1 auto;overflow:hidden}
.pdfx-head-left .pdfx-circuit-name{font-family:var(--font-display);font-weight:700;font-style:italic;font-size:22px;text-transform:uppercase;color:var(--c-text);letter-spacing:.01em;transform:skewX(-6deg);transform-origin:left;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%;padding-right:.22em;line-height:1.32}
.pdfx-head-left .pdfx-session-lbl{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%;font-size:10.5px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:var(--c-accent);margin-top:2px}
.pdfx-head-right{text-align:right;flex:0 0 auto;min-width:0;max-width:34%;overflow:hidden}
.pdfx-head-right .pdfx-date{font-size:11.5px;font-weight:700;letter-spacing:.05em;color:var(--c-muted);text-transform:uppercase}
.pdfx-head-right .pdfx-count{font-size:10.5px;color:var(--c-muted);margin-top:2px}
/* 🆕 v19 : logo du circuit dans le bandeau du PDF "Classement complet" — placé entre
   le nom et les infos de droite via l'ordre du flex (justify-content:space-between
   sur .pdfx-head-band le pousse naturellement au centre grâce à ce 3e enfant). */
.pdfx-head-logo{flex-shrink:0;max-height:34px;max-width:100px;object-fit:contain;order:2}
.pdfx-head-band .pdfx-head-right{order:3}
.pdfx-page.landscape .pdfx-head-logo{max-height:40px;max-width:130px}

/* ---------- Corps : 1 colonne en portrait, 2 en paysage ---------- */
.pdfx-body-wrap{display:flex;flex-direction:column;flex:1;min-height:0}
.pdfx-page.landscape .pdfx-body-wrap{flex-direction:row;align-items:stretch}

/* ---------- Podium horizontal (portrait) ---------- */
.pdfx-podium{display:flex;align-items:flex-end;gap:10px;padding:16px 24px 14px;border-bottom:1px solid var(--c-border)}
.pdfx-p-card{flex:1;min-width:0;background:var(--c-surface-2);border-radius:12px;border:2px solid var(--c-border);padding:10px 8px 8px;position:relative;text-align:center}
.pdfx-p-card.p1{border-color:var(--pdx-p1);order:2;padding-top:6px}
.pdfx-p-card.p2{border-color:var(--pdx-p2);order:1}
.pdfx-p-card.p3{border-color:var(--pdx-p3);order:3}
.pdfx-p-rank{font-family:var(--font-display);font-weight:700;font-style:italic;font-size:14px;position:absolute;top:6px;left:8px;color:var(--c-muted)}
.pdfx-p-card.p1 .pdfx-p-rank{color:var(--pdx-p1);font-size:17px}
.pdfx-p-avatar{width:54px;height:54px;border-radius:50%;margin:4px auto 6px;overflow:hidden;background:var(--c-bg);border:2px solid var(--c-border);flex-shrink:0}
.pdfx-p-card.p1 .pdfx-p-avatar{width:66px;height:66px;border-color:var(--pdx-p1)}
.pdfx-p-card.p2 .pdfx-p-avatar{border-color:var(--pdx-p2)}
.pdfx-p-card.p3 .pdfx-p-avatar{border-color:var(--pdx-p3)}
.pdfx-p-avatar .pdfx-av{width:100%;height:100%}
.pdfx-p-name{font-family:var(--font-display);font-weight:700;font-style:italic;font-size:13px;text-transform:uppercase;color:var(--c-text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;line-height:1.45}
.pdfx-p-card.p1 .pdfx-p-name{font-size:15px}
.pdfx-p-kart{font-size:9px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--c-muted);margin-top:2px}
.pdfx-p-stats{display:flex;justify-content:center;gap:8px;margin-top:7px;padding-top:7px;border-top:1px solid var(--c-border)}
.pdfx-p-stat{display:flex;flex-direction:column;line-height:1.2}
.pdfx-p-stat .k{font-size:7px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;color:var(--c-muted)}
.pdfx-p-stat .v{font-family:var(--font-display);font-weight:700;font-size:12px;color:var(--c-text)}
.pdfx-p-stat .v.best{color:var(--c-accent)}
.pdfx-p-card.p1 .pdfx-p-stat .v.best{color:var(--pdx-p1)}

/* ---------- Podium vertical (paysage) : colonne latérale ---------- */
.pdfx-podium-col{width:238px;flex-shrink:0;border-right:1px solid var(--c-border);padding:14px 16px 10px;display:flex;flex-direction:column;gap:9px}
.pdfx-podium-col-title{font-size:9px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:var(--c-muted);border-left:3px solid var(--c-accent);padding-left:7px;margin-bottom:2px}
.pdfx-pv-card{display:flex;align-items:center;gap:10px;background:var(--c-surface-2);border:2px solid var(--c-border);border-radius:10px;padding:8px 10px}
.pdfx-pv-card.pv1{border-color:var(--pdx-p1)}
.pdfx-pv-card.pv2{border-color:var(--pdx-p2)}
.pdfx-pv-card.pv3{border-color:var(--pdx-p3)}
.pdfx-pv-rank{font-family:var(--font-display);font-weight:700;font-style:italic;font-size:16px;color:var(--c-muted);width:14px;flex-shrink:0;text-align:center}
.pdfx-pv-card.pv1 .pdfx-pv-rank{color:var(--pdx-p1);font-size:19px}
.pdfx-pv-avatar{width:36px;height:36px;border-radius:50%;overflow:hidden;background:var(--c-bg);border:2px solid var(--c-border);flex-shrink:0}
.pdfx-pv-card.pv1 .pdfx-pv-avatar{border-color:var(--pdx-p1);width:42px;height:42px}
.pdfx-pv-card.pv2 .pdfx-pv-avatar{border-color:var(--pdx-p2)}
.pdfx-pv-card.pv3 .pdfx-pv-avatar{border-color:var(--pdx-p3)}
.pdfx-pv-avatar .pdfx-av{width:100%;height:100%}
.pdfx-pv-info{min-width:0;flex:1;display:flex;flex-direction:column;gap:2px}
.pdfx-pv-name{font-family:var(--font-display);font-weight:700;font-style:italic;font-size:13.5px;text-transform:uppercase;color:var(--c-text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;line-height:1.45}
.pdfx-pv-meta{display:flex;gap:6px;flex-wrap:wrap}
.pdfx-pv-meta span{font-size:7.5px;font-weight:700;letter-spacing:.03em;text-transform:uppercase;color:var(--c-muted);white-space:nowrap}
.pdfx-pv-meta b{color:var(--c-accent)}
.pdfx-pv-card.pv1 .pdfx-pv-meta b{color:var(--pdx-p1)}

/* ---------- Tableau du classement ---------- */
.pdfx-rank-wrap{padding:12px 24px 16px;flex:1;min-width:0}
.pdfx-page.landscape .pdfx-rank-wrap{padding:12px 22px 16px}
.pdfx-rank-title{font-size:10px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:var(--c-muted);border-left:3px solid var(--c-accent);padding-left:8px;margin-bottom:6px}
.pdfx-rank-head{display:grid;grid-template-columns:26px 28px 1.5fr 46px 44px 74px 66px;gap:4px;padding:0 8px 6px;font-size:8.5px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;color:var(--c-muted);border-bottom:1px solid var(--c-border)}
.pdfx-rank-head span.num{text-align:center}
/* Les libellés d'en-tête ne doivent jamais passer sur 2 lignes : « MEILL. TOUR »
   se cassait en « MEILL. / TOUR » et décalait la hauteur de la ligne d'en-tête. */
.pdfx-rank-head span{white-space:nowrap}
.pdfx-rank-body{margin-top:2px}
.pdfx-rank-row{display:grid;grid-template-columns:26px 28px 1.5fr 46px 44px 74px 66px;gap:4px;align-items:center;padding:5px 8px;font-size:11px;color:var(--c-text);border-bottom:1px solid var(--c-border)}
.pdfx-rank-row:nth-child(even){background:var(--c-surface-2)}
.pdfx-rank-row:last-child{border-bottom:none}
.pdfx-rank-row .pos{font-family:var(--font-display);font-weight:700;font-style:italic;font-size:13px;color:var(--c-muted);text-align:center;font-variant-numeric:tabular-nums}
.pdfx-rank-row .av{width:20px;height:20px;border-radius:50%;overflow:hidden;background:var(--c-bg);border:1px solid var(--c-border)}
.pdfx-rank-row .av .pdfx-av{width:100%;height:100%}
.pdfx-rank-row .name{font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;line-height:1.45}
.pdfx-rank-row .kart{color:var(--c-muted);font-size:10px;text-align:center;font-variant-numeric:tabular-nums}
.pdfx-rank-row .laps{color:var(--c-muted);font-size:10px;text-align:center;font-variant-numeric:tabular-nums}
.pdfx-rank-row .best{font-weight:700;font-size:10.5px;text-align:center;font-variant-numeric:tabular-nums}
.pdfx-rank-row .gap{color:var(--c-muted);font-size:10px;text-align:center;font-variant-numeric:tabular-nums}
.pdfx-rank-row.top3 .pos{color:var(--c-accent)}
.pdfx-rank-row .sec{color:var(--c-muted);font-size:9.5px;text-align:center;font-variant-numeric:tabular-nums}
/* Colonnes resserrées quand les secteurs sont affichés : sans ça la colonne PILOTE
   tombait sous ~95pt en portrait et les noms longs (« Emma BERNARD ») étaient coupés
   en plein glyphe — html2canvas ne dessine pas les « … » de text-overflow. */
.pdfx-rank-head.with-sec,.pdfx-rank-row.with-sec{grid-template-columns:22px 24px minmax(92px,1fr) 30px 30px 62px 50px 42px 42px 42px;gap:3px}
/* Libellés d'en-tête resserrés en mode secteurs : « TOURS » débordait de sa
   colonne de 30px et se collait à « MEILL. TOUR ». */
.pdfx-rank-head.with-sec{font-size:8px;letter-spacing:.02em}
.pdfx-page.landscape .pdfx-rank-head.with-sec,.pdfx-page.landscape .pdfx-rank-row.with-sec{grid-template-columns:24px 26px minmax(108px,1fr) 34px 34px 62px 50px 43px 43px 43px;gap:3px}

/* ---------- Pied de page ---------- */
.pdfx-sheet-footer{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:9px 24px 14px;font-size:9px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--c-muted)}
.pdfx-page.landscape .pdfx-sheet-footer{padding:9px 28px 14px}
.pdfx-sheet-footer b{color:var(--c-text)}
.pdfx-sheet-footer span{min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}

/* ---------- Bandeau allégé des pages 2+ (classement) ---------- */
.pdfx-rank-header-mini{display:flex;align-items:center;justify-content:space-between;gap:14px;padding:12px 24px;border-bottom:1px solid var(--c-border)}
.pdfx-page.landscape .pdfx-rank-header-mini{padding:12px 28px}
.pdfx-rank-header-mini .mini-name{font-family:var(--font-display);font-weight:700;font-style:italic;font-size:16px;text-transform:uppercase;color:var(--c-text);transform:skewX(-6deg)}
.pdfx-rank-header-mini .mini-tag{font-size:10px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--c-muted)}
.pdfx-rank-header-mini .mini-page{font-size:10px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--c-accent)}

/* ================= FICHE PILOTE ================= */
.pdfx-topbar{height:5px;width:100%;background:linear-gradient(90deg,var(--c-accent),transparent 140%)}
.pdfx-fp-header{position:relative;padding:16px 18px;display:flex;flex-direction:row;align-items:center;gap:10px;flex-wrap:nowrap;border-bottom:1px solid var(--c-border)}
.pdfx-fp-header::after{content:'';position:absolute;top:8px;right:8px;width:22px;height:22px;border-top:2px solid var(--c-accent);border-right:2px solid var(--c-accent);opacity:.5}
.pdfx-photo-wrap{position:relative;width:56px;height:56px;flex-shrink:0}
.pdfx-photo{width:56px;height:56px;border-radius:12px;overflow:hidden;border:1px solid var(--c-border);background:var(--c-surface-2);display:flex;align-items:center;justify-content:center}
.pdfx-photo .pdfx-av{width:100%;height:100%}
.pdfx-photo svg{width:28px;height:28px;stroke:var(--c-muted);opacity:.6}
.pdfx-kart-badge{position:absolute;right:-10px;bottom:-10px;width:30px;height:30px;border-radius:50%;display:flex;align-items:center;justify-content:center;border:2px solid var(--c-surface);box-shadow:0 2px 8px rgba(0,0,0,.5);background:var(--c-bg);overflow:hidden}
.pdfx-kart-badge .pdfx-av{width:100%;height:100%}
/* ---------------------------------------------------------------------
   Correctif de debordement de l'en-tete (v28).

   L'en-tete aligne QUATRE blocs sur une seule ligne (flex-wrap:nowrap)
   dans une feuille A4 portrait qui ne fait que 595 px de large, soit
   515 px utiles apres les paddings. Tant que la carte de synthese ne
   contenait qu'une ligne (« Meilleur tour »), ca tenait. L'ajout du
   palmares en a fait trois lignes cote a cote, et comme la carte etait
   declaree flex-shrink:0, elle a pousse le bloc circuit HORS de la
   feuille : « CIRCUIT DE TRINI », « 28/07/20 », « TEST GLOBA » etaient
   coupes net au bord droit. Les ellipses CSS ne pouvaient rien y faire —
   les libelles ne debordaient pas de LEUR boite, c'est la ligne entiere
   qui debordait de la page.

   Regle desormais tenue : chaque bloc de l'en-tete peut se reduire
   jusqu'a son contenu minimal (min-width:0), la carte de synthese
   passe a la ligne au lieu de s'etaler, et le bloc circuit garde sa
   largeur naturelle plafonnee. Somme des minimums ~325 px : le
   debordement n'est plus atteignable, quel que soit le nom du circuit
   ou le libelle de la session. */
.pdfx-id-block{min-width:0;flex:1 1 92px}
.pdfx-pilot-name{font-family:var(--font-display);font-weight:700;font-style:italic;font-size:17px;text-transform:uppercase;letter-spacing:.01em;color:var(--c-text);transform:skewX(-6deg);transform-origin:left;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%;line-height:1.4;padding-right:.22em}
.pdfx-id-meta{display:flex;gap:7px;row-gap:3px;margin-top:3px;flex-wrap:wrap}
.pdfx-id-meta .item{font-size:9.5px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--c-muted);white-space:nowrap}
.pdfx-id-meta .item b{color:var(--c-accent);font-size:1.05em}
.pdfx-summary-card{background:var(--c-surface-2);border:1px solid var(--c-border);border-radius:9px;padding:6px 9px;display:flex;flex-direction:row;column-gap:8px;row-gap:5px;align-items:center;flex:0 1 auto;min-width:0;flex-wrap:wrap}
.pdfx-summary-row{display:flex;align-items:center;gap:6px;min-width:0}
.pdfx-summary-row svg{width:12px;height:12px;stroke:var(--c-accent);flex-shrink:0}
.pdfx-summary-row .txt{display:flex;flex-direction:column;line-height:1.1;min-width:0}
.pdfx-summary-row .txt .k{font-size:7.5px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;color:var(--c-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pdfx-summary-row .txt .v{font-family:var(--font-display);font-size:14px;font-weight:700;color:var(--c-text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pdfx-summary-row.best .txt .v{color:var(--c-accent)}
.pdfx-circuit-block{display:flex;align-items:center;gap:6px;flex:0 0 auto;min-width:0;max-width:200px;margin-left:auto}
.pdfx-circuit-text{text-align:right;min-width:0;overflow:hidden;flex:1 1 auto}
.pdfx-circuit-block .pdfx-c-name{font-family:var(--font-display);font-weight:700;font-style:italic;font-size:12.5px;text-transform:uppercase;color:var(--c-text);letter-spacing:.01em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%;padding-right:.22em;line-height:1.34}
.pdfx-circuit-meta{display:flex;flex-direction:column;gap:2px;margin-top:2px;align-items:flex-end;min-width:0}
.pdfx-circuit-meta .item{display:flex;align-items:center;gap:4px;font-size:8.5px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:var(--c-muted);white-space:nowrap;min-width:0;max-width:100%}
.pdfx-circuit-meta .item svg{width:10px;height:10px;stroke:var(--c-accent);flex-shrink:0}
.pdfx-circuit-meta .item span{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.pdfx-circuit-logo{flex-shrink:0;width:30px;height:30px;border-radius:8px;background:var(--c-accent);display:flex;align-items:center;justify-content:center;font-family:var(--font-display);font-weight:700;font-size:13px;color:var(--pdx-on-accent,#fff)}

/* Tableau des tours */
.pdfx-tbl-wrap{padding:16px 24px 20px}
.pdfx-tbl-head{display:grid;grid-template-columns:.7fr 1.1fr 1fr 1fr 1fr 1fr;padding:0 10px 8px;font-size:10.5px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--c-muted);border-bottom:1px solid var(--c-border)}
/* Toutes les colonnes de métriques (Tour/Temps/Écart/Inter N) centrées : avant,
   seule la 1re (Tour) l'était, ce qui décalait visuellement l'en-tête par
   rapport aux valeurs et laissait la pastille « MEILLEUR » collée à gauche
   de sa colonne plutôt que centrée dans son cadre. */
.pdfx-tbl-head span{text-align:center}
.pdfx-tbl-body{border-radius:8px;margin-top:2px}
.pdfx-tbl-row{display:grid;grid-template-columns:.7fr 1.1fr 1fr 1fr 1fr 1fr;align-items:center;padding:9px 10px;font-size:13px;color:var(--c-text);border-bottom:1px solid var(--c-border)}
.pdfx-tbl-row:nth-child(even){background:var(--c-surface-2)}
.pdfx-tbl-row:last-child{border-bottom:none}
.pdfx-tbl-row .pos{text-align:center;font-family:var(--font-display);font-weight:700;font-style:italic;font-size:16px;color:var(--c-muted)}
.pdfx-tbl-row .time{font-weight:700;text-align:center}
.pdfx-tbl-row .gap{color:var(--c-muted);text-align:center}
.pdfx-tbl-row .sec{color:var(--c-muted);text-align:center}
.pdfx-tbl-wrap.sec-0 .pdfx-tbl-head,.pdfx-tbl-wrap.sec-0 .pdfx-tbl-row{grid-template-columns:.5fr 1fr 1fr}
.pdfx-tbl-wrap.sec-1 .pdfx-tbl-head,.pdfx-tbl-wrap.sec-1 .pdfx-tbl-row{grid-template-columns:.6fr 1.1fr 1fr 1fr}
.pdfx-tbl-wrap.sec-2 .pdfx-tbl-head,.pdfx-tbl-wrap.sec-2 .pdfx-tbl-row{grid-template-columns:.65fr 1.1fr 1fr 1fr 1fr}
.pdfx-tbl-row.best{background:var(--c-accent) !important;position:relative}
.pdfx-tbl-row.best .pos,.pdfx-tbl-row.best .time,.pdfx-tbl-row.best .gap,.pdfx-tbl-row.best .sec{color:var(--pdx-on-accent,#fff)}
.pdfx-best-pill{display:inline-block;font-size:9.5px;font-weight:800;letter-spacing:.05em;white-space:nowrap;background:rgba(255,255,255,.22);padding:3px 8px;border-radius:5px;line-height:1.15}
.pdfx-dark-pill .pdfx-best-pill{background:rgba(0,0,0,.16)}

/* Bandeau allégé des pages 2+ (fiche pilote) */
.pdfx-sheet-header-mini{display:flex;align-items:center;justify-content:space-between;gap:14px;padding:14px 20px;border-bottom:1px solid var(--c-border)}
.pdfx-page.landscape .pdfx-sheet-header-mini{padding:14px 30px}
.pdfx-sheet-header-mini .mini-name{font-family:var(--font-display);font-weight:700;font-style:italic;font-size:18px;text-transform:uppercase;color:var(--c-text);transform:skewX(-6deg)}
.pdfx-sheet-header-mini .mini-tag{font-size:10.5px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--c-muted)}
.pdfx-sheet-header-mini .mini-page{font-size:10.5px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--c-accent)}

/* Ajustements paysage de la fiche pilote : plus de largeur disponible */
.pdfx-page.landscape .pdfx-fp-header{padding:20px 30px;gap:24px}
.pdfx-page.landscape .pdfx-photo-wrap{width:72px;height:72px}
.pdfx-page.landscape .pdfx-photo{width:72px;height:72px;border-radius:14px}
.pdfx-page.landscape .pdfx-photo svg{width:34px;height:34px}
.pdfx-page.landscape .pdfx-kart-badge{width:36px;height:36px}
.pdfx-page.landscape .pdfx-pilot-name{font-size:28px}
.pdfx-page.landscape .pdfx-id-block{min-width:130px}
.pdfx-page.landscape .pdfx-id-meta{gap:16px;row-gap:4px;margin-top:5px}
.pdfx-page.landscape .pdfx-id-meta .item{font-size:12px}
.pdfx-page.landscape .pdfx-summary-card{padding:9px 20px;gap:22px;border-radius:10px}
.pdfx-page.landscape .pdfx-summary-row svg{width:15px;height:15px}
.pdfx-page.landscape .pdfx-summary-row .txt .k{font-size:9px}
.pdfx-page.landscape .pdfx-summary-row .txt .v{font-size:19px}
.pdfx-page.landscape .pdfx-circuit-block{gap:12px;min-width:140px;max-width:340px}
.pdfx-page.landscape .pdfx-circuit-block .pdfx-c-name{font-size:17px}
.pdfx-page.landscape .pdfx-circuit-meta{gap:3px;margin-top:4px}
.pdfx-page.landscape .pdfx-circuit-meta .item{font-size:10.5px;gap:5px}
.pdfx-page.landscape .pdfx-circuit-meta .item svg{width:12px;height:12px}
.pdfx-page.landscape .pdfx-circuit-logo{width:38px;height:38px;border-radius:9px;font-size:16px}
.pdfx-page.landscape .pdfx-tbl-wrap{padding:10px 30px 12px}
.pdfx-page.landscape .pdfx-tbl-row,.pdfx-page.landscape .pdfx-tbl-head{padding-left:14px;padding-right:14px}
.pdfx-page.landscape .pdfx-tbl-row{padding-top:4.5px;padding-bottom:4.5px;font-size:11.5px}
.pdfx-page.landscape .pdfx-tbl-head{padding-bottom:5px}
`;
  document.head.appendChild(style);
  PDF_STYLES_INJECTED = true;
}

/* Écart formaté « à la maquette » : +0.123 sous la minute, +1:02.345 au-delà. */
function fmtPdfDelta(sec) {
  const n = Number(sec);
  if (!Number.isFinite(n)) return '--';
  if (n < 60) return '+' + n.toFixed(3);
  const m = Math.floor(n / 60);
  return '+' + m + ':' + (n % 60).toFixed(3).padStart(6, '0');
}

/* Initiale du circuit pour la pastille logo de la fiche pilote
   (« Circuit de Trinisette » -> « T »). */
function pdfxInitial(name) {
  const cleaned = String(name || '').replace(/^\s*circuit\s+(de\s+la|de\s+l'|des|du|de|d'|le|la|les)?\s*/i, '').trim();
  const src = cleaned || String(name || 'T');
  return (src[0] || 'T').toUpperCase();
}

const PDFX_SVG_CLOCK = '<svg viewBox="0 0 24 24" fill="none" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>';
const PDFX_SVG_CAL = '<svg viewBox="0 0 24 24" fill="none" stroke-width="2"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>';
const PDFX_SVG_TAG = '<svg viewBox="0 0 24 24" fill="none" stroke-width="2"><path d="M20.59 13.41l-7.17 7.17a2 2 0 01-2.83 0L2 12V2h10l8.59 8.59a2 2 0 010 2.82z"/></svg>';

/* ---------- Fragments de markup — classement ---------- */
/* Source d'avatar robuste : en production certaines lignes arrivent avec un
   champ photo invalide (chaîne vide, "null" littérale, URL cassée/404) — le
   <img> restait alors vide et seul le fond circulaire sombre s'affichait
   (cercles noirs constatés en prod sur les pilotes "Unknown"). On valide la
   chaîne ET on pose un onerror qui bascule sur l'avatar kart illustré si le
   chargement échoue réellement (image supprimée du storage, etc.). */
/* Renvoie la photo si c'est une vraie source utilisable, '' sinon. À tester par
   `!!pdfxValidPhoto(photo)` — NE PAS comparer deux genAvatarDataURL() entre eux :
   chaque appel génère un suffixe d'ids unique, donc deux avatars identiques
   produisent des chaînes différentes. */
function pdfxValidPhoto(photo) {
  return pdfxLikeValidSrc(photo);
}
function pdfxPhotoSrc(photo, kart) {
  return pdfxValidPhoto(photo) || genAvatarDataURL(kart);
}
/* Rendu d'un avatar DANS UN PDF.
   /!\ On n'utilise volontairement PAS <img style="object-fit:cover"> :
   html2canvas 1.4.1 n'implemente tout simplement pas `object-fit` (aucune
   occurrence dans son bundle). Il peint donc l'image a sa taille intrinseque
   dans la boite, ce qui la recadre/decale -> "les badges avatar ne rentrent
   pas dans les cercles". En revanche html2canvas gere `background-size` :
   on passe donc par un <div> avec background-size:cover + position:center,
   ce qui donne exactement le recadrage centre attendu, a l'ecran comme au PDF.
   Bonus : on empile la photo AU-DESSUS de l'avatar genere. Si la photo ne se
   charge pas (URL cassee, storage inaccessible, CORS), la couche du dessous
   reste visible -> plus de cercles noirs, sans avoir besoin d'un onerror. */
/* NB : la valeur part dans un attribut style="..." delimite par des guillemets
   doubles -> on cite les URL CSS avec des apostrophes, sinon l'attribut HTML se
   fermerait au premier guillemet de url("...") et le fond disparaitrait. */
function pdfxCssUrl(u) { return `url('${String(u).replace(/['\\]/g, '\\$&')}')`; }
/* Options de la grande vignette de la fiche pilote (voir downloadPilotPDF).
   Partagees entre le prechauffage et le rendu : la cle de cache inclut la forme
   et la taille, les deux appels doivent donc etre strictement identiques. */
const PILOT_SHEET_AV_OPTS = { shape: 'square', size: 1024 };
function pdfxAvatarImg(photo, kart, opts) {
  const real = pdfxValidPhoto(photo);
  const fallback = genAvatarDataURL(kart, opts);
  const layers = real
    ? `${pdfxCssUrl(real)},${pdfxCssUrl(fallback)}`
    : pdfxCssUrl(fallback);
  return `<div class="pdfx-av" style="background-image:${layers}"></div>`;
}

function pdfxPodiumHTML(field) {
  const cls = { 1: 'p1', 2: 'p2', 3: 'p3' };
  const order = [field[1], field[0], field[2]].filter(Boolean);
  return `<div class="pdfx-podium">${order.map(d => `
<div class="pdfx-p-card ${cls[d.pos] || ''}">
<div class="pdfx-p-rank">${d.pos}</div>
<div class="pdfx-p-avatar">${pdfxAvatarImg(d.photo, d.kart, { scheme: d.scheme })}</div>
<div class="pdfx-p-name">${escapeHTML(d.name)}</div>
<div class="pdfx-p-kart">Kart ${d.kart ?? '-'}</div>
<div class="pdfx-p-stats">
<div class="pdfx-p-stat"><span class="k">Meill. tour</span><span class="v best">${d.bestLap != null ? fmtPdfTime(d.bestLap) : '--'}</span></div>
<div class="pdfx-p-stat"><span class="k">Tours</span><span class="v">${d.hasTime ? d.lapsCount : '--'}</span></div>
</div>
</div>`).join('')}</div>`;
}

function pdfxPodiumColHTML(field) {
  const cls = { 1: 'pv1', 2: 'pv2', 3: 'pv3' };
  const order = [field[0], field[1], field[2]].filter(Boolean);
  return `<div class="pdfx-podium-col">
<div class="pdfx-podium-col-title">Podium</div>
${order.map(d => `
<div class="pdfx-pv-card ${cls[d.pos] || ''}">
<div class="pdfx-pv-rank">${d.pos}</div>
<div class="pdfx-pv-avatar">${pdfxAvatarImg(d.photo, d.kart, { scheme: d.scheme })}</div>
<div class="pdfx-pv-info">
<div class="pdfx-pv-name">${escapeHTML(d.name)}</div>
<div class="pdfx-pv-meta"><span>Kart <b>${d.kart ?? '-'}</b></span><span>Tours <b>${d.hasTime ? d.lapsCount : '--'}</b></span><span>Meill. <b>${d.bestLap != null ? fmtPdfTime(d.bestLap) : '--'}</b></span></div>
</div>
</div>`).join('')}
</div>`;
}

function pdfxRankHeadHTML(showSec) {
  const secCols = showSec ? '<span class="num">S1</span><span class="num">S2</span><span class="num">S3</span>' : '';
  return `<div class="pdfx-rank-head${showSec ? ' with-sec' : ''}"><span class="num"></span><span></span><span>Pilote</span><span class="num">Kart</span><span class="num">Tours</span><span class="num">Meill. tour</span><span class="num">Écart</span>${secCols}</div>`;
}

function pdfxBestSec(d, si) {
  let m = Infinity;
  for (const l of (d.lapsArr || [])) { const v = l.sectors && l.sectors[si]; if (Number.isFinite(v)) m = Math.min(m, v); }
  return Number.isFinite(m) ? m : null;
}

function pdfxRankGap(d) {
  if (!d.hasTime) return '--';
  if (d.gap === 0) return fmtPdfTime(d.bestLap);
  return fmtPdfDelta(d.gap);
}

function pdfxRankRowsHTML(chunk, showSec) {
  return chunk.map(d => `
<div class="pdfx-rank-row${d.pos <= 3 ? ' top3' : ''}${showSec ? ' with-sec' : ''}">
<span class="pos">${d.pos}</span>
<span class="av">${pdfxAvatarImg(d.photo, d.kart, { small: true, scheme: d.scheme })}</span>
<span class="name">${escapeHTML(d.name)}</span>
<span class="kart">#${d.kart ?? '-'}</span>
<span class="laps">${d.hasTime ? d.lapsCount : '--'}</span>
<span class="best">${d.bestLap != null ? fmtPdfTime(d.bestLap) : '--'}</span>
<span class="gap">${pdfxRankGap(d)}</span>
${showSec ? [0, 1, 2].map(si => { const v = pdfxBestSec(d, si); return `<span class="sec">${v != null ? v.toFixed(3) : '--'}</span>`; }).join('') : ''}
</div>`).join('');
}

/* ---------- Fragments de markup — fiche pilote ---------- */
function pdfxTblHeadHTML(secCount) {
  const secHead = Array.from({ length: secCount }, (_, n) => `<span class="sec">Inter ${n + 1}</span>`).join('');
  return `<div class="pdfx-tbl-head"><span>Tour</span><span>Temps</span><span>Écart</span>${secHead}</div>`;
}

function pdfxTblRowsHTML(laps, bestLap, sectorsPresent) {
  return laps.map(l => {
    const isBest = bestLap != null && l.time === bestLap;
    const delta = bestLap != null ? l.time - bestLap : null;
    const secCells = sectorsPresent.map(i => `<span class="sec">${Number.isFinite(l.sectors && l.sectors[i]) ? l.sectors[i].toFixed(3) : '--'}</span>`).join('');
    const gapCell = isBest ? '<span class="pdfx-best-pill">MEILLEUR</span>' : (delta == null ? '--' : fmtPdfDelta(delta));
    return `<div class="pdfx-tbl-row${isBest ? ' best' : ''}">
<span class="pos">${l.idx}</span>
<span class="time">${fmtPdfTime(l.time)}</span>
<span class="gap">${gapCell}</span>
${secCells}
</div>`;
  }).join('');
}

/* html2canvas ne dessine pas les « … » de text-overflow : il coupe le texte en
   plein glyphe (« NATHAN PETIT » devenait « NATHAN PETI »). On réduit donc la
   taille de police des libellés à risque jusqu'à ce qu'ils tiennent vraiment.
   Appelé pendant que la page est encore dans le DOM, donc mesurable. */
// 🆕 v17.1 : le bloc circuit (nom du circuit + date + libellé de session) de la
// fiche pilote coupait le texte au caractère près sans « … » — cause identique
// (html2canvas ignore text-overflow), corrigée en ajoutant ces éléments à la
// liste déjà utilisée pour le nom du pilote.
// 31/07 : l'en-tete des PDF (nom du circuit + libelle de session, bande du
// classement complet ET bloc circuit de la fiche pilote) n'etait PAS dans cette
// liste — d'ou le texte "un peu mange" signale en prod. Toutes les zones de
// texte a largeur contrainte y sont desormais, en-tete et pied de page inclus.
const PDFX_FIT_SEL = [
  '.pdfx-pilot-name', '.pdfx-p-name', '.pdfx-pv-name', '.pdfx-rank-row .name',
  '.pdfx-sheet-header-mini .mini-name', '.pdfx-rank-header-mini .mini-name',
  '.pdfx-c-name', '.pdfx-circuit-meta .item span',
  '.pdfx-summary-row .txt .k', '.pdfx-summary-row .txt .v',
  '.pdfx-head-left .pdfx-circuit-name', '.pdfx-head-left .pdfx-session-lbl',
  '.pdfx-head-right .pdfx-date', '.pdfx-head-right .pdfx-count',
  '.pdfx-sheet-footer span', '.pdfx-id-meta .item',
  '.pdfx-sheet-header-mini .mini-tag', '.pdfx-rank-header-mini .mini-tag',
].join(',');
function pdfxFitTexts(page) {
  page.querySelectorAll(PDFX_FIT_SEL).forEach(el => {
    const start = parseFloat(getComputedStyle(el).fontSize);
    if (!Number.isFinite(start) || start <= 0) return;
    const floor = Math.max(7, start * 0.6);
    let size = start;
    let guard = 40;
    while (guard-- > 0 && size > floor && el.scrollWidth > el.clientWidth + 0.5) {
      size -= 0.5;
      el.style.fontSize = size + 'px';
    }
    // Si même à la taille plancher le nom déborde encore (noms à rallonge),
    // on tronque le texte avec un vrai caractère « … » : html2canvas dessine
    // celui-là, contrairement à l'ellipse CSS.
    if (el.scrollWidth > el.clientWidth + 0.5) {
      const full = el.textContent;
      let cut = full.length;
      let g2 = 200;
      while (g2-- > 0 && cut > 1 && el.scrollWidth > el.clientWidth + 0.5) {
        cut -= 1;
        el.textContent = full.slice(0, cut).replace(/[\s\-]+$/, '') + '\u2026';
      }
    }
  });
}

/* Mesure hors écran : on ajoute les lignes une par une jusqu'à ce que la
   feuille dépasse la hauteur utile d'une page A4, puis on bascule. */
function pdfxMeasureFill(page, bodySel, sheetSel, budgetPx, remaining, rowsHTML, emptyHTML) {
  page.style.position = 'fixed';
  page.style.left = '-99999px';
  page.style.top = '0';
  document.body.appendChild(page);
  const sheet = page.querySelector(sheetSel);
  const body = page.querySelector(bodySel);
  let placed = 0;
  if (!remaining.length && emptyHTML) body.innerHTML = emptyHTML;
  while (remaining.length) {
    body.insertAdjacentHTML('beforeend', rowsHTML([remaining[0]]));
    if (sheet.getBoundingClientRect().height > budgetPx && placed > 0) { body.lastElementChild.remove(); break; }
    placed++; remaining.shift();
  }
  pdfxFitTexts(page);
  document.body.removeChild(page);
  // IMPORTANT : retirer le positionnement de mesure, sinon html2canvas
  // capture une page vide (position:fixed sort du flux du conteneur).
  page.style.position = '';
  page.style.left = '';
  page.style.top = '';
  return placed;
}

/* Pose la capture sur la page PDF, à l'échelle 1:1 (595px = 210mm). */
function pdfxPlace(pdf, canvas, g, isFirst, t, quality) {
  if (!isFirst) pdf.addPage(g.landscape ? [g.pageW, g.pageH] : undefined, g.landscape ? 'l' : 'p');
  pdfRGB(pdf, t.bg, 'setFillColor');
  pdf.rect(0, 0, g.pageW, g.pageH, 'F');
  const imgH = canvas.height * g.pageW / canvas.width;
  const scale = imgH > g.pageH ? g.pageH / imgH : 1;
  const dw = g.pageW * scale, dh = imgH * scale;
  // JPEG plutôt que PNG : le fond est opaque (pas de transparence à préserver) et
  // le PNG produisait des fichiers de ~12 Mo par page — impossibles à partager.
  // À qualité 0.94 et scale 2.5, le texte reste net pour ~1/10e du poids.
  pdf.addImage(canvas.toDataURL('image/jpeg', quality || 0.94), 'JPEG', (g.pageW - dw) / 2, 0, dw, dh);
}

/* ==================================================================
   PDF CLASSEMENT COMPLET
   ================================================================== */
export async function downloadFullPDF(btn) {
  const original = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = `${SPIN_ICON} Génération…`;
  try {
    const pdf = await buildFullPDF();
    pdf.save(`classement_karting_${PDF_ORIENT === 'landscape' ? 'paysage' : 'portrait'}.pdf`);
  } catch (e) {
    alert('Erreur PDF : ' + e.message);
  }
  btn.disabled = false;
  btn.innerHTML = original;
}

/* 🆕 v28 : meme extraction que buildPilotPDF. Le classement joint a l'e-mail
   passe desormais par CE moteur (mise en page soignee, podium, avatars) et non
   plus par le rendu admin de secours. */
export async function buildFullPDF() {
  {
    ensurePdfStyles();
    /* Pack Signature : html2canvas ne sait pas attendre. On préchauffe donc les
       data URLs (grand format podium + petit format lignes) AVANT de construire
       le markup, sinon le PDF retombe sur l'avatar classique. */
    if (signatureAvatarsActive()) {
      // { kart, scheme } et non de simples numéros de kart : certains inscrits
      // ont choisi leur avatar_scheme explicitement (nouveau parcours), et le
      // cache de préchauffage doit être clé sur ce couple, pas sur le seul kart.
      const karts = (allResults || []).map(d => ({ kart: d.kart, scheme: d.scheme }));
      await prewarmSignatureAvatarDataURLs(karts);
      await prewarmSignatureAvatarDataURLs(karts, { small: true });
    }
    const { jsPDF } = window.jspdf;
    const g = pdfxGeom(PDF_ORIENT);
    const pdf = new jsPDF(g.landscape ? 'l' : 'p', 'mm', 'a4');
    const t = themeColors();
    const showSec = sectorsEnabled();
    const results = allResults;
    const title = escapeHTML(circuitNamePdfHead());
    const footName = escapeHTML(circuitNamePdfFoot());
    const label = escapeHTML((sessionInfo && sessionInfo.title) || 'Classement');
    const date = escapeHTML(fmtSessionDate(sessionInfo && sessionInfo.session_date));
    const dateShort = escapeHTML(sessionInfo && sessionInfo.session_date
      ? new Date(sessionInfo.session_date + 'T12:00:00').toLocaleDateString('fr-FR')
      : '--');

    const headLogo = PDF_LOGO_URL
      ? `<img class="pdfx-head-logo" src="${PDF_LOGO_URL}" alt="Logo du circuit" crossorigin="anonymous">`
      : '';
    const headBand = `
<div class="pdfx-head-band">
${headLogo}
<div class="pdfx-head-left">
<div class="pdfx-circuit-name">${title}</div>
<div class="pdfx-session-lbl">Classement complet — ${label}</div>
</div>
<div class="pdfx-head-right">
<div class="pdfx-date">${dateShort}</div>
<div class="pdfx-count">${results.length} pilotes</div>
</div>
</div>`;
    const footer = `<div class="pdfx-sheet-footer"><span>${footName}</span><span><b>${date}</b></span></div>`;

    const remaining = results.slice();
    const pages = [];
    let pageIndex = 0;
    while ((remaining.length || pageIndex === 0) && pageIndex < 60) {
      const isFirst = pageIndex === 0;
      const headMini = `<div class="pdfx-rank-header-mini"><span class="mini-name">${title}</span><span class="mini-tag">Suite du classement</span><span class="mini-page" data-pdfx-pageno></span></div>`;
      const page = document.createElement('div');
      page.className = pdxPageClass(g.landscape);
      const rankWrap = `<div class="pdfx-rank-wrap">${isFirst ? '<div class="pdfx-rank-title">Classement complet</div>' : ''}${pdfxRankHeadHTML(showSec)}<div class="pdfx-rank-body"></div></div>`;
      const bodyInner = (g.landscape && isFirst) ? pdfxPodiumColHTML(results.slice(0, 3)) + rankWrap : rankWrap;
      page.innerHTML = `<div class="pdfx-sheet">${isFirst ? headBand + (!g.landscape ? pdfxPodiumHTML(results.slice(0, 3)) : '') : headMini}<div class="pdfx-body-wrap">${bodyInner}</div>${footer}</div>`;
      pdfxMeasureFill(page, '.pdfx-rank-body', '.pdfx-sheet', g.budgetPx, remaining,
        chunk => pdfxRankRowsHTML(chunk, showSec),
        `<div style="padding:16px;text-align:center;color:${t.muted}">Aucun résultat.</div>`);
      pages.push(page);
      pageIndex++;
      if (pageIndex === 1 && !remaining.length) break;
    }
    // Numérotation « Page x / total » sur les bandeaux allégés
    pages.forEach((p, i) => {
      const el = p.querySelector('[data-pdfx-pageno]');
      if (el) el.textContent = `Page ${i + 1} / ${pages.length}`;
    });

    for (let i = 0; i < pages.length; i++) {
      const canvas = await sectionToCanvas(pages[i], g.renderW, t.bg);
      pdfxPlace(pdf, canvas, g, i === 0, t);
    }
    return pdf;
  }
}

/* ==================================================================
   🆕 PALMARÈS (Point 8b) — nombre de podiums (toutes sessions publiées) +
   3 dernières positions, injectés dans la fiche PDF pilote publique.

   Implémentation suggérée par le prompt v13 : on récupère, comme
   showPilotHistory() côté admin, toutes les session_registrations
   correspondant au nom (comparaison insensible à la casse), jointure
   sessions pour la date, puis pour CHAQUE session on recalcule le
   classement complet (même logique que loadRanking() côté admin — ici
   réimplémentée localement puisque public-results.js n'importe pas
   sessions.js) pour trouver la position exacte du pilote.

   ⚠️ Restreint aux sessions PUBLIÉES du même tenant que la session
   affichée (public_results_token non nul + même tenant_id que
   sessionInfo) : ce sont les seules lignes qu'un visiteur anonyme peut
   légitimement lire côté RLS, et le prompt v13 demande explicitement de
   ne compter que "les sessions publiées".

   ⚠️ Point d'attention perf signalé par le prompt v13 : un pilote très
   actif fait recalculer le classement complet de CHAQUE session au clic
   sur le bouton PDF (spinner déjà prévu par downloadPilotPDF). À tester
   avec un historique réel avant mise en prod.
   ================================================================== */
async function computeSessionRanking(sessionId) {
  // 🆕 v28 : memoisation. Le point d'attention perf ci-dessus n'etait pas
  // theorique : generer les fiches de TOUTE la grille (20 pilotes) fait
  // recalculer les memes sessions d'historique 20 fois. Le cache est vide a
  // chaque load(), donc jamais perime entre deux sessions affichees.
  if (rankingCache.has(sessionId)) return rankingCache.get(sessionId);
  const p = computeSessionRankingUncached(sessionId);
  rankingCache.set(sessionId, p);
  return p;
}

async function computeSessionRankingUncached(sessionId) {
  const { data: pack } = await db.rpc('public_session_ranking', {
    _results_token: resultsToken,
    _session_id: sessionId,
  });
  const laps = pack && pack.laps;
  const regs = pack && pack.registrations;
  if (!laps || !regs) return [];
  const totals = new Map();
  laps.forEach((l) => totals.set(l.registration_id, (totals.get(l.registration_id) || 0) + Number(l.lap_time_seconds || 0)));
  const ranking = [];
  regs.forEach((r) => {
    const t = totals.get(r.id);
    if (t != null) ranking.push({ regId: r.id, name: r.display_name || '--', t });
  });
  ranking.sort((a, b) => a.t - b.t);
  return ranking;
}

export async function getPilotPalmares(name, tenantId) {
  const cleanName = (name || '').trim();
  if (!cleanName) return { podiums: 0, lastPositions: [] };
  const ck = cleanName.toLowerCase();
  if (palmaresCache.has(ck)) return palmaresCache.get(ck);
  const p = getPilotPalmaresUncached(cleanName);
  palmaresCache.set(ck, p);
  return p;
}

async function getPilotPalmaresUncached(cleanName) {
  try {
    // Le tenant est deduit du jeton cote SQL : plus besoin de filtrer ici.
    const { data: allRegs, error } = await db.rpc('public_pilot_sessions', {
      _results_token: resultsToken,
      _display_name: cleanName,
    });
    if (error || !allRegs || !allRegs.length) return { podiums: 0, lastPositions: [] };

    const bySession = new Map();
    allRegs.forEach((r) => {
      bySession.set(r.session_id, { date: r.session_date, regName: r.display_name });
    });

    let podiums = 0;
    const positioned = [];
    for (const [sessionId, info] of bySession.entries()) {
      const ranking = await computeSessionRanking(sessionId);
      const idx = ranking.findIndex((row) => row.name.toLowerCase().trim() === cleanName.toLowerCase());
      if (idx < 0) continue;
      const pos = idx + 1;
      if (pos <= 3) podiums++;
      positioned.push({ pos, date: info.date || '' });
    }
    positioned.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    const lastPositions = positioned.slice(0, 3);
    return { podiums, lastPositions };
  } catch (e) {
    return { podiums: 0, lastPositions: [] };
  }
}

function palmaresHTML(palmares) {
  if (!palmares || (!palmares.podiums && !palmares.lastPositions.length)) return '';
  const posTxt = palmares.lastPositions.length
    ? palmares.lastPositions.map((p) => 'P' + p.pos).join(' · ')
    : '--';
  const posTitle = palmares.lastPositions.length
    ? palmares.lastPositions.map((p) => (p.date ? fmtSessionDate(p.date) : '')).join(' · ')
    : '';
  return `
<div class="pdfx-summary-row">
${PDFX_SVG_TAG}
<div class="txt"><span class="k">Podiums (total)</span><span class="v">${palmares.podiums}</span></div>
</div>
<div class="pdfx-summary-row">
${PDFX_SVG_CLOCK}
<div class="txt" title="${escapeHTML(posTitle)}"><span class="k">3 dern. positions</span><span class="v" style="font-size:12px">${posTxt}</span></div>
</div>`;
}

/* ==================================================================
   PDF FICHE PILOTE
   ================================================================== */
export async function downloadPilotPDF(pilot, btn) {
  btn.classList.add('loading');
  btn.innerHTML = SPIN_ICON;
  try {
    const pdf = await buildPilotPDF(pilot);
    pdf.save(`Fiche_Pilote_${pilot.name.replace(/[^a-z0-9]/gi, '_')}.pdf`);
  } catch (e) {
    alert('Erreur PDF : ' + e.message);
  }
  btn.classList.remove('loading');
  btn.innerHTML = PDF_ICON;
}

/* 🆕 v28 : le rendu est extrait du gestionnaire de clic pour pouvoir etre
   reutilise sans DOM d'appui — l'admin appelle buildPilotPDF() a travers une
   iframe cachee au moment de la publication, recupere les octets et les
   televerse comme piece jointe. La fiche recue par e-mail est donc rigoureusement
   celle que le pilote peut telecharger lui-meme : un seul moteur de rendu, pas
   deux implementations a maintenir en phase. */
export async function buildPilotPDF(pilot) {
  {
    ensurePdfStyles();
    if (signatureAvatarsActive()) {
      await prewarmSignatureAvatarDataURLs([{ kart: pilot.kart, scheme: pilot.scheme }], PILOT_SHEET_AV_OPTS);
      await prewarmSignatureAvatarDataURLs([{ kart: pilot.kart, scheme: pilot.scheme }]);
    }
    const { jsPDF } = window.jspdf;
    const g = pdfxGeom(PDF_ORIENT);
    const pdf = new jsPDF(g.landscape ? 'l' : 'p', 'mm', 'a4');
    const t = themeColors();
    const showSec = sectorsEnabled();
    const sectorsPresent = showSec ? [0, 1, 2].filter(i => pilot.lapsArr.some(l => l.sectors && Number.isFinite(l.sectors[i]))) : [];
    const circuitTxt = escapeHTML(circuitNamePdfHead());
    const circuitFoot = escapeHTML(circuitNamePdfFoot());
    const sessionTxt = escapeHTML((sessionInfo && sessionInfo.title) || 'Session');
    const dateTxt = escapeHTML(fmtSessionDate(sessionInfo && sessionInfo.session_date));
    const dateShort = escapeHTML(sessionInfo && sessionInfo.session_date
      ? new Date(sessionInfo.session_date + 'T12:00:00').toLocaleDateString('fr-FR')
      : '--');
    /* Dernier endroit qui utilisait encore `pilot.photo ? ... : ...` brut : même
       défaut que les cercles noirs vus en prod (une photo "null"/cassée donnait un
       <img> vide), et en plus une silhouette grise générique au lieu de l'avatar
       illustré utilisé partout ailleurs. On passe donc par pdfxAvatarImg().
       Le petit badge kart n'est affiché que s'il y a une vraie photo : sans photo,
       la grande vignette EST déjà l'avatar et porte le numéro, le badge ferait
       doublon. */
    const hasRealPhoto = !!pdfxValidPhoto(pilot.photo);
    // 🆕 Palmarès (Point 8b) : récupéré juste avant la construction du markup,
    // sous le spinner déjà affiché par le bouton PDF (voir ensurePdfStyles() plus
    // haut dans cette fonction / btn.innerHTML = SPIN_ICON en tête de fonction).
    const palmares = await getPilotPalmares(pilot.name, sessionInfo && sessionInfo.tenant_id);
    /* Pack Signature : la vignette de la fiche pilote reprend exactement les
       réglages du podium (même type, même fond, même contour) mais en pastille
       CARRÉE, pour occuper tout le cadre arrondi de l'en-tête. */
    const photoInner = pdfxAvatarImg(pilot.photo, pilot.kart, { ...PILOT_SHEET_AV_OPTS, scheme: pilot.scheme });
    const kartBadge = hasRealPhoto
      ? `<div class="pdfx-kart-badge"><div class="pdfx-av" style="background-image:${pdfxCssUrl(genAvatarDataURL(pilot.kart, { scheme: pilot.scheme }))}"></div></div>`
      : '';

    const headHTML = `
<div class="pdfx-fp-header">
<div class="pdfx-photo-wrap">
<div class="pdfx-photo">${photoInner}</div>
${kartBadge}
</div>
<div class="pdfx-id-block">
<div class="pdfx-pilot-name">${escapeHTML(pilot.name)}</div>
<div class="pdfx-id-meta">
<div class="item">Pos <b>${pilot.pos}</b></div>
<div class="item">Kart <b>${pilot.kart ?? '-'}</b></div>
<div class="item">Tours <b>${pilot.lapsCount}</b></div>
</div>
</div>
<div class="pdfx-summary-card">
<div class="pdfx-summary-row best">
${PDFX_SVG_CLOCK}
<div class="txt"><span class="k">Meilleur tour</span><span class="v">${pilot.bestLap != null ? fmtPdfTime(pilot.bestLap) : '--'}</span></div>
</div>
${palmaresHTML(palmares)}
</div>
<div class="pdfx-circuit-block">
<div class="pdfx-circuit-text">
<div class="pdfx-c-name">${circuitTxt}</div>
<div class="pdfx-circuit-meta">
<div class="item">${PDFX_SVG_CAL}<span>${dateShort}</span></div>
<div class="item">${PDFX_SVG_TAG}<span>${sessionTxt}</span></div>
</div>
</div>
<div class="pdfx-circuit-logo">${PDF_LOGO_URL
      ? `<img src="${PDF_LOGO_URL}" alt="Logo" crossorigin="anonymous" style="width:100%;height:100%;object-fit:contain;border-radius:inherit;background:var(--c-surface)">`
      : pdfxInitial(circuitNamePdfHead())}</div>
</div>
</div>`;
    const footer = `<div class="pdfx-sheet-footer"><span>${circuitFoot}</span><span><b>${dateTxt}</b></span></div>`;

    const remaining = pilot.lapsArr.slice();
    const pages = [];
    let pageIndex = 0;
    while ((remaining.length || pageIndex === 0) && pageIndex < 60) {
      const isFirst = pageIndex === 0;
      const headMini = `<div class="pdfx-sheet-header-mini"><span class="mini-name">${escapeHTML(pilot.name)} — Kart ${pilot.kart ?? '-'}</span><span class="mini-tag">Suite du tableau des tours</span><span class="mini-page" data-pdfx-pageno></span></div>`;
      const page = document.createElement('div');
      page.className = pdxPageClass(g.landscape);
      const tblWrap = `<div class="pdfx-tbl-wrap sec-${sectorsPresent.length}">${pdfxTblHeadHTML(sectorsPresent.length)}<div class="pdfx-tbl-body"></div></div>`;
      page.innerHTML = `<div class="pdfx-sheet"><div class="pdfx-topbar"></div>${isFirst ? headHTML : headMini}${tblWrap}${footer}</div>`;
      pdfxMeasureFill(page, '.pdfx-tbl-body', '.pdfx-sheet', g.budgetPx, remaining,
        chunk => pdfxTblRowsHTML(chunk, pilot.bestLap, sectorsPresent),
        `<div style="padding:16px;text-align:center;color:${t.muted}">Aucun tour enregistré.</div>`);
      pages.push(page);
      pageIndex++;
      if (pageIndex === 1 && !remaining.length) break;
    }
    pages.forEach((p, i) => {
      const el = p.querySelector('[data-pdfx-pageno]');
      if (el) el.textContent = `Page ${i + 1} / ${pages.length}`;
    });

    for (let i = 0; i < pages.length; i++) {
      /* Fiche pilote : 1-2 pages seulement, on peut se permettre un rendu
         beaucoup plus fin (x4 au lieu de x2.5) et une compression JPEG quasi
         sans perte — c'est ce qui rendait l'avatar flou, pas la source SVG. */
      const canvas = await sectionToCanvas(pages[i], g.renderW, t.bg, 4);
      pdfxPlace(pdf, canvas, g, i === 0, t, 0.97);
    }
    return pdf;
  }
}

/* ==================================================================
   Sélecteur de format Portrait / Paysage, injecté à côté du bouton
   « PDF complet » — s'applique aux deux PDF (classement + fiche).
   ================================================================== */
function initPdfOrientControl(btn) {
  if (!btn || !btn.parentElement || document.getElementById('pdfx-orient')) return;
  syncPdfOnAccentInk();
  const wrap = document.createElement('div');
  wrap.id = 'pdfx-orient';
  wrap.setAttribute('role', 'group');
  wrap.setAttribute('aria-label', 'Format des PDF');
  wrap.style.cssText = 'display:inline-flex;align-items:center;gap:4px;margin-left:10px;padding:4px;border:1px solid var(--c-border);border-radius:10px;background:var(--c-surface-2);vertical-align:middle;font-family:var(--font-body)';
  const opts = [['portrait', 'Portrait'], ['landscape', 'Paysage']];
  const buttons = opts.map(([value, lbl]) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = lbl;
    b.dataset.pdfxOrient = value;
    b.style.cssText = 'font-family:inherit;font-weight:700;letter-spacing:.04em;text-transform:uppercase;font-size:11px;padding:5px 12px;border:none;border-radius:7px;cursor:pointer;background:transparent;color:var(--c-muted)';
    b.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); PDF_ORIENT = value; sync(); });
    wrap.appendChild(b);
    return b;
  });
  function sync() {
    buttons.forEach(b => {
      const on = b.dataset.pdfxOrient === PDF_ORIENT;
      b.style.background = on ? 'var(--c-accent)' : 'transparent';
      b.style.color = on ? 'var(--pdx-on-accent, #fff)' : 'var(--c-muted)';
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
  }
  sync();
  btn.insertAdjacentElement('afterend', wrap);
}

export function initPdfFullButton() {
  const btn = document.getElementById('btn-pdf-full');
  if (!btn) return;
  btn.addEventListener('click', (e) => downloadFullPDF(e.currentTarget));
  initPdfOrientControl(btn);
}

/* ==================================================================
   🆕 v28 — PASSERELLE D'EXPORT (« tous les PDF en piece jointe »)

   Consommee par results-app.js, qui l'expose sur window.__kartingExport
   uniquement quand l'URL porte ?export=1. L'admin ouvre alors
   results.html?result=<jeton>&export=1 dans une iframe CACHEE et de MEME
   ORIGINE, attend la fin du chargement, puis demande un PDF a la fois.

   Pourquoi une iframe plutot qu'un portage du moteur cote admin :
   - le rendu depend d'une quinzaine de variables de module (theme, logo,
     avatars Signature prechauffes, secteurs actifs, orientation) qu'il
     faudrait toutes dupliquer, donc maintenir en double ;
   - la piece jointe est ainsi OCTET POUR OCTET le fichier que le pilote
     obtiendrait en cliquant lui-meme. Aucune divergence possible.

   On renvoie des ArrayBuffer et non des Blob : un Blob cree dans le realm de
   l'iframe devient inutilisable des que celle-ci est retiree du DOM. L'appelant
   reconstruit le Blob chez lui.
   ================================================================== */
export function listExportPilots() {
  return (allResults || [])
    .filter((r) => r.regId)
    .map((r) => ({ regId: r.regId, name: r.name, kart: r.kart, pos: r.pos, hasTime: r.hasTime }));
}

export function setPdfOrient(v) {
  if (v === 'portrait' || v === 'landscape') PDF_ORIENT = v;
}

export async function pilotPDFBytes(regId) {
  const pilot = (allResults || []).find((r) => r.regId === regId);
  if (!pilot) throw new Error('Pilote introuvable dans cette session : ' + regId);
  const pdf = await buildPilotPDF(pilot);
  return pdf.output('arraybuffer');
}

export async function fullPDFBytes() {
  const pdf = await buildFullPDF();
  return pdf.output('arraybuffer');
}

/* ==================================================================
   🆕 P0-6 — CARTES PARTAGEABLES (position / record), rendues en PNG.

   Meme pont, meme iframe cachee, memes contraintes que les PDF ci-dessus :
   vraies dimensions (1080x1920, jamais display:none), un seul moteur de
   rendu (celui-ci), un ArrayBuffer traverse la frontiere d'iframe (jamais
   un Blob, invalide des que l'iframe est retiree du DOM).

   Le QR est genere localement par qr.js (mode octet, niveau M) : c'est un
   vrai code QR scannable, pas une image decorative. Il pointe vers l'URL
   PUBLIQUE de la session de resultats (results.html?result=<jeton>) —
   il n'existe pas d'ancre par-pilote sur cette page, donc le QR mene au
   classement complet dans lequel le pilote peut se retrouver.

   Regle produit : c'est TOUJOURS pilot.name (le pseudo, display_name) qui
   est imprime sur la carte, jamais un nom civil — comme partout ailleurs
   sur cette page publique.
   ================================================================== */
const CARD_W = 1080;
const CARD_H = 1920;

/* ==================================================================
   CARTES PARTAGEABLES — SOCLE DU GABARIT UNIQUE
   Un seul habillage (fond + tete + pied) est construit ici et reutilise
   par les 15 concepts : seul le BLOC CENTRAL change d'un concept a
   l'autre, exactement comme les PDF de classement qui partagent un
   en-tete et un pied de page communs. Toutes les couleurs viennent des
   jetons de theme (--c-*), donc le meme gabarit se decline sur les 8
   themes sans code specifique.
   Geometrie reprise des visuels de reference (702x1248) remise a
   l'echelle de la carte finale (1080x1920, facteur 1.5385).
   ================================================================== */

// Trois roles typographiques distincts, conformes aux visuels de reference.
// Le moteur nommait auparavant 'UI' et 'Mono' : deux familles qui n'existent
// nulle part, donc TOUT retombait en sans-serif systeme — d'ou la typo plate
// des cartes livrees.
//  - CARD_UI   : titres et pseudos (grotesque large)
//  - CARD_MONO : libelles, adresse, accroche, ligne meta (chasse fixe)
//  - CARD_NUM  : chronos et positions (Teko, deja chargee par results.html)
const CARD_UI = "system-ui,-apple-system,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif";
const CARD_MONO = "ui-monospace,SFMono-Regular,'SF Mono',Menlo,Consolas,'DejaVu Sans Mono',monospace";
const CARD_NUM = "'Teko','Barlow Condensed','Arial Narrow',sans-serif";

// Chrono de carte : fmtCardTime() force le prefixe minutes ("00:47.014"), ce qui
// est juste dans un tableau de classement mais faux sur une carte ou le chrono
// est le sujet. Sous la minute on affiche donc "47.014".
function fmtCardTime(sec) {
  const n = Number(sec);
  if (!Number.isFinite(n) || n < 0) return '--';
  if (n < 60) return n.toFixed(3);
  return `${Math.floor(n / 60)}:${(n % 60).toFixed(3).padStart(6, '0')}`;
}

// Resout une couleur CSS (hex, rgb(), jeton deja calcule) en rgba(...) avec
// l'alpha demande : les jetons de theme sont tantot hexadecimaux, tantot
// rgba(), on ne peut donc pas concatener un suffixe hexadecimal a l'aveugle.
function cardRGBA(cssColor, alpha) {
  const el = document.createElement('div');
  el.style.color = '#000';
  el.style.color = cssColor;
  document.body.appendChild(el);
  const rgb = getComputedStyle(el).color;
  document.body.removeChild(el);
  const m = (rgb.match(/[\d.]+/g) || ['255', '255', '255']).map(Number);
  return `rgba(${m[0] | 0},${m[1] | 0},${m[2] | 0},${alpha})`;
}

// Fond de carte : degrade vertical + halo chaud central + halo bas + stries
// diagonales + vignette. Rendu en SVG puis pose en <img> plutot qu'en
// empilement de degrades CSS : html2canvas ne sait pas composer plusieurs
// couches de gradients (les cartes sortaient sans aucun fond), alors qu'il
// rasterise une image SVG data-URI exactement comme le navigateur.
// FONDS PAR CONCEPT — chaque visuel du catalogue a SON propre fond.
// Erreur corrigee le 31/07 : un fond unique (les rayures diagonales de
// 01-track-hero) etait applique aux 15 concepts. Les rayures n'appartiennent
// qu'aux concepts "track". Le reste de la structure (halo des coins, degrade
// chaud du bas) est bien commun a tous les visuels de reference.
// La couleur vient toujours du theme : accent + surfaces, rien n'est code en dur.

function cardBGLayers(t, cid) {
  // Fonds par concept, cales sur les JPG de reference (pack pro-signature).
  // Verification pixel du 31/07 : la majorite des visuels ont un fond NEUTRE,
  // toute la structure visible (regles or, damier, tuiles, calendrier, bloc
  // accent, filigrane du numero de kart) appartient au CORPS de la carte et
  // est deja rendue par POSITION_BODIES / RECORD_BODIES. Les motifs de fond
  // ajoutes le 31/07 pour 03, 04, 06, 08, 09, 10, 12r et 13r etaient des
  // inventions : ils sont supprimes. Seuls les fonds reellement presents sur
  // les references sont conserves.
  const a = (o) => cardRGBA(t.accent, o);
  const L = [];
  const push = (s) => L.push(s);

  // rayures diagonales (01-track-hero, 01r-track-record)
  const stripes = (step, w1, w2, o1, o2) => {
    const out = [];
    for (let y = -900; y < 2900; y += step) {
      out.push(`<rect x="-700" y="${y}" width="2500" height="${w1}" fill="${a(o1)}"/>`);
      out.push(`<rect x="-700" y="${y + Math.round(step / 3)}" width="2500" height="${w2}" fill="${a(o2)}"/>`);
    }
    return `<g transform="rotate(-15.5 540 960)">${out.join('')}</g>`;
  };
  // anneaux concentriques (02-avatar-central, 02r-avatar-record)
  const rings = (cx, cy, r0, r1, step, op) => {
    const out = [];
    for (let r = r0; r <= r1; r += step) {
      out.push(`<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${a(op)}" stroke-width="2"/>`);
    }
    return out.join('');
  };
  // grille fine (05-telemetrie)
  const grid = (cell, op) => {
    const out = [];
    for (let x = 0; x <= 1080; x += cell) out.push(`<rect x="${x}" y="0" width="1" height="1920" fill="${a(op)}"/>`);
    for (let y = 0; y <= 1920; y += cell) out.push(`<rect x="0" y="${y}" width="1080" height="1" fill="${a(op)}"/>`);
    return out.join('');
  };
  // damier a fondu progressif (07-damier-dissous) : html2canvas n'applique pas
  // les <mask> SVG dans une data-URI, l'opacite est donc rampee ligne a ligne.
  const checkerFade = (cell, y0, rows, opFn) => {
    const out = []; const cols = Math.ceil(1080 / cell);
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      if ((r + c) % 2 !== 0) continue;
      out.push(`<rect x="${c * cell}" y="${y0 + r * cell}" width="${cell}" height="${cell}" fill="${cardRGBA(t.text, opFn(r, rows))}"/>`);
    }
    return out.join('');
  };

  switch (cid) {
    case '01-track-hero':
      push(stripes(275, 14, 9, 0.16, 0.12));
      break;
    case '02-avatar-central':
      push(rings(540, 830, 140, 980, 78, 0.05));
      push(`<radialGradient id="av" cx="0.5" cy="0.43" r="0.34"><stop offset="0" stop-color="${a(0.10)}"/><stop offset="1" stop-color="${a(0)}"/></radialGradient>`);
      push(`<rect width="1080" height="1920" fill="url(#av)"/>`);
      break;
    case '05-telemetrie':
      push(grid(68, 0.045));
      break;
    case '07-damier-dissous':
      push(checkerFade(68, 340, 19, (r, n) => 0.004 + 0.055 * Math.pow(Math.sin(Math.PI * (r / (n - 1))), 3)));
      break;
    case '01r-track-record':
      push(stripes(210, 12, 7, 0.20, 0.14));
      break;
    case '02r-avatar-record':
      push(rings(540, 830, 150, 1000, 66, 0.06));
      push(`<radialGradient id="avr" cx="0.5" cy="0.43" r="0.36"><stop offset="0" stop-color="${a(0.13)}"/><stop offset="1" stop-color="${a(0)}"/></radialGradient>`);
      push(`<rect width="1080" height="1920" fill="url(#avr)"/>`);
      break;
    case '11r-record-piste':
      // bande centrale legerement plus claire, encadree par deux filets or
      push(`<rect x="0" y="646" width="1080" height="616" fill="${a(0.035)}"/>`);
      push(`<rect x="0" y="646" width="1080" height="2" fill="${a(0.45)}"/>`);
      push(`<rect x="0" y="1260" width="1080" height="2" fill="${a(0.45)}"/>`);
      break;
    case '04-split-diagonal': {
      // Reference : filet or du bord gauche (y 1538) au bord droit (y 677),
      // et damier FIN remplissant le triangle inferieur droit.
      const cell = 30, out = [];
      const yAt = (x) => 1538 + (677 - 1538) * (x / 1080);
      for (let y = 0; y < 1920; y += cell) {
        for (let x = 0; x < 1080; x += cell) {
          if (((x / cell) + (y / cell)) % 2 !== 0) continue;
          if (y + cell < yAt(x + cell)) continue;
          out.push(`<rect x="${x}" y="${y}" width="${cell}" height="${cell}" fill="${cardRGBA(t.text, 0.05)}"/>`);
        }
      }
      push(out.join(''));
      push(`<polygon points="0,1538 1080,677 1080,681 0,1542" fill="${a(0.55)}"/>`);
      break;
    }
    // 03, 06, 08, 09, 10, 12r, 13r : fond neutre (references pixel 31/07).
    default:
      break;
  }
  return L.join('');
}

function cardBackgroundDataURI(t, cid) {
  const a = (o) => cardRGBA(t.accent, o);
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1920" viewBox="0 0 1080 1920">` +
    `<defs>` +
    `<linearGradient id="warm" x1="0" y1="0" x2="0" y2="1">` +
    `<stop offset="0.58" stop-color="${a(0)}"/>` +
    `<stop offset="0.8" stop-color="${a(0.04)}"/>` +
    `<stop offset="1" stop-color="${a(0.12)}"/>` +
    `</linearGradient>` +
    `<radialGradient id="gtl" cx="0" cy="0" r="0.42">` +
    `<stop offset="0" stop-color="${a(0.07)}"/><stop offset="1" stop-color="${a(0)}"/>` +
    `</radialGradient>` +
    `<radialGradient id="gtr" cx="1" cy="0.03" r="0.42">` +
    `<stop offset="0" stop-color="rgba(90,120,255,0.05)"/><stop offset="1" stop-color="rgba(90,120,255,0)"/>` +
    `</radialGradient>` +
    `<radialGradient id="gc" cx="0.5" cy="0.44" r="0.28">` +
    `<stop offset="0" stop-color="${a(0.05)}"/><stop offset="1" stop-color="${a(0)}"/>` +
    `</radialGradient>` +
    `</defs>` +
    `<rect width="1080" height="1920" fill="${t.bg}"/>` +
    cardBGLayers(t, cid) +
    `<rect width="1080" height="1920" fill="url(#gtl)"/>` +
    `<rect width="1080" height="1920" fill="url(#gtr)"/>` +
    `<rect width="1080" height="1920" fill="url(#gc)"/>` +
    `<rect width="1080" height="1920" fill="url(#warm)"/>` +
    `</svg>`;
  return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
}
function cardBackgroundHTML(t, cid) {
  return `<img src="${cardBackgroundDataURI(t, cid)}" alt="" style="position:absolute;left:0;top:0;width:1080px;height:1920px;display:block">`;
}

// Drapeau de nationalite dessine en SVG : les emoji drapeaux ne sont pas
// rasterises de la meme facon d'une machine a l'autre — et pas du tout sous
// Chrome/Linux, ou l'on obtient les deux lettres du pays dans un cadre.
const CARD_FLAGS = {
  FR: '<rect width="1" height="2" fill="#002654"/><rect x="1" width="1" height="2" fill="#fff"/><rect x="2" width="1" height="2" fill="#ce1126"/>',
  BE: '<rect width="1" height="2" fill="#111"/><rect x="1" width="1" height="2" fill="#fae042"/><rect x="2" width="1" height="2" fill="#ed2939"/>',
  IT: '<rect width="1" height="2" fill="#008c45"/><rect x="1" width="1" height="2" fill="#f4f5f0"/><rect x="2" width="1" height="2" fill="#cd212a"/>',
  LU: '<rect width="3" height="0.667" fill="#ed2939"/><rect y="0.667" width="3" height="0.666" fill="#fff"/><rect y="1.333" width="3" height="0.667" fill="#00a1de"/>',
  DE: '<rect width="3" height="0.667" fill="#111"/><rect y="0.667" width="3" height="0.666" fill="#dd0000"/><rect y="1.333" width="3" height="0.667" fill="#ffce00"/>',
  NL: '<rect width="3" height="0.667" fill="#ae1c28"/><rect y="0.667" width="3" height="0.666" fill="#fff"/><rect y="1.333" width="3" height="0.667" fill="#21468b"/>',
  ES: '<rect width="3" height="2" fill="#aa151b"/><rect y="0.5" width="3" height="1" fill="#f1bf00"/>',
  CH: '<rect width="3" height="2" fill="#d52b1e"/><rect x="1.3" y="0.45" width="0.4" height="1.1" fill="#fff"/><rect x="0.85" y="0.8" width="1.3" height="0.4" fill="#fff"/>',
  GB: '<rect width="3" height="2" fill="#012169"/><path d="M0 0L3 2M3 0L0 2" stroke="#fff" stroke-width="0.4"/><path d="M0 0L3 2M3 0L0 2" stroke="#c8102e" stroke-width="0.22"/><path d="M1.5 0V2M0 1H3" stroke="#fff" stroke-width="0.66"/><path d="M1.5 0V2M0 1H3" stroke="#c8102e" stroke-width="0.4"/>',
  US: '<rect width="3" height="2" fill="#fff"/><g fill="#b22234"><rect width="3" height="0.154"/><rect y="0.308" width="3" height="0.154"/><rect y="0.615" width="3" height="0.154"/><rect y="0.923" width="3" height="0.154"/><rect y="1.231" width="3" height="0.154"/><rect y="1.538" width="3" height="0.154"/><rect y="1.846" width="3" height="0.154"/></g><rect width="1.2" height="1.077" fill="#3c3b6e"/>',
  OTHER: '<rect width="3" height="2" fill="#fff"/><g fill="#111"><rect width="0.75" height="0.5"/><rect x="1.5" width="0.75" height="0.5"/><rect x="0.75" y="0.5" width="0.75" height="0.5"/><rect x="2.25" y="0.5" width="0.75" height="0.5"/><rect y="1" width="0.75" height="0.5"/><rect x="1.5" y="1" width="0.75" height="0.5"/><rect x="0.75" y="1.5" width="0.75" height="0.5"/><rect x="2.25" y="1.5" width="0.75" height="0.5"/></g>',
};

function cardFlagHTML(nat, w) {
  const body = CARD_FLAGS[nat] || CARD_FLAGS.OTHER;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 3 2" width="3" height="2">${body}</svg>`;
  const uri = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  const width = w || 68;
  return `<img src="${uri}" alt="" style="width:${width}px;height:${Math.round(width * 2 / 3)}px;display:block;border-radius:3px">`;
}

function cardResultsURL() {
  const u = new URL('/results', window.location.origin);
  if (resultsToken) u.searchParams.set('result', resultsToken);
  return u.toString();
}

function cardQRHTML(url, size) {
    const s = size || 180;
    let svg = '';
    try { svg = qrSVG(url); } catch (e) { svg = ''; }
    if (!svg) return '';
    return `<div style="width:${s}px;height:${s}px;background:#fff;border-radius:16px;padding:${Math.round(s * 0.08)}px;` +
          `display:flex;align-items:center;justify-content:center">${svg}</div>`;
}

// =====================================================================
// CARTES PARTAGEABLES — MOTEUR CONFORME AUX 15 CONCEPTS ENREGISTRES
//
// Correctif du 30/07 : positionCardPNGBytes/recordCardPNGBytes dessinaient un
// visuel générique, identique quels que soient les visuels cochés dans
// Paramètres > Cartes partageables — les 240 concepts (voir assets/cards/) et
// les choix de l'organisateur (card_position_picks / card_record_picks)
// n'étaient jamais lus. Reconstruit ici à partir des visuels de référence
// (mêmes zones : logo+nom+accroche+QR en tête, contenu en zone sûre
// SAFE_TOP=250/SAFE_BOT=1540, pilote+kart+tours+session+date en pied), sans
// disposer du fichier source du designer (gen3.js, hors de ce dépôt) — donc
// fidèle dans la structure et les données, approximatif au pixel près.
// =====================================================================

function pad2(n) { return String(n).padStart(2, '0'); }
const MONTH_FR = ['Janvier', 'Février', 'Mars', 'Avril', 'Mai', 'Juin', 'Juillet', 'Août', 'Septembre', 'Octobre', 'Novembre', 'Décembre'];
const DOW_FR = ['Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam', 'Dim'];

function parseRecordDate(d) {
    const dt = d ? new Date(String(d).slice(0, 10) + 'T00:00:00') : new Date();
    return Number.isNaN(dt.getTime()) ? new Date() : dt;
}

// Lundi de la semaine ISO contenant `dt`, et ses 6 jours suivants.
function isoWeekDays(dt) {
    const dow = (dt.getDay() + 6) % 7; // 0=lundi..6=dimanche
  const monday = new Date(dt); monday.setDate(dt.getDate() - dow);
    return Array.from({ length: 7 }, (_, i) => { const d = new Date(monday); d.setDate(monday.getDate() + i); return d; });
}

/* --- TETE DE CARTE ---------------------------------------------------
   Logo, nom du circuit, adresse, filet, accroche, QR. Strictement
   identique sur les 15 concepts. */
function cardHeaderHTML(t) {
  const circuit = escapeHTML(circuitName());
  const tagline = escapeHTML(CARD_TAGLINE || '');
  const address = escapeHTML(CARD_ADDRESS || '');
  const logo = PDF_LOGO_URL
    ? `<img src="${PDF_LOGO_URL}" crossorigin="anonymous" style="width:100%;height:100%;object-fit:contain;border-radius:50%;background:${t.surface}">`
    : `<div style="width:100%;height:100%;border-radius:50%;border:2px solid ${t.accent};display:flex;align-items:center;justify-content:center;font:700 30px ${CARD_UI};line-height:1;color:${t.accent}">${escapeHTML((circuit || 'K').charAt(0))}</div>`;
  return `
    <div style="position:absolute;left:74px;top:322px;width:72px;height:72px">${logo}</div>
    <div style="position:absolute;left:178px;top:312px;right:270px">
      <div style="font:700 40px ${CARD_UI};line-height:1.5;letter-spacing:.045em;text-transform:uppercase;color:${t.text};overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${circuit}</div>
      ${address ? `<div style="font:400 20px ${CARD_MONO};line-height:1.5;letter-spacing:.02em;color:${t.muted};overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${address}</div>` : ''}
    </div>
    <div style="position:absolute;right:72px;top:278px">${cardQRHTML(CARD_QR_URL || cardResultsURL(), 160)}</div>
    <div style="position:absolute;left:74px;width:712px;top:448px;height:1px;background:${t.border}"></div>
    ${tagline ? `<div style="position:absolute;left:74px;right:74px;top:466px;font:400 20px ${CARD_MONO};line-height:1.6;letter-spacing:.02em;color:${t.muted};overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${tagline}</div>` : ''}`;
}


/* --- PIED DE CARTE ---------------------------------------------------
   Filet, avatar en cercle (l'ancien cadre de 64px recevait un SVG force a
   200px : l'avatar sortait entierement du cadre et n'apparaissait pas),
   drapeau de nationalite, PSEUDO, ligne meta. Strictement identique sur
   les 15 concepts. */
function cardFooterHTML(t, pilot) {
  const laps = pilot.hasTime ? String(pilot.lapsCount) + ' tours' : '';
  const type = escapeHTML((sessionInfo && sessionInfo.session_type) || '');
  const date = escapeHTML(fmtSessionDate(sessionInfo && sessionInfo.session_date));
  const meta = ['Kart ' + (pilot.kart ?? '-'), laps, type, date].filter(Boolean).join(' &middot; ');
  return `
    <div style="position:absolute;left:74px;right:74px;top:1402px;height:1px;background:${t.border}"></div>
    <div style="position:absolute;left:74px;top:1436px;width:104px;height:104px;border-radius:50%;overflow:hidden;background:${t.surface};border:2px solid ${cardRGBA(t.accent, .55)};box-sizing:border-box">${cardAvatarHTML(pilot, CARD_AV_FOOTER)}</div>
    <div style="position:absolute;left:206px;top:1440px;right:74px;height:62px;display:flex;align-items:center">
      <div style="flex:0 0 auto;margin-right:24px">${cardFlagHTML(pilot.nat, 66)}</div>
      <div style="flex:1 1 auto;min-width:0;font:700 42px ${CARD_UI};line-height:62px;letter-spacing:.01em;text-transform:uppercase;color:${t.text};overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHTML(pilot.name)}</div>
    </div>
    <div style="position:absolute;left:206px;top:1506px;right:74px;font:400 21px ${CARD_MONO};line-height:1.6;letter-spacing:.03em;color:${t.muted};text-transform:uppercase;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${meta}</div>`;
}


/* Zone centrale : la SEULE partie qui change d'un concept a l'autre.
   Centree sur le milieu exact de la carte (y=960), comme les visuels de
   reference — l'ancienne boite top:250/bottom:400 recentrait le contenu
   trop haut et laissait un vide enorme sous le bloc. */
function cardBodyWrap(inner) {
  return `<div style="position:absolute;left:74px;right:74px;top:540px;bottom:540px;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;overflow:hidden">${inner}</div>`;
}


// --- Variante de carte : pro-signature / standard-classic -------------------
// Les gabarits existent en deux variantes : standard-classic (avatars kart ou
// pilote du plan standard) et pro-signature (pack Signature, plan Pro). Le
// moteur de cartes ne consultait pas du tout le pack : toutes les cartes
// sortaient en standard-classic, meme pour un circuit Pro. On retablit ici la
// symetrie qui existe deja entre genAvatarDataURL() (qui a une branche
// Signature) et genAvatarSVG() (qui n'en a pas). html2canvas rasterise sans
// attendre le reseau : on lit donc le cache synchrone prechauffe par
// prewarmCardAvatars(), et on retombe silencieusement sur l'avatar classique
// quand le cache est froid ou le pack indisponible.
// 03/08 (client) : avatar footer des cartes partageables rendu comme un
// fragment zoome/coupe (visor d'un casque au lieu du casque entier) sur les
// images recues par mail. Cause confirmee par reproduction locale : html2canvas
// 1.4.1 rasterise l'<img src="data:image/svg+xml..."> a sa taille INTRINSEQUE
// (l'attribut width/height du SVG genere, ici 200) puis semble ne pas
// redimensionner correctement vers une boite CSS plus petite (104px, cf.
// cardFooterHTML) pour une source SVG — object-fit:cover et width/height:100%
// ne suffisent pas a compenser. Le SVG genere n'etant qu'un carre de couleurs
// vectorielles (aucune perte de nettete a le generer directement a la bonne
// taille), la correction retenue est d'aligner size EXACTEMENT sur la boite
// CSS reelle de chaque emplacement plutot que de compter sur un redimensionnement
// navigateur pendant la capture — HERO 320px (cardBodyHTML '02-avatar-central'),
// RECORD 300px ('02r-avatar-record'), FOOTER 104px (cardFooterHTML). Le rendu a
// l'ecran (HTML normal, hors html2canvas) n'est pas concerne par ce bug.
const CARD_AV_FOOTER = { shape: 'circle', size: 104 };
const CARD_AV_HERO = { shape: 'circle', size: 320 };
const CARD_AV_RECORD = { shape: 'circle', size: 300 };

function cardAvatarHTML(pilot, base) {
  const kart = pilot ? pilot.kart : null;
  const o = Object.assign({}, base, { scheme: pilot ? pilot.scheme : null });
  if (signatureAvatarsActive()) {
    const src = signatureAvatarDataURLSync(kart, o);
    if (src) return '<img src="' + src + '" alt="" style="width:100%;height:100%;object-fit:cover;display:block">';
  }
  return genAvatarSVG(kart, Object.assign({}, o, { size: null }));
}

// A appeler et await AVANT renderCardPNG() : le cache Signature est asynchrone,
// la rasterisation ne l'est pas.
async function prewarmCardAvatars(pilot) {
  if (!signatureAvatarsActive() || !pilot) return;
  const items = [{ kart: pilot.kart, scheme: pilot.scheme }];
  try {
    await prewarmSignatureAvatarDataURLs(items, CARD_AV_FOOTER);
    await prewarmSignatureAvatarDataURLs(items, CARD_AV_HERO);
    await prewarmSignatureAvatarDataURLs(items, CARD_AV_RECORD);
  } catch (e) { /* pack indisponible : repli standard-classic */ }
}

function cardShell(t, bodyInner, pilot, cid) {
    return cardBackgroundHTML(t, cid) + cardHeaderHTML(t) + cardBodyWrap(bodyInner) + cardFooterHTML(t, pilot);
}

// --- Concepts POSITION -----------------------------------------------------
// Les 10 visuels du catalogue (voir settings.js CARD_CATALOG.position et les
// vignettes de reference assets/cards/<concept>__<theme>.jpg). Chaque corps
// n'utilise que les jetons de theme (t.*) : le meme concept se decline donc
// automatiquement sur les 8 themes, exactement comme les vignettes.

function cardRule(t, m) { return `<div style="width:100%;height:1px;background:${t.border};margin:${m || 26}px 0"></div>`; }
function cardCheckerBG(t, op) {
  // html2canvas 1.4.1 ignore repeating-conic-gradient : le damier etait donc
  // simplement INVISIBLE sur les cartes exportees (constate en prod le 31/07
  // sur 04-split-diagonal). On passe par une tuile SVG en data-URI, que
  // html2canvas sait bien rasteriser.
  const tile = `<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80" viewBox="0 0 80 80">` +
    `<rect x="0" y="0" width="40" height="40" fill="${t.text}"/>` +
    `<rect x="40" y="40" width="40" height="40" fill="${t.text}"/></svg>`;
  return `background-image:url("data:image/svg+xml;charset=utf-8,${encodeURIComponent(tile)}");background-size:80px 80px;background-repeat:repeat;opacity:${op || .10}`;
}

const POSITION_BODIES = {
  '01-track-hero': (t, pilot, ctx) => `
    <div style="font:400 21px ${CARD_MONO};letter-spacing:.32em;color:${t.muted}">POSITION FINALE</div>
    <div style="font:700 320px ${CARD_NUM};line-height:.82;color:${t.accent};margin-top:20px">P${ctx.pos}</div>
    <div style="font:700 152px ${CARD_NUM};line-height:.9;color:${t.text};margin-top:10px">${ctx.time}<span style="font-size:.3em;color:${t.muted}">s</span></div>
    <div style="font:400 20px ${CARD_MONO};letter-spacing:.28em;color:${t.muted};margin-top:24px">MEILLEUR TOUR</div>`,

  '02-avatar-central': (t, pilot, ctx) => `
    <div style="width:320px;height:320px;border-radius:50%;background:radial-gradient(circle, ${t.surface2} 0%, ${t.bg} 72%);border:2px solid ${t.accent};box-shadow:0 0 60px ${t.accent}44;display:flex;align-items:center;justify-content:center;overflow:hidden">${cardAvatarHTML(pilot, CARD_AV_HERO)}</div>
    <div style="font:700 190px ${CARD_NUM};line-height:.85;color:${t.accent};margin-top:34px">P${ctx.pos}</div>
    <div style="font:700 76px ${CARD_NUM};color:${t.text};margin-top:10px">${ctx.time}<span style="font-size:.4em;color:${t.muted}">s</span></div>`,

  '03-chrono-editorial': (t, pilot, ctx) => `
    <div style="width:100%;display:flex;align-items:baseline;gap:16px">
      <span style="font:700 120px ${CARD_NUM};color:${t.accent}">P${ctx.pos}</span>
      <span style="font:400 22px ${CARD_MONO};color:${t.muted};letter-spacing:.05em">/ ${ctx.totalPilots} PILOTES</span>
    </div>
    ${cardRule(t, 28)}
    <div style="width:100%;text-align:left;font:700 140px ${CARD_NUM};color:${t.text}">${ctx.time}</div>
    <div style="width:100%;text-align:left;font:400 20px ${CARD_MONO};letter-spacing:.24em;color:${t.muted};margin-top:10px">SECONDES &middot; MEILLEUR TOUR</div>
    ${cardRule(t, 28)}
    <div style="display:flex;justify-content:space-between;width:100%;font:700 17px ${CARD_MONO};letter-spacing:.05em;color:${t.muted};text-transform:uppercase">
      <span>Session ${escapeHTML(ctx.sessionType)}</span><span>${ctx.laps} tours</span><span>${escapeHTML(ctx.dateTxt)}</span>
    </div>`,

  // Grand P majuscule en haut a gauche, diagonale accent, triangle damier en
  // bas a droite, chrono cale sur le bas du triangle.
  '04-split-diagonal': (t, pilot, ctx) => `
    <div style="position:relative;width:100%;height:100%">
      <div style="position:absolute;left:0;top:40px;font:400 20px ${CARD_MONO};letter-spacing:.3em;color:${t.muted}">POSITION</div>
      <div style="position:absolute;left:0;top:78px;font:700 220px ${CARD_NUM};line-height:.85;color:${t.accent}">P${ctx.pos}</div>
      <div style="position:absolute;right:0;bottom:196px;text-align:right;font:400 18px ${CARD_MONO};letter-spacing:.22em;color:${t.muted}">MEILLEUR TOUR &middot; ${ctx.laps} TOURS</div>
      <div style="position:absolute;right:0;bottom:52px;text-align:right;font:700 96px ${CARD_NUM};color:${t.text}">${ctx.time}<span style="font-size:.36em;color:${t.muted}">s</span></div>
    </div>`,

  // Deux colonnes : chrono a gauche, releve des tours reels a droite, le
  // meilleur tour en accent.
  '05-telemetrie': (t, pilot, ctx) => {
    const laps = (pilot.lapsArr || []).slice(0, 20);
    const rows = laps.map((l) => {
      const best = pilot.bestLap != null && Math.abs(l.time - pilot.bestLap) < 1e-6;
      return `<div style="display:flex;justify-content:space-between;font:400 17px ${CARD_MONO};letter-spacing:.04em;color:${best ? t.accent : t.muted};line-height:1.85">` +
        `<span>${pad2(l.idx)}</span><span>${fmtCardTime(l.time)}</span></div>`;
    }).join('') || `<div style="font:400 17px ${CARD_MONO};color:${t.muted}">--</div>`;
    return `
      <div style="width:100%;display:flex;gap:44px;align-items:flex-start;text-align:left">
        <div style="flex:1 1 auto;min-width:0">
          <div style="font:400 19px ${CARD_MONO};letter-spacing:.26em;color:${t.muted}">MEILLEUR TOUR</div>
          <div style="font:700 132px ${CARD_NUM};color:${t.text};line-height:1;margin-top:12px">${ctx.time}</div>
          <div style="font:400 18px ${CARD_MONO};letter-spacing:.26em;color:${t.muted};margin-top:10px">SECONDES</div>
          <div style="margin-top:54px;display:flex;align-items:baseline;gap:14px">
            <span style="font:700 84px ${CARD_NUM};color:${t.accent}">P${ctx.pos}</span>
            <span style="font:400 20px ${CARD_MONO};color:${t.muted}">/ ${ctx.totalPilots}</span>
          </div>
        </div>
        <div style="flex:0 0 320px;border-left:1px solid ${t.border};padding-left:32px">
          <div style="font:400 15px ${CARD_MONO};letter-spacing:.2em;color:${t.muted};margin-bottom:14px">TEMPS AU TOUR</div>
          ${rows}
        </div>
      </div>`;
  },

  '06-bloc-massif': (t, pilot, ctx) => `
    <div style="width:100%;display:flex;align-items:center;gap:34px;text-align:left">
      <div style="background:${t.accent};color:${t.bg};font:700 140px ${CARD_NUM};padding:18px 36px;line-height:1">P${ctx.pos}</div>
      <div>
        <div style="font:400 18px ${CARD_MONO};letter-spacing:.2em;color:${t.muted}">MEILLEUR TOUR</div>
        <div style="font:700 84px ${CARD_NUM};color:${t.text}">${ctx.time}<span style="font-size:.35em;color:${t.muted}">s</span></div>
        <div style="margin-top:24px;font:700 17px ${CARD_MONO};letter-spacing:.1em;color:${t.muted};text-transform:uppercase;line-height:1.9">
          ${ctx.laps} tours<br>session ${escapeHTML(ctx.sessionType)}<br>${ctx.totalPilots} pilotes
        </div>
      </div>
    </div>`,

  '07-damier-dissous': (t, pilot, ctx) => `
    <div style="position:relative;width:100%;display:flex;flex-direction:column;align-items:center">
      <div style="font:700 20px ${CARD_MONO};letter-spacing:.3em;color:${t.muted};position:relative">MEILLEUR TOUR</div>
      <div style="font:800 220px ${CARD_NUM};color:${t.text};line-height:.85;margin-top:14px;position:relative">${ctx.time}</div>
      <div style="font:400 22px ${CARD_MONO};letter-spacing:.3em;color:${t.muted};margin-top:16px;position:relative">SECONDES</div>
    </div>`,

  // Ligne d'arrivee : le chrono, une regle graduee dont le segment accent
  // s'arrete sur la position, et la pastille P<n>.
  '08-ligne-arrivee': (t, pilot, ctx) => {
    const n = Math.max(ctx.totalPilots, 1);
    const ticks = Array.from({ length: n }, () =>
      `<div style="flex:1 1 0;height:18px;border-left:1px solid ${t.border}"></div>`).join('');
    const ratio = Math.max(0, Math.min(1, (n - ctx.pos + 1) / n));
    return `
      <div style="width:100%;text-align:left">
        <div style="font:400 19px ${CARD_MONO};letter-spacing:.24em;color:${t.muted}">MEILLEUR TOUR &mdash; SESSION ${escapeHTML(String(ctx.sessionType).toUpperCase())}</div>
        <div style="font:700 150px ${CARD_NUM};color:${t.text};line-height:1;margin-top:14px">${ctx.time}<span style="font-size:.28em;color:${t.muted}">s</span></div>
        <div style="position:relative;margin-top:30px;height:56px">
          <div style="position:absolute;left:0;right:0;top:0;height:2px;background:${t.border}"></div>
          <div style="position:absolute;left:0;top:0;height:2px;width:${(ratio * 100).toFixed(1)}%;background:${t.accent}"></div>
          <div style="position:absolute;left:0;right:0;top:2px;display:flex">${ticks}</div>
          <div style="position:absolute;right:0;top:-14px;background:${t.accent};color:${t.bg};font:700 30px ${CARD_UI};padding:6px 16px">P${ctx.pos}</div>
        </div>
        <div style="margin-top:26px;font:400 17px ${CARD_MONO};letter-spacing:.12em;color:${t.muted};text-transform:uppercase">${ctx.laps} tours enregistr&eacute;s &middot; ${ctx.totalPilots} pilotes en piste</div>
      </div>`;
  },

  // Fiche de course : grille cle / valeur, comme un releve officiel.
  '09-grille-indice': (t, pilot, ctx) => {
    const row = (k, v, accent) => `
      <div style="display:flex;justify-content:space-between;align-items:baseline;padding:22px 0;border-bottom:1px solid ${t.border}">
        <span style="font:400 17px ${CARD_MONO};letter-spacing:.18em;color:${t.muted};text-transform:uppercase">${k}</span>
        <span style="font:700 ${accent ? '52px' : '30px'} ${CARD_NUM};color:${accent ? t.accent : t.text}">${v}</span>
      </div>`;
    return `
      <div style="width:100%;text-align:left">
        <div style="font:400 18px ${CARD_MONO};letter-spacing:.28em;color:${t.muted}">FICHE DE COURSE</div>
        <div style="height:2px;background:${t.accent};margin:16px 0 6px"></div>
        ${row('Position', 'P' + ctx.pos, true)}
        ${row('Meilleur tour', ctx.time + ' s')}
        ${row('&Eacute;cart au pr&eacute;c&eacute;dent', ctx.gapPrev)}
        ${row('Tours', ctx.laps)}
        ${row('Session', escapeHTML(String(ctx.sessionType).toUpperCase()))}
        ${row('Plateau', ctx.totalPilots + ' pilotes')}
      </div>`;
  },

  // Filigrane : le numero de kart en tres grand, en fond, et le resultat par
  // dessus.
  '10-filigrane': (t, pilot, ctx) => `
    <div style="position:relative;width:100%;display:flex;flex-direction:column;align-items:center;justify-content:center">
      <div style="position:absolute;left:0;right:0;top:50%;transform:translateY(-50%);font:800 420px ${CARD_NUM};line-height:.8;color:${t.text};opacity:.06;text-align:center">${pilot.kart != null ? pilot.kart : '--'}</div>
      <div style="position:relative;font:400 18px ${CARD_MONO};letter-spacing:.24em;color:${t.muted};text-transform:uppercase">Kart ${pilot.kart != null ? pilot.kart : '-'} &middot; ${escapeHTML(pilot.name)}</div>
      <div style="position:relative;font:700 210px ${CARD_NUM};line-height:.9;color:${t.accent};margin-top:18px">P${ctx.pos}</div>
      <div style="position:relative;font:700 82px ${CARD_NUM};color:${t.text};margin-top:6px">${ctx.time}<span style="font-size:.36em;color:${t.muted}">s</span></div>
      <div style="position:relative;font:400 18px ${CARD_MONO};letter-spacing:.28em;color:${t.muted};margin-top:20px">MEILLEUR TOUR</div>
    </div>`,
};

const POSITION_FALLBACK = '01-track-hero';

function pickPositionConcept() {
  const picks = (CARD_POSITION_PICKS || []).filter((id) => POSITION_BODIES[id]);
  if (!picks.length) return POSITION_FALLBACK;
  return picks[Math.floor(Math.random() * picks.length)];
}

function positionCtx(pilot) {
  const list = allResults || [];
  const prev = list.find((r) => r.pos === pilot.pos - 1);
  let gapPrev = '--';
  if (pilot.hasTime && prev && prev.hasTime && pilot.bestLap != null && prev.bestLap != null)
    gapPrev = '&minus; ' + fmtCardTime(pilot.bestLap - prev.bestLap) + ' s';
  else if (pilot.pos === 1) gapPrev = 'Leader';
  return {
    pos: pilot.pos,
    time: pilot.bestLap != null ? fmtCardTime(pilot.bestLap) : '--',
    laps: pilot.hasTime ? pilot.lapsCount : '--',
    totalPilots: list.length,
    sessionType: (sessionInfo && sessionInfo.session_type) || '--',
    dateTxt: fmtSessionDate(sessionInfo && sessionInfo.session_date),
    gapPrev,
  };
}

/** Carte de position — un pilote, son classement, un QR vers le classement en ligne. */
export async function positionCardPNGBytes(regId, conceptId) {
  const pilot = (allResults || []).find((r) => r.regId === regId);
  if (!pilot) throw new Error('Pilote introuvable dans cette session : ' + regId);
  const t = themeColors();
  const id = (conceptId && POSITION_BODIES[conceptId]) ? conceptId : pickPositionConcept();
  const build = POSITION_BODIES[id] || POSITION_BODIES[POSITION_FALLBACK];
  await prewarmCardAvatars(pilot);
  return renderCardPNG(cardShell(t, build(t, pilot, positionCtx(pilot)), pilot, id));
}

// --- Concepts RECORD --------------------------------------------------------
// Cinq visuels, indexes par IDENTIFIANT DE CONCEPT (et non par portee) : c'est
// ce que stocke card_record_picks cote Parametres
// ({ perso: '01r-track-record', piste: '11r-record-piste', ... }). L'ancien
// moteur indexait par portee et ignorait donc silencieusement le choix de
// l'organisateur — c'est corrige ici.

const RECORD_SCOPE_LABELS = {
  perso: 'RECORD PERSONNEL', piste: 'RECORD DE LA PISTE',
  semaine: 'RECORD DE LA SEMAINE', mois: 'RECORD DU MOIS',
};
const RECORD_PILL_LABELS = {
  perso: 'NOUVEAU RECORD PERSO', piste: 'MEILLEUR TEMPS ABSOLU',
  semaine: 'MEILLEUR TEMPS DE LA SEMAINE', mois: 'MEILLEUR TEMPS DU MOIS',
};
// Visuel par defaut de chaque portee si card_record_picks n'a rien (ou un id
// inconnu) : c'est le meme mapping que le catalogue de settings.js.
const RECORD_DEFAULT_BY_SCOPE = {
  perso: '01r-track-record', piste: '11r-record-piste',
  semaine: '12r-record-semaine', mois: '13r-record-mois',
};

// Pastille de delta. Sans text-transform : "-0.831s" devenait "-0.831S".
function recordPill(t, text) {
  return `<div style="margin-top:64px;display:inline-block;padding:15px 36px;border-radius:999px;border:1px solid ${t.accent};font:500 22px ${CARD_MONO};letter-spacing:.08em;color:${t.accent}">${text}</div>`;
}

// Damier dessine en SVG : html2canvas ignore repeating-conic-gradient, les
// drapeaux disparaissaient purement et simplement du rendu.
function checkeredGlyph(t, size) {
  const s = size || 48;
  const cells = [];
  for (let y = 0; y < 3; y++) for (let x = 0; x < 4; x++) if ((x + y) % 2 === 0) cells.push(`<rect x="${x}" y="${y}" width="1" height="1"/>`);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 5 5.6" width="5" height="5.6">` +
    `<rect x="0" y="0" width="0.32" height="5.6" fill="${t.muted}"/>` +
    `<g fill="${t.accent}" transform="translate(0.42 0.3)">${cells.join('')}</g></svg>`;
  return `<img src="data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}" alt="" style="width:${s}px;height:${Math.round(s * 1.12)}px;display:block;flex:0 0 auto">`;
}
// Titre de record encadre de deux damiers, comme sur les visuels de reference.
function recordTitle(t, label) {
  return `<div style="display:flex;align-items:center;gap:30px;font:400 21px ${CARD_MONO};letter-spacing:.3em;color:${t.muted}">` +
    checkeredGlyph(t, 42) + `<span>${label}</span>` + checkeredGlyph(t, 42) + `</div>`;
}
// Ancien temps barre -> nouveau temps, commun aux deux visuels de record perso.
// La barre est un div positionne : html2canvas place text-decoration:line-through
// tres au-dessus des chiffres avec une police condensee (un trait flottait seul
// au-dessus de "AVANT").
function recordDelta(t, ctx, bigSize) {
  const big = bigSize || 130;
  return (ctx.prevTime
    ? `<div style="display:flex;align-items:flex-end;gap:64px;margin-top:52px">
         <div style="display:flex;flex-direction:column;align-items:center">
           <div style="font:400 20px ${CARD_MONO};letter-spacing:.28em;color:${t.muted};margin-bottom:14px">AVANT</div>
           <div style="position:relative;font:700 ${Math.round(big * 0.82)}px ${CARD_NUM};line-height:.8;color:${t.muted}">${ctx.prevTime}<span style="font-size:.36em">s</span></div>
         </div>
         <div style="font:400 44px ${CARD_MONO};color:${t.muted};padding-bottom:16px">&rarr;</div>
         <div style="display:flex;flex-direction:column;align-items:center">
           <div style="font:400 20px ${CARD_MONO};letter-spacing:.28em;color:${t.muted};margin-bottom:14px">AUJOURD'HUI</div>
           <div style="font:700 ${big}px ${CARD_NUM};line-height:.8;color:${t.accent}">${ctx.newTime}<span style="font-size:.34em;color:${t.muted}">s</span></div>
         </div>
       </div>`
    : `<div style="font:700 ${big}px ${CARD_NUM};line-height:.8;color:${t.accent};margin-top:44px">${ctx.newTime}<span style="font-size:.34em;color:${t.muted}">s</span></div>`);
}


const RECORD_BODIES = {
  // Record personnel, mise en page « track hero » (chrono seul, centre).
  '01r-track-record': (t, pilot, ctx) => `
    ${recordTitle(t, ctx.label)}
    ${recordDelta(t, ctx, 100)}
    ${ctx.deltaTxt ? recordPill(t, ctx.deltaTxt + ' &middot; ' + RECORD_PILL_LABELS.perso) : recordPill(t, RECORD_PILL_LABELS.perso)}`,

  // Record personnel, mise en page « avatar central » (meme contenu, avatar
  // en medaillon au-dessus).
  '02r-avatar-record': (t, pilot, ctx) => `
    <div style="width:300px;height:300px;border-radius:50%;background:radial-gradient(circle, ${t.surface2} 0%, ${t.bg} 72%);border:2px solid ${t.accent};box-shadow:0 0 60px ${t.accent}44;display:flex;align-items:center;justify-content:center;overflow:hidden;margin-bottom:34px">${cardAvatarHTML(pilot, CARD_AV_RECORD)}</div>
    ${recordTitle(t, ctx.label)}
    ${recordDelta(t, ctx, 92)}
    ${ctx.deltaTxt ? recordPill(t, ctx.deltaTxt + ' &middot; ' + RECORD_PILL_LABELS.perso) : recordPill(t, RECORD_PILL_LABELS.perso)}`,

  // Record de la piste : cartouche encadre, drapeau a damier, ancien record.
  '11r-record-piste': (t, pilot, ctx) => `
    <div style="width:100%;border:1px solid ${t.accent};background:${t.accent}14;padding:54px 40px;display:flex;flex-direction:column;align-items:center">
      ${checkeredGlyph(t, 64)}
      <div style="font:400 20px ${CARD_MONO};letter-spacing:.3em;color:${t.accent};margin-top:22px">${ctx.label}</div>
      <div style="font:700 140px ${CARD_NUM};color:${t.accent};line-height:1;margin-top:16px">${ctx.newTime}<span style="font-size:.28em;color:${t.muted}">s</span></div>
      ${ctx.prevTime ? `<div style="margin-top:16px;font:400 18px ${CARD_MONO};letter-spacing:.06em;color:${t.muted}">ANCIEN RECORD ${ctx.prevTime}s${ctx.deltaTxt ? ' &middot; ' + ctx.deltaTxt : ''}</div>` : ''}
      ${recordPill(t, RECORD_PILL_LABELS.piste)}
    </div>`,

  // Record de la semaine : bandeau des 7 jours, le jour du record en accent.
  '12r-record-semaine': (t, pilot, ctx) => {
    const days = isoWeekDays(ctx.recordDate);
    const dow = (ctx.recordDate.getDay() + 6) % 7;
    const grid = days.map((d, i) => `
      <div style="display:flex;flex-direction:column;align-items:center;gap:8px">
        <div style="font:400 13px ${CARD_MONO};letter-spacing:.05em;color:${t.muted}">${DOW_FR[i]}</div>
        <div style="width:52px;height:52px;display:flex;align-items:center;justify-content:center;font:700 18px ${CARD_UI};${i === dow ? `background:${t.accent};color:${t.bg}` : `border:1px solid ${t.border};color:${t.muted}`}">${pad2(d.getDate())}</div>
      </div>`).join('');
    const end = days[6];
    const rangeTxt = `SEMAINE DU ${pad2(days[0].getDate())} AU ${pad2(end.getDate())} ${MONTH_FR[end.getMonth()].toUpperCase()} ${end.getFullYear()}`;
    return `
      ${recordTitle(t, ctx.label)}
      <div style="font:700 130px ${CARD_NUM};color:${t.accent};line-height:1;margin-top:18px">${ctx.newTime}<span style="font-size:.28em;color:${t.muted}">s</span></div>
      <div style="display:flex;gap:16px;margin-top:40px">${grid}</div>
      <div style="margin-top:26px;font:400 17px ${CARD_MONO};letter-spacing:.06em;color:${t.muted}">${rangeTxt}</div>
      ${recordPill(t, RECORD_PILL_LABELS.semaine)}`;
  },

  // Record du mois : semis de pastilles (une par jour), le jour du record allume.
  '13r-record-mois': (t, pilot, ctx) => {
    const y = ctx.recordDate.getFullYear(), m = ctx.recordDate.getMonth();
    const daysInMonth = new Date(y, m + 1, 0).getDate();
    const dayOfMonth = ctx.recordDate.getDate();
    const dots = Array.from({ length: daysInMonth }, (_, i) => {
      const on = i + 1 === dayOfMonth;
      return `<div style="width:18px;height:18px;border-radius:50%;${on ? `background:${t.accent};box-shadow:0 0 18px ${t.accent}` : `border:1.5px solid ${t.border}`}"></div>`;
    }).join('');
    return `
      ${recordTitle(t, ctx.label)}
      <div style="font:700 130px ${CARD_NUM};color:${t.accent};line-height:1;margin-top:18px">${ctx.newTime}<span style="font-size:.28em;color:${t.muted}">s</span></div>
      <div style="display:grid;grid-template-columns:repeat(7, 18px);gap:16px;margin-top:40px;justify-content:center">${dots}</div>
      <div style="margin-top:26px;font:400 20px ${CARD_MONO};letter-spacing:.18em;color:${t.accent};text-transform:uppercase">${MONTH_FR[m]} ${y}</div>
      ${recordPill(t, RECORD_PILL_LABELS.mois)}`;
  },
};

function pickRecordConcept(scope) {
  const chosen = (CARD_RECORD_PICKS || {})[scope];
  if (chosen && RECORD_BODIES[chosen]) return chosen;
  return RECORD_DEFAULT_BY_SCOPE[scope] || RECORD_DEFAULT_BY_SCOPE.perso;
}

/** Carte de record — un pilote qui vient de battre un record (scope donne). */
export async function recordCardPNGBytes(regId, scope, payload) {
  const pilot = (allResults || []).find((r) => r.regId === regId);
  if (!pilot) throw new Error('Pilote introuvable dans cette session : ' + regId);
  const t = themeColors();
  const sc = RECORD_SCOPE_LABELS[scope] ? scope : 'perso';
  const newTime = (payload && payload.time != null) ? fmtCardTime(payload.time)
    : (pilot.bestLap != null ? fmtCardTime(pilot.bestLap) : '--');
  const prevTime = (payload && payload.prev != null) ? fmtCardTime(payload.prev) : null;
  const deltaTxt = (payload && payload.delta != null) ? '-' + fmtCardTime(Math.abs(Number(payload.delta))) + 's' : null;
  const ctx = {
    label: RECORD_SCOPE_LABELS[sc],
    newTime, prevTime, deltaTxt,
    recordDate: parseRecordDate(payload && payload.date),
  };
  const id = (payload && payload.concept && RECORD_BODIES[payload.concept]) ? payload.concept : pickRecordConcept(sc);
  const build = RECORD_BODIES[id] || RECORD_BODIES['01r-track-record'];
  await prewarmCardAvatars(pilot);
  return renderCardPNG(cardShell(t, build(t, pilot, ctx), pilot, id));
}

// Rasterise un fragment HTML 1080x1920 en PNG (ArrayBuffer). Reutilise
// sectionToCanvas (le meme moteur html2canvas que les PDF), a l'echelle 1 :
// la carte est deja definie a sa resolution finale, contrairement aux
// pages A4 qui doivent etre remises a l'echelle.
async function renderCardPNG(bodyHTML) {
    const t = themeColors();
    const node = document.createElement('div');
    node.style.cssText = `position:relative;width:${CARD_W}px;height:${CARD_H}px;overflow:hidden;` +
          `background:${t.bg};font-family:${CARD_UI};color:${t.text}`;
    node.innerHTML = bodyHTML;
    const canvas = await sectionToCanvas(node, CARD_W, t.bg, 1);
    return new Promise((resolve, reject) => {
          canvas.toBlob((blob) => {
                  if (!blob) { reject(new Error('Rendu de la carte vide (toBlob)')); return; }
                  blob.arrayBuffer().then(resolve, reject);
          }, 'image/png');
    });
}
