// Module de la page publique de résultats (results.html) — accès par QR code / lien,
// sans auth. Reprend à l'identique la logique de l'ancien results.html monofichier :
// résolution de session par public_results_token, classement (temps total), podium,
// top 10, classement complet, détail tour par tour (avec secteurs), export PDF.
import { db } from '../lib/supabase.js';
import { kartAvatarSVG, kartAvatarDataURL } from './kart-avatar.js';
import { pilotAvatarSVG, pilotAvatarDataURL } from './pilot-avatar.js';
import { loadSiteConfig } from './site-config.js';
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

// Génère la source d'un avatar (kart ou pilote selon le réglage courant), pour un
// <img src> — utilisé aussi bien dans les exports PDF que sur la page web publique.
function genAvatarDataURL(kart, opts) {
  // Pack Signature (plan Pro) : le PDF doit utiliser le même avatar que l'écran.
  // signatureAvatarDataURLSync() lit un cache préchauffé par prewarm… en tête des
  // deux exports ; s'il est vide (pack cassé, kart non préchauffé) on retombe
  // silencieusement sur l'avatar classique.
  if (signatureAvatarsActive()) {
    const sig = signatureAvatarDataURLSync(kart, opts);
    if (sig) return sig;
  }
  if (PDF_AVATAR_MODE === 'pilot_kart') return pilotAvatarDataURL(kart, kart);
  if (PDF_AVATAR_MODE === 'pilot') return pilotAvatarDataURL(kart, null, { hidePlate: true });
  // avatar_scheme (session_registrations) prioritaire : opts.scheme, déjà
  // supporté par kartAvatarSVG/kartAvatarDataURL, doit être transmis ici —
  // avant ce correctif il était silencieusement perdu (opts non transmis).
  return kartAvatarDataURL(kart, opts);
}
// Même chose en SVG inline (utilisé pour les placeholders sans photo sur la page web).
function genAvatarSVG(kart, opts) {
  if (PDF_AVATAR_MODE === 'pilot_kart') return pilotAvatarSVG(kart, kart, opts);
  if (PDF_AVATAR_MODE === 'pilot') return pilotAvatarSVG(kart, null, { ...opts, hidePlate: true });
  return kartAvatarSVG(kart, opts);
}

