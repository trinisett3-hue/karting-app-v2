// Module de la page publique de résultats (results.html) — accès par QR code / lien,
// sans auth. Reprend à l'identique la logique de l'ancien results.html monofichier :
// résolution de session par public_results_token, classement (temps total), podium,
// top 10, classement complet, détail tour par tour (avec secteurs), export PDF.
import { db } from '../lib/supabase.js';

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

function avatarHTML(src, alt, cls = '') {
  if (src) {
    return `<img class="pilot-avatar ${cls}" src="${src}" alt="${alt}" loading="lazy" crossorigin="anonymous" width="200" height="280">`;
  }
  return `<div class="pilot-avatar-placeholder ${cls}" role="img" aria-label="${alt}">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
      <circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 3.6-7 8-7s8 3 8 7"/>
    </svg>
  </div>`;
}
function rankAvatarHTML(src) {
  if (src) return `<img src="${src}" alt="" loading="lazy" crossorigin="anonymous" width="57" height="57">`;
  return `<div class="rank-avatar-placeholder"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 3.6-7 8-7s8 3 8 7"/></svg></div>`;
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
      <div class="pilot-photo-wrap">${avatarHTML(d.photo, `Photo de ${d.name}`)}</div>
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
    <div class="rank-avatar" aria-hidden="true">${rankAvatarHTML(d.photo)}</div>
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
        <div class="rank-avatar acc-toggle" aria-hidden="true">${rankAvatarHTML(d.photo)}</div>
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

function pdfBgRGB() {
  const bg = getComputedStyle(document.body).backgroundColor;
  const rgb = (bg.match(/\d+/g) || [5, 6, 8]).map(Number);
  return rgb;
}

async function sectionToCanvas(node, width) {
  const holder = document.getElementById('pdf-render-root');
  holder.innerHTML = '';
  holder.style.width = width + 'px';
  const wrap = document.createElement('div');
  wrap.style.width = width + 'px';
  wrap.style.background = 'var(--c-bg)';
  wrap.style.padding = '16px';
  wrap.appendChild(node);
  holder.appendChild(wrap);
  await new Promise(r => setTimeout(r, 60));
  const canvas = await html2canvas(wrap, { backgroundColor: getComputedStyle(wrap).backgroundColor, scale: 2.5, width, windowWidth: width, useCORS: true, allowTaint: false, imageTimeout: 8000 });
  holder.innerHTML = '';
  return canvas;
}
function canvasHeightMm(canvas, usableWmm) { return canvas.height * usableWmm / canvas.width; }

export async function downloadFullPDF(btn) {
  const original = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = `${SPIN_ICON} Génération…`;
  try {
    const { jsPDF } = window.jspdf;
    const pdf = new jsPDF('p', 'mm', 'a4');
    const composite = buildResultsPDFNode();

    const pageW = 210, pageH = 297, margin = 8;
    const usableW = pageW - margin * 2, usableH = pageH - margin * 2;
    const canvas = await sectionToCanvas(composite, 760);
    const imgH = canvasHeightMm(canvas, usableW);
    const [r, g, b] = pdfBgRGB();
    pdf.setFillColor(r, g, b);
    pdf.rect(0, 0, pageW, pageH, 'F');
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

/* Une mise en page dédiée, compacte et stable : les exports ne dépendent plus
   de la hauteur des écrans web et sont toujours ramenés à une seule feuille. */
function buildResultsPDFNode() {
  const node = document.createElement('div');
  node.style.cssText = 'font-family:Arial,sans-serif;color:var(--c-text);padding:8px;';
  const title = escapeHTML((sessionInfo && sessionInfo.circuit_name) || 'Circuit de Trinisette');
  const label = escapeHTML((sessionInfo && sessionInfo.title) || 'Classement final');
  const date = escapeHTML(fmtSessionDate(sessionInfo && sessionInfo.session_date));
  const rows = allResults.map(d => `
    <div style="display:grid;grid-template-columns:34px 1fr 62px 88px;gap:10px;align-items:center;padding:7px 10px;border-bottom:1px solid rgba(255,255,255,.12);font-size:14px;">
      <strong style="color:var(--c-accent);font-size:18px;">${d.pos}</strong>
      <span style="font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${flagOf(d.nat)} ${escapeHTML(d.name)}</span>
      <span>Kart ${d.kart ?? '-'}</span>
      <strong style="text-align:right;">${d.hasTime ? escapeHTML(gapBadge(d)) : '--'}</strong>
    </div>`).join('');
  node.innerHTML = `
    <div style="border-bottom:3px solid var(--c-accent);padding:10px 12px 14px;margin-bottom:12px;">
      <div style="font-size:28px;font-weight:800;text-transform:uppercase;">${title}</div>
      <div style="display:flex;justify-content:space-between;gap:12px;color:var(--c-muted);font-size:14px;margin-top:4px;"><span>${label}</span><span>${date}</span></div>
    </div>
    <div style="display:grid;grid-template-columns:34px 1fr 62px 88px;gap:10px;padding:0 10px 6px;color:var(--c-muted);font-size:11px;font-weight:700;text-transform:uppercase;"><span>Pos.</span><span>Pilote</span><span>Kart</span><span style="text-align:right;">Temps / écart</span></div>
    <div style="border:1px solid var(--c-border);background:var(--c-surface);">${rows || '<div style="padding:20px;">Aucun résultat disponible.</div>'}</div>`;
  return node;
}

function buildPilotDetailNode(pilot) {
  const node = document.createElement('div');
  node.style.cssText = 'width:720px;background:#f5f6f8;color:#17191f;font-family:Arial,sans-serif;padding:20px;border-top:5px solid var(--c-accent);';
  const sectorCount = [0, 1, 2].filter(i => pilot.lapsArr.some(l => l.sectors && Number.isFinite(l.sectors[i]))).length;
  const visibleLaps = pilot.lapsArr.slice(0, 10);
  const sectorHeaders = sectorCount ? [0, 1, 2].filter(i => pilot.lapsArr.some(l => l.sectors && Number.isFinite(l.sectors[i]))).map((i, n) => `<th style="padding:8px 6px;text-align:center;">SECTEUR ${n + 1}</th>`).join('') : '';
  const photo = pilot.photo
    ? `<img src="${escapeHTML(pilot.photo)}" crossorigin="anonymous" style="width:74px;height:74px;object-fit:cover;border-radius:8px;border:2px solid #17191f;">`
    : `<div style="width:74px;height:74px;border-radius:8px;background:#20232b;color:#fff;display:flex;align-items:center;justify-content:center;font-size:30px;">${flagOf(pilot.nat)}</div>`;
  const rows = visibleLaps.map(l => {
    const isBest = pilot.bestLap != null && l.time === pilot.bestLap;
    const delta = pilot.bestLap != null ? l.time - pilot.bestLap : null;
    const sectors = sectorCount ? [0, 1, 2].filter(i => pilot.lapsArr.some(x => x.sectors && Number.isFinite(x.sectors[i]))).map(i => `<td style="padding:7px 6px;text-align:center;">${Number.isFinite(l.sectors?.[i]) ? fmtPdfTime(l.sectors[i]) : '--'}</td>`).join('') : '';
    return `<tr style="background:${isBest ? 'var(--c-accent)' : (l.idx % 2 ? '#ffffff' : '#e9ebef')};color:${isBest ? '#fff' : '#20232b'};font-weight:${isBest ? '700' : '500'};">
      <td style="padding:7px 8px;text-align:center;">${l.idx}</td><td style="padding:7px 8px;text-align:center;">${fmtPdfTime(l.time)}</td><td style="padding:7px 8px;text-align:center;">${delta == null ? '--' : (delta === 0 ? 'MEILLEUR' : '+' + fmtPdfTime(delta))}</td>${sectors}
    </tr>`;
  }).join('') || '<tr><td colspan="6" style="padding:18px;text-align:center;">Aucun tour enregistré.</td></tr>';
  const more = pilot.lapsArr.length > visibleLaps.length ? `<div style="margin-top:10px;text-align:center;font-size:11px;color:#656a75;">Les ${pilot.lapsArr.length - visibleLaps.length} tours supplémentaires sont disponibles dans l'application.</div>` : '';
  node.innerHTML = `
    <div style="display:grid;grid-template-columns:1.1fr .9fr;gap:18px;align-items:center;padding:2px 0 16px;">
      <div style="display:flex;align-items:center;gap:14px;min-width:0;">${photo}<div style="min-width:0;"><div style="font-size:24px;font-weight:900;font-style:italic;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHTML(pilot.name)}</div><div style="margin-top:5px;font-size:12px;font-weight:700;letter-spacing:.06em;color:#555b67;">POSITION <strong style="color:var(--c-accent);">${pilot.pos}</strong>&nbsp;&nbsp; KART <strong style="color:var(--c-accent);">${pilot.kart ?? '-'}</strong></div></div></div>
      <div style="border-radius:10px;background:#e6e8ec;padding:12px 14px;"><div style="font-size:11px;font-weight:800;letter-spacing:.08em;color:#606672;">RÉSUMÉ SESSION</div><div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:8px;font-size:12px;"><div>MEILLEUR TOUR<br><strong style="font-size:16px;color:var(--c-accent);">${pilot.bestLap != null ? fmtPdfTime(pilot.bestLap) : '--'}</strong></div><div>NOMBRE DE TOURS<br><strong style="font-size:16px;">${pilot.lapsCount}</strong></div><div>TEMPS TOTAL<br><strong>${pilot.hasTime ? fmtPdfTime(pilot.total) : '--'}</strong></div><div>SESSION<br><strong>${escapeHTML((sessionInfo && sessionInfo.title) || 'Course')}</strong></div></div></div>
    </div>
    <div style="display:flex;justify-content:space-between;align-items:end;border-top:1px solid #d2d5da;padding:12px 2px 10px;"><div><div style="font-size:22px;font-weight:900;font-style:italic;text-transform:uppercase;">${escapeHTML((sessionInfo && sessionInfo.circuit_name) || 'Circuit de Trinisette')}</div><div style="margin-top:4px;font-size:12px;color:#656a75;">${escapeHTML(fmtSessionDate(sessionInfo && sessionInfo.session_date))} · Résultats individuels</div></div><div style="font-size:11px;font-weight:800;color:var(--c-accent);letter-spacing:.08em;">TRINISETTE KARTING</div></div>
    <table style="width:100%;border-collapse:collapse;border:1px solid #d2d5da;font-size:12px;"><thead><tr style="background:#dfe1e5;color:#383d47;font-size:10px;letter-spacing:.04em;"><th style="padding:8px 6px;">TOUR</th><th style="padding:8px 6px;">TEMPS</th><th style="padding:8px 6px;">ÉCART</th>${sectorHeaders}</tr></thead><tbody>${rows}</tbody></table>${more}`;
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

    const container = document.createElement('div');
    container.style.cssText = 'display:flex;flex-direction:column;gap:16px;';

    container.appendChild(buildPilotDetailNode(pilot));

    const pageW = 210, pageH = 297, margin = 10;
    const usableW = pageW - margin * 2, usableH = pageH - margin * 2;
    const canvas = await sectionToCanvas(container, 760);
    const [r, g, b] = pdfBgRGB();
    pdf.setFillColor(r, g, b);
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
