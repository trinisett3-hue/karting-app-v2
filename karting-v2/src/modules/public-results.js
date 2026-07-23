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

/* ------------------------------------------------------------------
   THEME — Lu depuis app_settings (key='global'), défini dans
   admin.html > Paramètres > Apparence.
   ------------------------------------------------------------------ */
export function initTheme() {
  const MAP = { classic: 'classic', dark: 'classic', neon: 'neon', carbon: 'carbon' };
  db.from('app_settings').select('value').eq('key', 'global').maybeSingle().then(({ data }) => {
    const theme = data && data.value && data.value.results_theme;
    if (theme) document.documentElement.setAttribute('data-theme', MAP[theme] || 'classic');
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

export async function downloadFullPDF(btn) {
  const original = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = `${SPIN_ICON} Génération…`;
  try {
    const { jsPDF } = window.jspdf;
    const pdf = new jsPDF('p', 'mm', 'a4');
    const t = themeColors();
    const composite = buildResultsPDFNode(allResults, sessionInfo, t);

    const pageW = 210, pageH = 297, margin = 8;
    const usableW = pageW - margin * 2, usableH = pageH - margin * 2;
    const canvas = await sectionToCanvas(composite, 760, t.bg);
    const imgH = canvasHeightMm(canvas, usableW);
    pdfRGB(pdf, t.bg, 'setFillColor');
    pdf.rect(0, 0, pageW, pageH, 'F'); // le fond couvre toute la page, même si le contenu est plus court
    // toujours ramené à UNE page : on réduit si le contenu dépasse la hauteur utile (jamais agrandi)
    const scale = imgH > usableH ? usableH / imgH : 1;
    const dw = usableW * scale, dh = imgH * scale;
    pdf.addImage(canvas.toDataURL('image/png'), 'PNG', margin + (usableW - dw) / 2, margin, dw, dh);
    pdf.save('classement_karting.pdf');
  } catch (e) {
    alert('Erreur PDF : ' + e.message);
  }
  btn.disabled = false;
  btn.innerHTML = original;
}

/* PDF CLASSEMENT COMPLET — les 3 pages de results.html réunies sur UNE page A4
   portrait, avec l'identité graphique du thème actif (fond, accent, couleurs
   podium) : bandeau titre, podium (comme la page 1), puis un tableau combinant
   les colonnes des pages 1 (kart/écart), 2 (tours) et 3 (meilleur tour). */
export function buildResultsPDFNode(results, session, t) {
  const node = document.createElement('div');
  node.style.cssText = `width:760px;background:${t.bg};color:${t.text};font-family:Arial,Helvetica,sans-serif;`;
  const title = escapeHTML((session && session.circuit_name) || 'Circuit de Trinisette');
  const label = escapeHTML((session && session.title) || 'Classement');
  const date = escapeHTML(fmtSessionDate(session && session.session_date));
  const podium = results.slice(0, 3);
  const podOrder = [podium[1], podium[0], podium[2]].filter(Boolean); // 2 - 1 - 3
  const podBorder = { 1: t.p1, 2: t.p2, 3: t.p3 };
  const cols = '28px 32px 1fr 42px 42px 64px 78px';
  const podHTML = podOrder.map(d => {
    const first = d.pos === 1;
    const bc = podBorder[d.pos] || t.border;
    return `<div style="flex:1;background:${first ? t.surface2 : t.surface};border:2px solid ${bc};border-radius:10px;padding:9px 6px;text-align:center;${first ? '' : 'margin-top:14px;'}">
      <div style="font-size:${first ? 27 : 21}px;font-weight:900;font-style:italic;line-height:1;color:${first ? t.accent : t.muted}">${d.pos}</div>
      <img src="${kartAvatarDataURL(d.kart)}" width="${first ? 68 : 54}" height="${first ? 68 : 54}" style="display:block;margin:2px auto"/>
      <div style="font-weight:800;font-style:italic;font-size:${first ? 13 : 11}px;text-transform:uppercase;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:${t.text}">${flagOf(d.nat)} ${escapeHTML(d.name)}</div>
      <div style="font-size:9px;color:${t.muted};margin-top:1px">KART <b style="color:${t.accent}">${d.kart ?? '-'}</b></div>
      <div style="margin-top:4px;display:inline-block;background:${t.accent};color:#fff;font-weight:800;font-size:10px;padding:2px 8px;border-radius:5px">${escapeHTML(gapBadge(d))}</div>
    </div>`;
  }).join('');
  const rows = results.map((d, i) => `
    <div style="display:grid;grid-template-columns:${cols};gap:6px;align-items:center;padding:4px 8px;background:${i % 2 ? t.surface : 'transparent'};border-bottom:1px solid ${t.border};font-size:11px">
      <b style="color:${t.accent};font-size:13px;font-style:italic">${d.pos}</b>
      <img src="${kartAvatarDataURL(d.kart)}" width="26" height="26" style="display:block"/>
      <span style="font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:${t.text}">${flagOf(d.nat)} ${escapeHTML(d.name)}</span>
      <span style="text-align:center;color:${t.muted}">${d.kart ?? '-'}</span>
      <span style="text-align:center;color:${t.muted}">${d.hasTime ? d.lapsCount : '--'}</span>
      <span style="text-align:center;color:${t.text}">${d.bestLap != null ? fmtPdfTime(d.bestLap) : '--'}</span>
      <b style="text-align:right;color:${t.text}">${d.hasTime ? escapeHTML(gapBadge(d)) : '--'}</b>
    </div>`).join('');
  node.innerHTML = `
    <div style="background:${t.accent};padding:12px 16px;display:flex;justify-content:space-between;align-items:flex-end">
      <div style="font-size:24px;font-weight:900;font-style:italic;text-transform:uppercase;color:#fff;line-height:1">${title}</div>
      <div style="text-align:right;color:#fff"><div style="font-weight:700;font-size:13px">${label}</div><div style="font-size:11px;opacity:.9">${date}</div></div>
    </div>
    <div style="padding:14px 16px 6px"><div style="display:flex;gap:9px;align-items:stretch">${podHTML || ''}</div></div>
    <div style="padding:6px 16px 14px">
      <div style="display:grid;grid-template-columns:${cols};gap:6px;padding:2px 8px 4px;font-size:9px;font-weight:800;color:${t.muted};text-transform:uppercase;letter-spacing:.04em"><span>Pos</span><span></span><span>Pilote</span><span style="text-align:center">Kart</span><span style="text-align:center">Tours</span><span style="text-align:center">Meill. tour</span><span style="text-align:right">Temps/écart</span></div>
      <div style="border:1px solid ${t.border};border-radius:8px;overflow:hidden">${rows || `<div style="padding:16px;text-align:center;color:${t.muted}">Aucun résultat.</div>`}</div>
      <div style="display:flex;justify-content:space-between;margin-top:10px;font-size:9px;color:${t.muted};text-transform:uppercase;letter-spacing:.06em"><span>Trinisette Karting</span><span>Classement complet — podium, classement &amp; détail réunis</span></div>
    </div>`;
  return node;
}

/* PDF FICHE PILOTE — une page A4 portrait, identité du thème actif : bandeau avec
   l'avatar kart du pilote, 5 statistiques clés, puis le tableau tour par tour
   (secteurs si disponibles). */
export function buildPilotDetailNode(pilot, session, t) {
  const node = document.createElement('div');
  node.style.cssText = `width:760px;background:${t.bg};color:${t.text};font-family:Arial,Helvetica,sans-serif;`;
  const sectorsPresent = [0, 1, 2].filter(i => pilot.lapsArr.some(l => l.sectors && Number.isFinite(l.sectors[i])));
  const laps = pilot.lapsArr.slice(0, 20);
  const avg = pilot.hasTime && pilot.lapsCount ? pilot.total / pilot.lapsCount : null;
  const gapTxt = pilot.pos === 1 ? 'Leader' : (Number.isFinite(pilot.gap) ? '+' + fmtPdfTime(pilot.gap) : '--');
  const stat = (lbl, val, hl) => `<div style="flex:1;min-width:0;background:${t.surface};border:1px solid ${t.border};border-radius:8px;padding:9px 8px"><div style="font-size:9px;font-weight:800;color:${t.muted};text-transform:uppercase;letter-spacing:.05em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${lbl}</div><div style="font-size:15px;font-weight:900;margin-top:3px;color:${hl ? t.accent : t.text};white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${val}</div></div>`;
  const secHead = sectorsPresent.map((_, n) => `<th style="padding:8px 6px">S${n + 1}</th>`).join('');
  const rows = laps.map(l => {
    const isBest = pilot.bestLap != null && l.time === pilot.bestLap;
    const delta = pilot.bestLap != null ? l.time - pilot.bestLap : null;
    const secCells = sectorsPresent.map(i => `<td style="padding:6px 6px;text-align:center">${Number.isFinite(l.sectors?.[i]) ? fmtPdfTime(l.sectors[i]) : '--'}</td>`).join('');
    return `<tr style="background:${isBest ? t.accent : (l.idx % 2 ? 'transparent' : t.surface)};color:${isBest ? '#fff' : t.text};font-weight:${isBest ? '800' : '500'}">
      <td style="padding:6px 10px;text-align:center">${l.idx}</td>
      <td style="padding:6px 8px;text-align:center;font-weight:700">${fmtPdfTime(l.time)}</td>
      <td style="padding:6px 8px;text-align:center">${delta == null ? '--' : (delta === 0 ? 'MEILLEUR' : '+' + fmtPdfTime(delta))}</td>
      ${secCells}
    </tr>`;
  }).join('') || `<tr><td colspan="${3 + sectorsPresent.length}" style="padding:16px;text-align:center;color:${t.muted}">Aucun tour enregistré.</td></tr>`;
  const more = pilot.lapsArr.length > laps.length ? `<div style="margin-top:8px;text-align:center;font-size:10px;color:${t.muted}">+ ${pilot.lapsArr.length - laps.length} tours supplémentaires dans l'application.</div>` : '';
  node.innerHTML = `
    <div style="background:${t.accent};padding:14px 18px;display:flex;align-items:center;gap:14px">
      <div style="background:rgba(255,255,255,.16);border-radius:10px;padding:4px;flex-shrink:0"><img src="${kartAvatarDataURL(pilot.kart)}" width="66" height="66" style="display:block"/></div>
      <div style="min-width:0;flex:1;color:#fff">
        <div style="font-size:22px;font-weight:900;font-style:italic;text-transform:uppercase;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${flagOf(pilot.nat)} ${escapeHTML(pilot.name)}</div>
        <div style="font-size:12px;font-weight:700;opacity:.92;margin-top:3px">POSITION ${pilot.pos} &nbsp;·&nbsp; KART ${pilot.kart ?? '-'}</div>
      </div>
    </div>
    <div style="padding:16px 18px 8px;display:flex;gap:8px">
      ${stat('Meilleur tour', pilot.bestLap != null ? fmtPdfTime(pilot.bestLap) : '--', true)}
      ${stat('Temps total', pilot.hasTime ? fmtPdfTime(pilot.total) : '--')}
      ${stat('Tours', pilot.lapsCount)}
      ${stat('Moyenne', avg != null ? fmtPdfTime(avg) : '--')}
      ${stat('Écart 1er', gapTxt)}
    </div>
    <div style="padding:6px 18px 18px">
      <table style="width:100%;border-collapse:collapse;font-size:13px">
        <thead><tr style="background:${t.surface2};color:${t.muted};font-size:10px;letter-spacing:.04em;text-transform:uppercase"><th style="padding:8px 10px">Tour</th><th style="padding:8px 6px">Temps</th><th style="padding:8px 6px">Écart</th>${secHead}</tr></thead>
        <tbody>${rows}</tbody>
      </table>
      ${more}
      <div style="display:flex;justify-content:space-between;margin-top:12px;font-size:10px;color:${t.muted};text-transform:uppercase;letter-spacing:.06em"><span>${escapeHTML((session && session.circuit_name) || 'Circuit de Trinisette')} · ${escapeHTML(fmtSessionDate(session && session.session_date))}</span><span>Trinisette Karting</span></div>
    </div>`;
  return node;
}

function fmtPdfTime(sec) {
  const n = Number(sec);
  if (!Number.isFinite(n) || n < 0) return '--';
  const min = Math.floor(n / 60);
  const rest = (n % 60).toFixed(3).padStart(6, '0');
  return `${String(min).padStart(2, '0')}:${rest}`;
}

export async function downloadPilotPDF(pilot, btn) {
  btn.classList.add('loading');
  btn.innerHTML = SPIN_ICON;
  try {
    const { jsPDF } = window.jspdf;
    const pdf = new jsPDF('p', 'mm', 'a4');
    const t = themeColors();

    const node = buildPilotDetailNode(pilot, sessionInfo, t);

    const pageW = 210, pageH = 297, margin = 10;
    const usableW = pageW - margin * 2, usableH = pageH - margin * 2;
    const canvas = await sectionToCanvas(node, 760, t.bg);
    pdfRGB(pdf, t.bg, 'setFillColor');
    pdf.rect(0, 0, pageW, pageH, 'F');
    const imgH = canvasHeightMm(canvas, usableW);
    const scale = imgH > usableH ? usableH / imgH : 1;
    const drawW = usableW * scale, drawH = imgH * scale;
    pdf.addImage(canvas.toDataURL('image/png'), 'PNG', margin + (usableW - drawW) / 2, margin, drawW, drawH);
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