/* ------------------------------------------------------------------
THEME — Lu depuis app_settings (key='global'), défini dans
admin.html > Paramètres > Apparence.
------------------------------------------------------------------ */
export function initTheme() {
const MAP = {
classic: 'classic', dark: 'classic', neon: 'neon', carbon: 'carbon',
// v15 : thèmes premium (plan Pro/Business) — manquaient de cette table,
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
if (theme) document.documentElement.setAttribute('data-theme', MAP[theme] || 'classic');

const logoUrl = data.value && data.value.logo_url;
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

// Plan du circuit (optionnel) — affiché juste avant le podium, uniquement si configuré.
// À gater sur le plan Pro une fois la facturation en place (Phase 3 roadmap).
const trackMapUrl = data.value && data.value.track_map_url;
if (trackMapUrl) {
const podiumWrap = document.getElementById('podium-wrap');
if (podiumWrap && podiumWrap.parentElement && !document.getElementById('circuit-track-map')) {
const section = document.createElement('div');
section.id = 'circuit-track-map';
section.style.cssText = 'margin-bottom:16px;text-align:center';
const img = document.createElement('img');
img.src = trackMapUrl;
img.alt = 'Plan du circuit';
img.style.cssText = 'max-width:100%;max-height:280px;object-fit:contain;border-radius:10px';
section.appendChild(img);
podiumWrap.parentElement.insertBefore(section, podiumWrap);
}
}
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
return d.gap === 0 ? fmtTime(d.total) : fmtGap(d.gap);
}

/* ------------------------------------------------------------------
RENDER — PODIUM (top 3) — classement = temps total (somme des tours),
comme dans l'admin (sessions.js > loadRanking), pas le meilleur tour seul.
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
export async function load() {
const token = new URLSearchParams(window.location.search).get('result');
if (!token) return fail();
// AVANT tout rendu : sinon les avatars se dessinent en repli classique tant que
// la config n'est pas revenue (course avec initTheme(), memes promesse memoisee).
await loadSiteConfig();

const { data: session, error: sErr } = await db.from('sessions').select('*').eq('public_results_token', token).maybeSingle();
if (sErr || !session) return fail();
sessionInfo = session;

document.getElementById('circuit-name').textContent = session.circuit_name || 'Circuit de Trinisette';
document.getElementById('session-label').textContent = session.title || '--';
document.getElementById('session-date').textContent = fmtSessionDate(session.session_date);

const [lapsRes, regsRes, driversRes] = await Promise.all([
db.from('laps').select('registration_id,lap_index,lap_time_seconds,sector_1_seconds,sector_2_seconds,sector_3_seconds').eq('session_id', session.id),
db.from('session_registrations').select('*').eq('session_id', session.id),
db.from('drivers').select('id,nationality,photo_url'),
]);
if (lapsRes.error || regsRes.error || driversRes.error) return fail();

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

results.sort((a, b) => a.total - b.total);
const leader = results.find(r => r.hasTime);
const leaderTotal = leader ? leader.total : 0;
results.forEach((r, i) => { r.gap = r.hasTime ? (r.total - leaderTotal) : null; r.pos = i + 1; });

allResults = results;
renderPodium(results.slice(0, 3));
renderTop10(results.slice(3, PAGE1MAX));
renderPage2(results);
renderAccordion(results.filter(r => r.hasTime));

document.getElementById('page-nav').style.display = 'flex';
goToPage(1);
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
document.getElementById('nav-prev').disabled = (n === 1);
document.getElementById('nav-next').disabled = (n === 3);
document.getElementById('nav-next-label').textContent = (n === 1 ? 'Classement' : 'Détails');
window.scrollTo(0, 0);
}

export function initNav() {
document.getElementById('nav-prev').addEventListener('click', () => goToPage(currentPage - 1));
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
let canvas;
try {
canvas = await html2canvas(wrap, { backgroundColor: bg || '#ffffff', scale: scale || 2.5, width, windowWidth: width, useCORS: true, allowTaint: false, imageTimeout: 8000 });
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
.pdfx-head-left .pdfx-circuit-name{font-family:var(--font-display);font-weight:700;font-style:italic;font-size:22px;text-transform:uppercase;color:var(--c-text);letter-spacing:.01em;transform:skewX(-6deg);transform-origin:left}
.pdfx-head-left .pdfx-session-lbl{font-size:10.5px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:var(--c-accent);margin-top:2px}
.pdfx-head-right{text-align:right}
.pdfx-head-right .pdfx-date{font-size:11.5px;font-weight:700;letter-spacing:.05em;color:var(--c-muted);text-transform:uppercase}
.pdfx-head-right .pdfx-count{font-size:10.5px;color:var(--c-muted);margin-top:2px}

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
.pdfx-sheet-footer{display:flex;justify-content:space-between;align-items:center;padding:9px 24px 14px;font-size:9px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--c-muted)}
.pdfx-page.landscape .pdfx-sheet-footer{padding:9px 28px 14px}
.pdfx-sheet-footer b{color:var(--c-text)}

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
.pdfx-id-block{min-width:92px;flex:1 1 92px}
.pdfx-pilot-name{font-family:var(--font-display);font-weight:700;font-style:italic;font-size:17px;text-transform:uppercase;letter-spacing:.01em;color:var(--c-text);transform:skewX(-6deg);transform-origin:left;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%;line-height:1.4}
.pdfx-id-meta{display:flex;gap:7px;row-gap:3px;margin-top:3px;flex-wrap:wrap}
.pdfx-id-meta .item{font-size:9.5px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--c-muted);white-space:nowrap}
.pdfx-id-meta .item b{color:var(--c-accent);font-size:1.05em}
.pdfx-summary-card{background:var(--c-surface-2);border:1px solid var(--c-border);border-radius:9px;padding:6px 9px;display:flex;flex-direction:row;gap:8px;align-items:center;flex-shrink:0}
.pdfx-summary-row{display:flex;align-items:center;gap:6px}
.pdfx-summary-row svg{width:12px;height:12px;stroke:var(--c-accent);flex-shrink:0}
.pdfx-summary-row .txt{display:flex;flex-direction:column;line-height:1.1}
.pdfx-summary-row .txt .k{font-size:7.5px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;color:var(--c-muted);white-space:nowrap}
.pdfx-summary-row .txt .v{font-family:var(--font-display);font-size:14px;font-weight:700;color:var(--c-text);white-space:nowrap}
.pdfx-summary-row.best .txt .v{color:var(--c-accent)}
.pdfx-circuit-block{display:flex;align-items:center;gap:6px;flex:0 1 140px;min-width:90px;max-width:190px;margin-left:auto}
.pdfx-circuit-text{text-align:right;min-width:0;overflow:hidden;flex:1 1 auto}
.pdfx-circuit-block .pdfx-c-name{font-family:var(--font-display);font-weight:700;font-style:italic;font-size:12.5px;text-transform:uppercase;color:var(--c-text);letter-spacing:.01em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%}
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
  if (d.gap === 0) return fmtPdfTime(d.total);
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
const PDFX_FIT_SEL = '.pdfx-pilot-name,.pdfx-p-name,.pdfx-pv-name,.pdfx-rank-row .name,.pdfx-sheet-header-mini .mini-name,.pdfx-rank-header-mini .mini-name,.pdfx-c-name,.pdfx-circuit-meta .item span';
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
    const title = escapeHTML((sessionInfo && sessionInfo.circuit_name) || 'Circuit de Trinisette');
    const label = escapeHTML((sessionInfo && sessionInfo.title) || 'Classement');
    const date = escapeHTML(fmtSessionDate(sessionInfo && sessionInfo.session_date));
    const dateShort = escapeHTML(sessionInfo && sessionInfo.session_date
      ? new Date(sessionInfo.session_date + 'T12:00:00').toLocaleDateString('fr-FR')
      : '--');

    const headBand = `
<div class="pdfx-head-band">
<div class="pdfx-head-left">
<div class="pdfx-circuit-name">${title}</div>
<div class="pdfx-session-lbl">Classement complet — ${label}</div>
</div>
<div class="pdfx-head-right">
<div class="pdfx-date">${dateShort}</div>
<div class="pdfx-count">${results.length} pilotes</div>
</div>
</div>`;
    const footer = `<div class="pdfx-sheet-footer"><span>${title} · <b>${date}</b></span><span><b>Trinisette</b> Karting</span></div>`;

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
    pdf.save(`classement_karting_${g.landscape ? 'paysage' : 'portrait'}.pdf`);
  } catch (e) {
    alert('Erreur PDF : ' + e.message);
  }
  btn.disabled = false;
  btn.innerHTML = original;
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
  const [{ data: laps }, { data: regs }] = await Promise.all([
    db.from('laps').select('registration_id,lap_time_seconds').eq('session_id', sessionId),
    db.from('session_registrations').select('id,display_name,kart_number').eq('session_id', sessionId),
  ]);
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
  try {
    let query = db
      .from('session_registrations')
      .select('id,session_id,display_name,sessions!inner(id,session_date,tenant_id,public_results_token)')
      .ilike('display_name', cleanName)
      .not('sessions.public_results_token', 'is', null);
    if (tenantId) query = query.eq('sessions.tenant_id', tenantId);
    const { data: allRegs, error } = await query;
    if (error || !allRegs || !allRegs.length) return { podiums: 0, lastPositions: [] };

    const bySession = new Map();
    allRegs.forEach((r) => {
      if (!r.sessions) return;
      bySession.set(r.session_id, { date: r.sessions.session_date, regName: r.display_name });
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
<div class="txt"><span class="k">Podiums (toutes sessions)</span><span class="v">${palmares.podiums}</span></div>
</div>
<div class="pdfx-summary-row">
${PDFX_SVG_CLOCK}
<div class="txt" title="${escapeHTML(posTitle)}"><span class="k">3 dernieres positions</span><span class="v" style="font-size:12px">${posTxt}</span></div>
</div>`;
}

/* ==================================================================
   PDF FICHE PILOTE
   ================================================================== */
export async function downloadPilotPDF(pilot, btn) {
  btn.classList.add('loading');
  btn.innerHTML = SPIN_ICON;
  try {
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
    const circuitTxt = escapeHTML((sessionInfo && sessionInfo.circuit_name) || 'Circuit de Trinisette');
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
<div class="pdfx-circuit-logo">${pdfxInitial((sessionInfo && sessionInfo.circuit_name) || 'Trinisette')}</div>
</div>
</div>`;
    const footer = `<div class="pdfx-sheet-footer"><span>${circuitTxt} · <b>${dateTxt}</b></span><span><b>Trinisette</b> Karting</span></div>`;

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
    pdf.save(`Fiche_Pilote_${pilot.name.replace(/[^a-z0-9]/gi, '_')}.pdf`);
  } catch (e) {
    alert('Erreur PDF : ' + e.message);
  }
  btn.classList.remove('loading');
  btn.innerHTML = PDF_ICON;
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
