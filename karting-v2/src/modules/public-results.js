// Module de la page publique de résultats (results.html) — accès par QR code / lien,
// sans auth. Reprend à l'identique la logique de l'ancien results.html monofichier :
// résolution de session par public_results_token, classement (temps total), podium,
// top 10, classement complet, détail tour par tour (avec secteurs), export PDF.
import { db } from '../lib/supabase.js';
import { kartAvatarSVG, kartAvatarDataURL } from './kart-avatar.js';

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

/* ------------------------------------------------------------------
THEME — Lu depuis app_settings (key='global'), défini dans
admin.html > Paramètres > Apparence.
------------------------------------------------------------------ */
export function initTheme() {
const MAP = { classic: 'classic', dark: 'classic', neon: 'neon', carbon: 'carbon' };
db.from('app_settings').select('value').eq('key', 'global').maybeSingle().then(({ data }) => {
const theme = data && data.value && data.value.results_theme;
PDF_SHOW_SECTORS = !!(data && data.value && data.value.sectors_enabled);
if (theme) document.documentElement.setAttribute('data-theme', MAP[theme] || 'classic');

const logoUrl = data && data.value && data.value.logo_url;
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
const trackMapUrl = data && data.value && data.value.track_map_url;
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
function avatarHTML(src, kart, alt, cls = '') {
if (src) {
return `<img class="pilot-avatar ${cls}" src="${src}" alt="${alt}" loading="lazy" crossorigin="anonymous" width="200" height="280">`;
}
return `<div class="pilot-avatar-placeholder kart ${cls}" role="img" aria-label="${alt}">${kartAvatarSVG(kart, { title: alt })}</div>`;
}
function rankAvatarHTML(src, kart) {
if (src) return `<img src="${src}" alt="" loading="lazy" crossorigin="anonymous" width="57" height="57">`;
return `<div class="rank-avatar-placeholder kart">${kartAvatarSVG(kart)}</div>`;
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
<div class="pilot-photo-wrap">${avatarHTML(d.photo, d.kart, `Photo de ${d.name}`)}</div>
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
<div class="rank-avatar" aria-hidden="true">${rankAvatarHTML(d.photo, d.kart)}</div>
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
<div class="rank-avatar acc-toggle" aria-hidden="true">${rankAvatarHTML(d.photo, d.kart)}</div>
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
total: hasTime ? totals.get(r.id) : NO_TIME,
lapsCount: lapCounts.get(r.id) || 0,
lapsArr, bestLap,
isUnknown: !!r.is_unknown,
hasTime,
});
if (r.kart_number != null) usedKarts.add(Number(r.kart_number));
});

const maxKarts = Number(session.max_karts || 0);
for (let k = 1; k <= maxKarts; k++) {
if (usedKarts.has(k)) continue;
results.push({ kart: k, name: 'Kart libre', nat: 'OTHER', photo: null, total: NO_TIME, lapsCount: 0, lapsArr: [], bestLap: null, isUnknown: true, hasTime: false });
}

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

async function sectionToCanvas(node, width, bg) {
const holder = document.getElementById('pdf-render-root');
holder.innerHTML = '';
holder.style.width = width + 'px';
const wrap = document.createElement('div');
wrap.style.width = width + 'px';
wrap.style.background = bg || '#ffffff';
wrap.appendChild(node);
holder.appendChild(wrap);
// laisser le temps aux <img> (avatars data-URI) de se décoder avant la capture
await Promise.all(Array.from(wrap.querySelectorAll('img')).map(img =>
(img.complete && img.naturalWidth) ? Promise.resolve() : new Promise(res => { img.onload = img.onerror = res; })
));
await new Promise(r => setTimeout(r, 80));
const canvas = await html2canvas(wrap, { backgroundColor: bg || '#ffffff', scale: 2.5, width, windowWidth: width, useCORS: true, allowTaint: false, imageTimeout: 8000 });
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

/* ------------------------------------------------------------------
STYLE DES PDF — reprend exactement l'identité graphique de la page
résultats (mêmes polices Teko/Barlow Condensed déjà chargées, mêmes
variables CSS de thème --c-*), au lieu de l'ancien style Arial/tableau
plat. Injecté une seule fois dans <head>.
------------------------------------------------------------------ */
let PDF_STYLES_INJECTED = false;
function ensurePdfStyles() {
if (PDF_STYLES_INJECTED) return;
const style = document.createElement('style');
style.id = 'pdfx-styles';
style.textContent = `
.pdfx-page{width:760px}
.pdfx-sheet{display:flex;flex-direction:column;background:var(--c-surface);border:1px solid var(--c-border);border-radius:14px;overflow:hidden;font-family:var(--font-body)}
.pdfx-head-band{position:relative;padding:16px 24px;background:linear-gradient(120deg,var(--c-accent-glow),transparent 65%),var(--c-surface-2);border-bottom:1px solid var(--c-border);display:flex;align-items:center;justify-content:space-between;gap:16px}
.pdfx-head-band::after{content:'';position:absolute;top:8px;right:8px;width:18px;height:18px;border-top:2px solid var(--c-accent);border-right:2px solid var(--c-accent);opacity:.5}
.pdfx-circuit-name{font-family:var(--font-display);font-weight:700;font-style:italic;font-size:22px;text-transform:uppercase;color:var(--c-text);letter-spacing:.01em;transform:skewX(-6deg);transform-origin:left}
.pdfx-session-lbl{font-size:10.5px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:var(--c-accent);margin-top:2px}
.pdfx-date{font-size:11.5px;font-weight:700;letter-spacing:.05em;color:var(--c-muted);text-transform:uppercase;text-align:right}
.pdfx-count{font-size:10.5px;color:var(--c-muted);margin-top:2px;text-align:right}
.pdfx-podium{display:flex;align-items:flex-end;gap:10px;padding:16px 24px 14px;border-bottom:1px solid var(--c-border)}
.pdfx-p-card{flex:1;min-width:0;background:var(--c-surface-2);border-radius:12px;border:2px solid var(--c-border);padding:10px 8px 8px;position:relative;text-align:center}
.pdfx-p-card.p1{border-color:var(--c-p1-border);order:2;padding-top:6px}
.pdfx-p-card.p2{border-color:var(--c-p2-border);order:1}
.pdfx-p-card.p3{border-color:var(--c-p3-border);order:3}
.pdfx-p-rank{font-family:var(--font-display);font-weight:700;font-style:italic;font-size:14px;position:absolute;top:6px;left:8px;color:var(--c-muted)}
.pdfx-p-card.p1 .pdfx-p-rank{color:var(--c-p1-border);font-size:17px}
.pdfx-p-avatar{width:54px;height:54px;border-radius:50%;margin:4px auto 6px;overflow:hidden;background:var(--c-bg);border:2px solid var(--c-border)}
.pdfx-p-card.p1 .pdfx-p-avatar{width:66px;height:66px;border-color:var(--c-p1-border)}
.pdfx-p-card.p2 .pdfx-p-avatar{border-color:var(--c-p2-border)}
.pdfx-p-card.p3 .pdfx-p-avatar{border-color:var(--c-p3-border)}
.pdfx-p-avatar img{width:100%;height:100%;object-fit:cover;display:block}
.pdfx-p-name{font-family:var(--font-display);font-weight:700;font-style:italic;font-size:13px;text-transform:uppercase;color:var(--c-text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pdfx-p-card.p1 .pdfx-p-name{font-size:15px}
.pdfx-p-kart{font-size:9px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--c-muted);margin-top:2px}
.pdfx-p-stats{display:flex;justify-content:center;gap:8px;margin-top:7px;padding-top:7px;border-top:1px solid var(--c-border)}
.pdfx-p-stat{display:flex;flex-direction:column;line-height:1.2}
.pdfx-p-stat .k{font-size:7px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;color:var(--c-muted)}
.pdfx-p-stat .v{font-family:var(--font-display);font-weight:700;font-size:12px;color:var(--c-text)}
.pdfx-p-stat .v.best{color:var(--c-accent)}
.pdfx-p-card.p1 .pdfx-p-stat .v.best{color:var(--c-p1-border)}
.pdfx-rank-wrap{padding:12px 24px 16px;flex:1;min-width:0}
.pdfx-rank-title{font-size:10px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:var(--c-muted);border-left:3px solid var(--c-accent);padding-left:8px;margin-bottom:6px;font-family:var(--font-body)}
.pdfx-rank-head{display:grid;grid-template-columns:26px 28px 1.5fr 46px 44px 74px 66px;gap:4px;padding:0 8px 6px;font-size:8.5px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;color:var(--c-muted);border-bottom:1px solid var(--c-border)}
.pdfx-rank-head.with-sec,.pdfx-rank-row.with-sec{grid-template-columns:22px 24px minmax(60px,1fr) 34px 34px 60px 50px 46px 46px 46px}
.pdfx-rank-head span.num{text-align:center}
.pdfx-rank-body{margin-top:2px}
.pdfx-rank-row{display:grid;grid-template-columns:26px 28px 1.5fr 46px 44px 74px 66px;gap:4px;align-items:center;padding:5px 8px;font-size:11px;color:var(--c-text);border-bottom:1px solid var(--c-border)}
.pdfx-rank-row:nth-child(even){background:var(--c-surface-2)}
.pdfx-rank-row:last-child{border-bottom:none}
.pdfx-rank-row .pos{font-family:var(--font-display);font-weight:700;font-style:italic;font-size:13px;color:var(--c-muted);text-align:center}
.pdfx-rank-row .av{width:20px;height:20px;border-radius:50%;overflow:hidden;background:var(--c-bg);border:1px solid var(--c-border)}
.pdfx-rank-row .av img{width:100%;height:100%;object-fit:cover;display:block}
.pdfx-rank-row .name{font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pdfx-rank-row .kart{color:var(--c-muted);font-size:10px;text-align:center}
.pdfx-rank-row .laps{color:var(--c-muted);font-size:10px;text-align:center}
.pdfx-rank-row .best{font-weight:700;font-size:10.5px;text-align:center}
.pdfx-rank-row .gap{color:var(--c-muted);font-size:10px;text-align:center}
.pdfx-rank-row.top3 .pos{color:var(--c-accent)}
.pdfx-rank-row .sec{color:var(--c-muted);font-size:9.5px;text-align:center}
.pdfx-sheet-footer{display:flex;justify-content:space-between;align-items:center;padding:9px 24px 14px;font-size:9px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--c-muted);font-family:var(--font-body)}
.pdfx-sheet-footer b{color:var(--c-text)}
.pdfx-header-mini{display:flex;align-items:center;justify-content:space-between;gap:14px;padding:12px 24px;border-bottom:1px solid var(--c-border)}
.pdfx-header-mini .mini-name{font-family:var(--font-display);font-weight:700;font-style:italic;font-size:16px;text-transform:uppercase;color:var(--c-text);transform:skewX(-6deg)}
.pdfx-header-mini .mini-tag{font-size:10px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--c-muted)}
.pdfx-header-mini .mini-page{font-size:10px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--c-accent)}
.pdfx-topbar{height:5px;width:100%;background:linear-gradient(90deg,var(--c-accent),transparent 140%)}
.pdfx-fp-header{position:relative;padding:16px 18px;display:flex;align-items:center;gap:14px;flex-wrap:nowrap;border-bottom:1px solid var(--c-border)}
.pdfx-fp-header::after{content:'';position:absolute;top:8px;right:8px;width:22px;height:22px;border-top:2px solid var(--c-accent);border-right:2px solid var(--c-accent);opacity:.5}
.pdfx-fp-avatar{width:66px;height:66px;border-radius:12px;overflow:hidden;background:var(--c-surface-2);border:1px solid var(--c-border);flex-shrink:0}
.pdfx-fp-avatar img{width:100%;height:100%;object-fit:cover;display:block}
.pdfx-fp-name{font-family:var(--font-display);font-weight:700;font-style:italic;font-size:22px;text-transform:uppercase;color:var(--c-text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pdfx-fp-meta{font-size:12px;font-weight:700;color:var(--c-muted);margin-top:3px;letter-spacing:.04em;text-transform:uppercase}
.pdfx-stats-row{padding:16px 18px 8px;display:flex;gap:8px}
.pdfx-stat{flex:1;min-width:0;background:var(--c-surface);border:1px solid var(--c-border);border-radius:8px;padding:9px 8px}
.pdfx-stat .k{font-size:9px;font-weight:800;color:var(--c-muted);text-transform:uppercase;letter-spacing:.05em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-family:var(--font-body)}
.pdfx-stat .v{font-family:var(--font-display);font-size:19px;font-weight:700;margin-top:3px;color:var(--c-text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pdfx-stat .v.hl{color:var(--c-accent)}
.pdfx-tbl-wrap{padding:10px 18px 16px}
.pdfx-tbl-head{display:grid;grid-template-columns:.7fr 1.1fr 1fr 1fr 1fr 1fr;padding:0 10px 8px;font-size:10.5px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--c-muted);border-bottom:1px solid var(--c-border);font-family:var(--font-body)}
.pdfx-tbl-wrap.no-sec .pdfx-tbl-head,.pdfx-tbl-wrap.no-sec .pdfx-tbl-row{grid-template-columns:.5fr 1fr 1fr}
.pdfx-tbl-body{margin-top:2px}
.pdfx-tbl-row{display:grid;grid-template-columns:.7fr 1.1fr 1fr 1fr 1fr 1fr;align-items:center;padding:9px 10px;font-size:13px;color:var(--c-text);border-bottom:1px solid var(--c-border)}
.pdfx-tbl-row:nth-child(even){background:var(--c-surface-2)}
.pdfx-tbl-row:last-child{border-bottom:none}
.pdfx-tbl-row .pos{text-align:center;font-family:var(--font-display);font-weight:700;font-style:italic;font-size:16px;color:var(--c-muted)}
.pdfx-tbl-row .time{font-weight:700;text-align:center}
.pdfx-tbl-row .gap{color:var(--c-muted);text-align:center}
.pdfx-tbl-row .sec{color:var(--c-muted);text-align:center}
.pdfx-tbl-row.best{background:var(--c-accent) !important}
.pdfx-tbl-row.best .pos,.pdfx-tbl-row.best .time,.pdfx-tbl-row.best .gap,.pdfx-tbl-row.best .sec{color:var(--c-gap-text, #fff)}
`;
document.head.appendChild(style);
PDF_STYLES_INJECTED = true;
}

function pdfxPodiumHTML(field) {
const cls = { 1: 'p1', 2: 'p2', 3: 'p3' };
const order = [field[1], field[0], field[2]].filter(Boolean);
return `<div class="pdfx-podium">${order.map(d => `
<div class="pdfx-p-card ${cls[d.pos]}">
<div class="pdfx-p-rank">${d.pos}</div>
<div class="pdfx-p-avatar"><img src="${kartAvatarDataURL(d.kart)}" alt=""></div>
<div class="pdfx-p-name">${flagOf(d.nat)} ${escapeHTML(d.name)}</div>
<div class="pdfx-p-kart">KART ${d.kart ?? '-'}</div>
<div class="pdfx-p-stats">
<div class="pdfx-p-stat"><span class="k">Meill. tour</span><span class="v best">${d.bestLap != null ? fmtPdfTime(d.bestLap) : '--'}</span></div>
<div class="pdfx-p-stat"><span class="k">Tours</span><span class="v">${d.lapsCount}</span></div>
</div>
</div>`).join('')}</div>`;
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
function pdfxRankRowsHTML(chunk, showSec) {
return chunk.map(d => `
<div class="pdfx-rank-row${d.pos <= 3 ? ' top3' : ''}${showSec ? ' with-sec' : ''}">
<span class="pos">${d.pos}</span>
<span class="av"><img src="${kartAvatarDataURL(d.kart)}" alt=""></span>
<span class="name">${flagOf(d.nat)} ${escapeHTML(d.name)}</span>
<span class="kart">#${d.kart ?? '-'}</span>
<span class="laps">${d.hasTime ? d.lapsCount : '--'}</span>
<span class="best">${d.bestLap != null ? fmtPdfTime(d.bestLap) : '--'}</span>
<span class="gap">${d.hasTime ? escapeHTML(gapBadge(d)) : '--'}</span>
${showSec ? [0, 1, 2].map(si => { const v = pdfxBestSec(d, si); return `<span class="sec">${v != null ? fmtPdfTime(v) : '--'}</span>`; }).join('') : ''}
</div>`).join('');
}
function pdfxStatHTML(lbl, val, hl) {
return `<div class="pdfx-stat"><div class="k">${lbl}</div><div class="v${hl ? ' hl' : ''}">${val}</div></div>`;
}
function pdfxTblHeadHTML(secCount) {
const secHead = Array.from({ length: secCount }, (_, n) => `<span style="text-align:center">S${n + 1}</span>`).join('');
return `<div class="pdfx-tbl-head"><span style="text-align:center">Tour</span><span style="text-align:center">Temps</span><span style="text-align:center">Écart</span>${secHead}</div>`;
}
function pdfxTblRowsHTML(laps, bestLap, sectorsPresent) {
return laps.map(l => {
const isBest = bestLap != null && l.time === bestLap;
const delta = bestLap != null ? l.time - bestLap : null;
const secCells = sectorsPresent.map(i => `<span class="sec">${Number.isFinite(l.sectors?.[i]) ? fmtPdfTime(l.sectors[i]) : '--'}</span>`).join('');
return `<div class="pdfx-tbl-row${isBest ? ' best' : ''}">
<span class="pos">${l.idx}</span>
<span class="time">${fmtPdfTime(l.time)}</span>
<span class="gap">${delta == null ? '--' : (delta === 0 ? 'MEILLEUR' : '+' + fmtPdfTime(delta))}</span>
${secCells}
</div>`;
}).join('');
}

/* PDF CLASSEMENT COMPLET — pagination réelle par mesure DOM (comme la page
publique) : autant de pages A4 que nécessaire pour ne jamais faire déborder
un pilote, avec le style visuel de la page résultats (podium sur la 1re
page, bandeau allégé sur les suivantes). */
export async function downloadFullPDF(btn) {
const original = btn.innerHTML;
btn.disabled = true;
btn.innerHTML = `${SPIN_ICON} Génération…`;
try {
ensurePdfStyles();
const { jsPDF } = window.jspdf;
const pdf = new jsPDF('p', 'mm', 'a4');
const t = themeColors();
const showSec = sectorsEnabled();
const results = allResults;
const title = escapeHTML((sessionInfo && sessionInfo.circuit_name) || 'Circuit de Trinisette');
const label = escapeHTML((sessionInfo && sessionInfo.title) || 'Classement');
const date = escapeHTML(fmtSessionDate(sessionInfo && sessionInfo.session_date));

const pageW = 210, pageH = 297, margin = 8;
const usableW = pageW - margin * 2, usableH = pageH - margin * 2;
const budgetPx = Math.round(usableH * 760 / usableW) - 12;

const headBand = `
<div class="pdfx-head-band">
<div><div class="pdfx-circuit-name">${title}</div><div class="pdfx-session-lbl">Classement complet — ${label}</div></div>
<div><div class="pdfx-date">${date}</div><div class="pdfx-count">${results.length} pilotes</div></div>
</div>`;
const footer = `<div class="pdfx-sheet-footer"><span>${title} · <b>${date}</b></span><span><b>Trinisette</b> Karting</span></div>`;

let remaining = results.slice();
let pageIndex = 0;
while ((remaining.length || pageIndex === 0) && pageIndex < 60) {
const isFirst = pageIndex === 0;
const headMini = `<div class="pdfx-header-mini"><span class="mini-name">${title}</span><span class="mini-tag">Suite du classement</span><span class="mini-page">Page ${pageIndex + 1}</span></div>`;
const page = document.createElement('div');
page.className = 'pdfx-page';
page.style.cssText = `width:760px;background:${t.bg};position:fixed;left:-99999px;top:0`;
const rankWrap = `<div class="pdfx-rank-wrap">${isFirst ? '<div class="pdfx-rank-title">Classement complet</div>' : ''}${pdfxRankHeadHTML(showSec)}<div class="pdfx-rank-body"></div></div>`;
page.innerHTML = `<div class="pdfx-sheet">${isFirst ? headBand + pdfxPodiumHTML(results.slice(0, 3)) : headMini}${rankWrap}${footer}</div>`;
document.body.appendChild(page);
const sheet = page.querySelector('.pdfx-sheet');
const body = page.querySelector('.pdfx-rank-body');
let placed = 0;
if (!remaining.length) body.innerHTML = `<div style="padding:16px;text-align:center;color:${t.muted}">Aucun résultat.</div>`;
while (remaining.length) {
body.insertAdjacentHTML('beforeend', pdfxRankRowsHTML([remaining[0]], showSec));
if (sheet.getBoundingClientRect().height > budgetPx && placed > 0) { body.lastElementChild.remove(); break; }
placed++; remaining.shift();
}
document.body.removeChild(page);
page.style.cssText = `width:760px;background:${t.bg};`;

if (!isFirst) pdf.addPage();
const canvas = await sectionToCanvas(page, 760, t.bg);
const imgH = canvasHeightMm(canvas, usableW);
pdfRGB(pdf, t.bg, 'setFillColor');
pdf.rect(0, 0, pageW, pageH, 'F');
const scale = imgH > usableH ? usableH / imgH : 1;
const dw = usableW * scale, dh = imgH * scale;
pdf.addImage(canvas.toDataURL('image/png'), 'PNG', margin + (usableW - dw) / 2, margin, dw, dh);
pageIndex++;
if (pageIndex === 1 && !remaining.length) break;
}
pdf.save('classement_karting.pdf');
} catch (e) {
alert('Erreur PDF : ' + e.message);
}
btn.disabled = false;
btn.innerHTML = original;
}

/* PDF FICHE PILOTE — même identité graphique que la page résultats, avec
pagination réelle : tous les tours sont inclus (plus de plafond à 20),
sur autant de pages A4 que nécessaire. */
export async function downloadPilotPDF(pilot, btn) {
btn.classList.add('loading');
btn.innerHTML = SPIN_ICON;
try {
ensurePdfStyles();
const { jsPDF } = window.jspdf;
const pdf = new jsPDF('p', 'mm', 'a4');
const t = themeColors();
const showSec = sectorsEnabled();
const sectorsPresent = showSec ? [0, 1, 2].filter(i => pilot.lapsArr.some(l => l.sectors && Number.isFinite(l.sectors[i]))) : [];
const avg = pilot.hasTime && pilot.lapsCount ? pilot.total / pilot.lapsCount : null;
const gapTxt = pilot.pos === 1 ? 'Leader' : (Number.isFinite(pilot.gap) ? '+' + fmtPdfTime(pilot.gap) : '--');
const circuitTxt = escapeHTML((sessionInfo && sessionInfo.circuit_name) || 'Circuit de Trinisette');
const dateTxt = escapeHTML(fmtSessionDate(sessionInfo && sessionInfo.session_date));

const pageW = 210, pageH = 297, margin = 10;
const usableW = pageW - margin * 2, usableH = pageH - margin * 2;
const budgetPx = Math.round(usableH * 760 / usableW) - 12;

const headHTML = `
<div class="pdfx-topbar"></div>
<div class="pdfx-fp-header">
<div class="pdfx-fp-avatar"><img src="${kartAvatarDataURL(pilot.kart)}" alt=""></div>
<div style="min-width:0;flex:1">
<div class="pdfx-fp-name">${flagOf(pilot.nat)} ${escapeHTML(pilot.name)}</div>
<div class="pdfx-fp-meta">POSITION ${pilot.pos} · KART ${pilot.kart ?? '-'}</div>
</div>
</div>
<div class="pdfx-stats-row">
${pdfxStatHTML('Meilleur tour', pilot.bestLap != null ? fmtPdfTime(pilot.bestLap) : '--', true)}
${pdfxStatHTML('Temps total', pilot.hasTime ? fmtPdfTime(pilot.total) : '--')}
${pdfxStatHTML('Tours', pilot.lapsCount)}
${pdfxStatHTML('Moyenne', avg != null ? fmtPdfTime(avg) : '--')}
${pdfxStatHTML('Écart 1er', gapTxt)}
</div>`;
const footer = `<div class="pdfx-sheet-footer"><span>${circuitTxt} · <b>${dateTxt}</b></span><span>Trinisette Karting</span></div>`;

let remaining = pilot.lapsArr.slice();
let pageIndex = 0;
while ((remaining.length || pageIndex === 0) && pageIndex < 60) {
const isFirst = pageIndex === 0;
const headMini = `<div class="pdfx-header-mini"><span class="mini-name">${escapeHTML(pilot.name)}</span><span class="mini-tag">Suite du détail des tours</span><span class="mini-page">Page ${pageIndex + 1}</span></div>`;
const page = document.createElement('div');
page.style.cssText = `width:760px;background:${t.bg};position:fixed;left:-99999px;top:0`;
const tblWrap = `<div class="pdfx-tbl-wrap${sectorsPresent.length ? '' : ' no-sec'}">${pdfxTblHeadHTML(sectorsPresent.length)}<div class="pdfx-tbl-body"></div></div>`;
page.innerHTML = `<div class="pdfx-sheet">${isFirst ? headHTML : headMini}${tblWrap}${footer}</div>`;
document.body.appendChild(page);
const sheet = page.querySelector('.pdfx-sheet');
const body = page.querySelector('.pdfx-tbl-body');
let placed = 0;
if (!remaining.length) body.innerHTML = `<div style="padding:16px;text-align:center;color:${t.muted}">Aucun tour enregistré.</div>`;
while (remaining.length) {
body.insertAdjacentHTML('beforeend', pdfxTblRowsHTML([remaining[0]], pilot.bestLap, sectorsPresent));
if (sheet.getBoundingClientRect().height > budgetPx && placed > 0) { body.lastElementChild.remove(); break; }
placed++; remaining.shift();
}
document.body.removeChild(page);
page.style.cssText = `width:760px;background:${t.bg};`;

if (!isFirst) pdf.addPage();
const canvas = await sectionToCanvas(page, 760, t.bg);
pdfRGB(pdf, t.bg, 'setFillColor');
pdf.rect(0, 0, pageW, pageH, 'F');
const imgH = canvasHeightMm(canvas, usableW);
const scale = imgH > usableH ? usableH / imgH : 1;
const drawW = usableW * scale, drawH = imgH * scale;
pdf.addImage(canvas.toDataURL('image/png'), 'PNG', margin + (usableW - drawW) / 2, margin, drawW, drawH);
pageIndex++;
if (pageIndex === 1 && !remaining.length) break;
}
pdf.save(`Fiche_Pilote_${pilot.name.replace(/[^a-z0-9]/gi, '_')}.pdf`);
} catch (e) {
alert('Erreur PDF : ' + e.message);
}
btn.classList.remove('loading');
btn.innerHTML = PDF_ICON;
}

export function initPdfFullButton() {
const btn = document.getElementById('btn-pdf-full');
if (btn) btn.addEventListener('click', (e) => downloadFullPDF(e.currentTarget));
}
