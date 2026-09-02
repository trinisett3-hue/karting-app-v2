// Écran KIOSQUE (K-28) — page STAFF, jamais publique.
//
// Contrairement à results.html (page pilote/publique), cette page n'a AUCUN
// jeton dans l'URL : elle utilise le client Supabase normal, avec la session
// persistée de l'admin déjà connecté sur cette machine (voir lib/supabase.js —
// 'kiosk' n'est pas dans isPublicPage, donc client authentifié standard, comme
// admin.html). Personne de connecté sur ce navigateur = message et rien
// d'autre : jamais de repli anonyme, jamais de jeton à distribuer.
//
// Deux écrans, tous les deux rendus NATIVEMENT en HTML plein écran :
//
//   1) CLASSEMENT de la dernière session publiée (my_kiosk_ranking, v31).
//      Historique : cet écran affichait au départ le fichier classement.pdf
//      lui-même, dans un <embed>. Abandonné le 26/08 pour deux raisons de
//      fond, toutes deux visibles à l'œil nu sur une TV :
//        - le PDF est généré en A4 PORTRAIT (il est fait pour l'impression et
//          l'e-mail) ; sur un écran 16:9 il n'occupe qu'un tiers de la largeur,
//          avec deux bandes vides sur les côtés, et le texte tombe à une taille
//          illisible à plus de deux mètres ;
//        - le visionneur PDF de Chrome impose sa barre d'outils (télécharger,
//          imprimer, zoom) : #toolbar=0 n'est plus respecté depuis Chrome 90+.
//          Sur un écran d'accueil, un bouton « télécharger » n'a aucun sens.
//      Les CHIFFRES sont identiques à ceux du PDF : même source (laps +
//      session_registrations), même tri (meilleur tour croissant, sans-chrono
//      en dernier), même écart (meilleur tour - meilleur tour du leader) que
//      prepareSessionResults() dans public-results.js. Seule la mise en page
//      change, et c'est précisément ce qu'on veut : le PDF est fait pour du
//      papier, cet écran est fait pour une TV.
//
//   2) HALL OF FAME top 20 par catégorie (my_hall_of_fame_top20, v30).
//
// ?screen=rank ou ?screen=hof fige l'écran (utile quand le circuit a
// plusieurs TV) ; sans paramètre, les deux alternent. ?fs=1 demande le plein
// écran au chargement (posé par Paramètres > Kiosque).

import { db } from './lib/supabase.js';
import { kartAvatarSVG } from './modules/kart-avatar.js';
import { qrSVG } from './modules/qr.js';

// Le classement reste plus longtemps que le Hall of Fame : c'est lui que les
// pilotes qui descendent du kart viennent chercher.
const RANK_MS = 40000;
const HOF_MS = 25000;
const REFRESH_MS = 180000;  // ré-interrogation en mode écran fixe
const CAT_MS = 9000;        // rotation des catégories (Hall of Fame)
const PAGE_MS = 11000;      // rotation des pages (classement très fourni)

const root = document.getElementById('root');
const params = new URLSearchParams(window.location.search);
const SCREENS = ['rank', 'hof'];
const fixedScreen = SCREENS.includes(params.get('screen')) ? params.get('screen') : null;

// Catégorie courante du Hall of Fame. Volontairement AU NIVEAU DU MODULE et
// non dans renderHofScreen() : l'écran est re-rendu à chaque passage dans la
// rotation, et une variable locale repartait de zéro à chaque fois. Avec quatre
// catégories, un écran affiché 25 s et une rotation de 9 s, les deux dernières
// n'apparaissaient JAMAIS — on revoyait sans cesse les deux premières. Ici la
// rotation reprend là où elle s'était arrêtée.
let hofCatIdx = 0;
// Durée que le dernier rendu du Hall of Fame réclame : calculée pour laisser
// défiler toutes les catégories au moins une fois (voir renderHofScreen).
let hofScreenMs = HOF_MS;

// Un SEUL minuteur interne d'écran à la fois (rotation des catégories du Hall
// of Fame, ou des pages du classement). Bug corrigé le 26/08 : chaque rendu
// d'écran créait un setInterval sans annuler le précédent, et comme tick()
// re-rend toutes les 25-40s, les minuteurs s'empilaient — la rotation
// accélérait au fil des heures. Un seul minuteur nommé, toujours coupé avant
// d'en reposer un.
let subTimer = null;
function clearSubTimer() {
  if (subTimer) { clearInterval(subTimer); subTimer = null; }
}

/* ---------------------------------------------------------------- outils */

function escapeHTML(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function flagOf(nat) {
  const n = String(nat || '').trim().toUpperCase();
  const MAP = { FR: '🇫🇷', BE: '🇧🇪', CH: '🇨🇭', DE: '🇩🇪', ES: '🇪🇸', IT: '🇮🇹', GB: '🇬🇧', US: '🇺🇸', LU: '🇱🇺', NL: '🇳🇱', PT: '🇵🇹', MA: '🇲🇦', DZ: '🇩🇿', TN: '🇹🇳', CA: '🇨🇦' };
  return MAP[n] || '';
}

function fmtTime(sec) {
  const n = Number(sec);
  if (!Number.isFinite(n) || n <= 0) return '--';
  if (n >= 60) { const m = Math.floor(n / 60); return `${m}:${(n % 60).toFixed(3).padStart(6, '0')}`; }
  return n.toFixed(3);
}

function fmtGap(gap) {
  const n = Number(gap);
  if (!Number.isFinite(n)) return '';
  if (n <= 0) return '';
  return '+' + n.toFixed(3);
}

// Date d'un record en dd/mm/aaaa : chaque ligne du Hall of Fame est un record
// précis d'un pilote donné, la date complète a donc plus de sens qu'un mois.
function fmtDate(iso) {
  const d = iso ? new Date(iso) : null;
  if (!d || Number.isNaN(d.getTime())) return '';
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
}

// Date de session : « lundi 26 août », plus parlant sur un écran d'accueil
// qu'un 26/08/2026 administratif.
// Variante courte pour les tableaux serres : 26/08/26.
function fmtDateShort(iso) {
  const d = iso ? new Date(iso) : null;
  if (!d || Number.isNaN(d.getTime())) return '';
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getFullYear()).slice(2)}`;
}

function fmtSessionDate(dateStr) {
  if (!dateStr) return '';
  const d = new Date(String(dateStr).length <= 10 ? dateStr + 'T12:00:00' : dateStr);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });
}

// Heure courte (16h42) pour le pied de page : sur un ecran qui tourne en
// continu, savoir a quand remonte le dernier rafraichissement vaut mieux que
// de repeter la date de session, deja affichee dans le bandeau.
function fmtClock(d = new Date()) {
  return `${String(d.getHours()).padStart(2, '0')}h${String(d.getMinutes()).padStart(2, '0')}`;
}

// Les inscrits non identifiés s'appellent « Unknown #3050 » en base. Tel quel
// sur une TV vue par les clients, ça fait bâclé : on affiche le kart, qui est
// l'identifiant que le pilote a réellement sous les yeux pendant la course.
// Classe de taille selon la longueur du nom : plutot que de tronquer, on
// reduit. Les seuils sont volontairement bas — le nom partage sa colonne avec
// un drapeau, et une TV se regarde de loin.
// Cartes du podium : trois crans, le dernier passe sur deux lignes.
function podNameCls(name, pos) {
  const n = String(name || '').length;
  const lim = pos === 1 ? [13, 22] : [15, 24];
  return n > lim[1] ? ' xlong' : n > lim[0] ? ' long' : '';
}

function nameCls(name, twoCols) {
  const n = String(name || '').length;
  const lim = twoCols ? [13, 18, 26] : [20, 27, 34];
  return n > lim[2] ? ' n3' : n > lim[1] ? ' n2' : n > lim[0] ? ' n1' : '';
}

function pilotName(r) {
  const raw = String(r.pilot || '').trim();
  if (r.unknown || !raw || /^unknown/i.test(raw)) return r.kart != null ? `Kart ${r.kart}` : 'Pilote';
  return raw;
}

/* ------------------------------------------------------------- le thème */
// Mêmes tokens que results.html (Paramètres > Apparence) : le kiosque porte
// l'habillage choisi par le circuit, jamais un fond neutre indépendant.
const KIOSK_THEMES = {
  classic:   { bg: '#050608', bg2: '#0d0f14', text: '#f4f5f8', muted: '#7a7d8a', accent: '#ff2a2a', accent2: '#ff5555' },
  neon:      { bg: '#060810', bg2: '#0b0e18', text: '#f0f4ff', muted: '#6a7a9a', accent: '#00d4ff', accent2: '#ff0080' },
  carbon:    { bg: '#111214', bg2: '#181a1e', text: '#f5f0e8', muted: '#8a8880', accent: '#c9a84c', accent2: '#a0a0a0' },
  checkered: { bg: '#08090b', bg2: '#101114', text: '#f7f6f2', muted: '#9a9a94', accent: '#ece8dd', accent2: '#c9a35d' },
  endurance: { bg: '#03050b', bg2: '#070a17', text: '#eef1fb', muted: '#7580a6', accent: '#ffb238', accent2: '#4fb2ff' },
  pitlane:   { bg: '#0a0b0b', bg2: '#131613', text: '#f6f4ea', muted: '#8d8f80', accent: '#f0c419', accent2: '#ff6a1f' },
  champagne: { bg: '#0c0a07', bg2: '#161009', text: '#f8f1e3', muted: '#a4937b', accent: '#d9b978', accent2: '#f4e3ba' },
  arctic:    { bg: '#f4f6f9', bg2: '#ffffff', text: '#11131c', muted: '#565c72', accent: '#1a6fbd', accent2: '#0c4a86' },
};

// Luminance approchee d'une couleur hex : sert a savoir si le theme est clair.
function isLight(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ''));
  if (!m) return false;
  const n = parseInt(m[1], 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 > 0.55;
}

function applyTheme(themeKey) {
  const t = KIOSK_THEMES[themeKey] || KIOSK_THEMES.classic;
  const s = document.documentElement.style;
  // Or / argent / bronze : les teintes claires (pensees pour un fond sombre)
  // deviennent illisibles sur le theme clair (arctic). On bascule sur des
  // versions assombries des memes metaux.
  const light = isLight(t.bg);
  s.setProperty('--gold', light ? '#a9791a' : '#ffd166');
  s.setProperty('--silver', light ? '#6b7684' : '#cfd8e3');
  s.setProperty('--bronze', light ? '#9a5a24' : '#d98a4a');
  s.setProperty('--k-bg', t.bg);
  s.setProperty('--k-bg2', t.bg2);
  s.setProperty('--k-text', t.text);
  s.setProperty('--k-muted', t.muted);
  s.setProperty('--accent', t.accent);
  s.setProperty('--accent-2', t.accent2);
}

// Même moteur d'avatars que partout ailleurs (public-results.js, exports PDF,
// admin) : le vrai kart illustré (24 vignettes dessinées à la main). Photo du
// pilote en priorité quand elle existe.
function avatarHTML(photo, kart, scheme) {
  if (photo) return `<img src="${escapeHTML(photo)}" alt="" loading="lazy" onerror="this.style.display='none'">`;
  return kartAvatarSVG(kart, { scheme, title: kart != null ? `Kart ${kart}` : '' });
}

let sessionTypeLabels = {};
function typeLabel(type) {
  const t = String(type || '').trim();
  if (!t) return 'Records';
  // Libellé tel que le circuit l'a écrit dans Paramètres > Sessions
  // (« endurance_2h » -> « Endurance 2h »). Repli propre si le type n'y est
  // plus : on remet les espaces à la place des underscores.
  if (sessionTypeLabels[t]) return sessionTypeLabels[t];
  const clean = t.replace(/[_-]+/g, ' ');
  return clean.charAt(0).toUpperCase() + clean.slice(1);
}

const TROPHY_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M8 21h8M12 17v4M7 4h10v4a5 5 0 0 1-10 0V4z"/><path d="M7 6H4a1 1 0 0 0-1 1c0 2.5 1.8 4.5 4.2 4.9M17 6h3a1 1 0 0 1 1 1c0 2.5-1.8 4.5-4.2 4.9"/></svg>';
const BOLT_SVG = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M13 2 4.5 13.5H11l-1 8.5 8.5-11.5H12l1-8.5z"/></svg>';

async function getTenantHeader() {
  const { data } = await db.from('app_settings').select('value').eq('key', 'global').maybeSingle();
  const v = (data && data.value) || {};
  // Table de correspondance valeur -> libellé, alimentée à chaque lecture des
  // réglages : le circuit peut renommer ses catégories quand il veut.
  const map = {};
  (Array.isArray(v.session_types) ? v.session_types : []).forEach((t) => {
    if (t && t.v) map[String(t.v)] = String(t.l || t.v);
  });
  sessionTypeLabels = map;
  return { circuitName: v.circuit_name || '', logoUrl: v.logo_url || null, theme: v.results_theme || 'classic' };
}

// En-tête commun aux deux écrans — logo du circuit SUR LE CÔTÉ droit, comme
// sur la page 1 de results.html.
function headHTML(header, title, subHTML) {
  return `<div class="k-head">
    <div class="k-head-txt">
      <div class="k-eyebrow">${escapeHTML(header.circuitName || '')}</div>
      <h1 class="k-title">${escapeHTML(title)}</h1>
      ${subHTML ? `<p class="k-sub">${subHTML}</p>` : ''}
    </div>
    ${header.logoUrl ? `<img class="k-logo" src="${escapeHTML(header.logoUrl)}" alt="" onerror="this.remove()">` : ''}
  </div>`;
}

function emptyHTML(title, msg) {
  return `<div class="k-empty"><strong>${escapeHTML(title)}</strong>${escapeHTML(msg)}</div>`;
}

/* ------------------------------------------- ÉCRAN 1 — CLASSEMENT (v31)
   Mise en page reprise du PDF PAYSAGE du projet (public-results.js,
   .pdfx-page.landscape) : bandeau, colonne podium à gauche, tableau du
   classement complet à droite, pied de page. Le tableau reprend exactement les
   colonnes du PDF (Pos / Pilote / Kart / Tours / Meilleur tour / Écart) et,
   comme lui, liste TOUS les pilotes — le podium de gauche est un rappel, pas
   une soustraction. */

// QR vers le classement public de CETTE session : le pilote scanne l'écran en
// sortant de piste et repart avec ses chronos et son PDF sur son téléphone.
function qrBlockHTML(token) {
  if (!token) return '';
  const url = window.location.origin + '/results.html?result=' + encodeURIComponent(token);
  let svg = '';
  try { svg = qrSVG(url, '#0a0a0a', '#ffffff'); } catch (e) { return ''; }
  return `<div class="rk-qr">
    <div class="rk-qr-img">${svg}</div>
    <div class="rk-qr-lbl">Tes chronos<span>scanne ce code</span></div>
  </div>`;
}

function podiumHTML(rows) {
  return rows.map(r => {
    const name = pilotName(r);
    const showKart = r.kart != null && !/^Kart /.test(name);
    return `
    <div class="pod p${r.pos}">
      <div class="pod-rank">${r.pos}</div>
      <div class="pod-av">${avatarHTML(r.photo, r.kart, r.scheme)}</div>
      <div class="pod-info">
        <div class="pod-name${podNameCls(name, r.pos)}">${escapeHTML(name)}</div>
        <div class="pod-time">${fmtTime(r.best_lap)}</div>
        <div class="pod-meta">
          ${showKart ? `<span>Kart <b>${r.kart}</b></span>` : ''}
          <span>Tours <b>${r.laps_count || 0}</b></span>
          ${r.pos > 1 && r.gap != null ? `<span>Écart <b>${fmtGap(r.gap)}</b></span>` : ''}
        </div>
      </div>
    </div>`;
  }).join('');
}

const RANK_HEAD_HTML = `<div class="rk-head">
  <span class="c"></span><span></span><span>Pilote</span>
  <span class="c">Kart</span><span class="c">Tours</span><span class="c">Meill. tour</span><span class="c">Écart</span>
</div>`;

function rankRowHTML(r, twoCols) {
  const name = pilotName(r);
  const team = r.team_name
    ? `<span class="rk-team" style="color:${escapeHTML(r.team_color || 'inherit')}">${escapeHTML(r.team_name)}</span>` : '';
  return `<div class="rk-row${r.pos <= 3 ? ' top3' : ''}${r.has_time ? '' : ' no-time'}">
    <div class="rk-pos">${r.pos}</div>
    <div class="rk-av">${avatarHTML(r.photo, r.kart, r.scheme)}</div>
    <div class="rk-name${nameCls(name, twoCols)}">${flagOf(r.nat) ? `<span class="rk-flag">${flagOf(r.nat)}</span>` : ''}${escapeHTML(name)}${team}</div>
    <div class="rk-kart">${r.kart ?? '-'}</div>
    <div class="rk-laps">${r.has_time ? (r.laps_count || 0) : '--'}</div>
    <div class="rk-best">${fmtTime(r.best_lap)}</div>
    <div class="rk-gap">${r.has_time ? (fmtGap(r.gap) || '—') : '--'}</div>
  </div>`;
}

async function renderRankScreen() {
  clearSubTimer();
  root.innerHTML = `<div class="k-head"><div class="k-head-txt"><div class="k-eyebrow">Chargement…</div></div></div>`;

  const [{ data, error }, header] = await Promise.all([
    db.rpc('my_kiosk_ranking'),
    getTenantHeader(),
  ]);
  applyTheme(header.theme);

  if (error || !data) {
    root.innerHTML = headHTML(header, 'Classement', '') + emptyHTML('Classement indisponible', 'Impossible de lire les résultats pour le moment.');
    return false;
  }

  const session = data.session || null;
  const rows = Array.isArray(data.rows) ? data.rows : [];
  // Pas encore de session publiée : on le dit clairement, et tick() enchaînera
  // sur le Hall of Fame plutôt que de laisser une TV sur un écran mort.
  if (!session || !rows.length) {
    root.innerHTML = headHTML(header, 'Classement', '') +
      emptyHTML('Aucune course publiée', 'Le classement s’affichera ici dès la première session publiée.');
    return false;
  }

  const podium = rows.slice(0, 3);
  const recordHolder = rows.find(r => r.is_record && r.has_time);
  const dateTxt = fmtSessionDate(session.session_date);

  // Découpage : une colonne jusqu'à 14 pilotes, deux au-delà, et pagination
  // quand même deux colonnes ne suffisent plus (28 lignes visibles à la fois).
  const PER_PAGE = 28;
  const pages = [];
  for (let i = 0; i < rows.length; i += PER_PAGE) pages.push(rows.slice(i, i + PER_PAGE));

  let page = 0;
  const paint = () => {
    const list = pages[page] || [];
    const nCols = list.length > 14 ? 2 : 1;
    const perCol = Math.ceil(list.length / nCols);
    const cols = [];
    for (let i = 0; i < nCols; i++) cols.push(list.slice(i * perCol, (i + 1) * perCol));
    const dens = perCol <= 6 ? ' airy' : perCol > 11 ? ' dense' : '';
    const pageTag = pages.length > 1 ? ` · page ${page + 1}/${pages.length}` : '';

    root.innerHTML = `<div id="screen-rank">
      <div class="rk-band">
        <div class="rk-band-left">
          <div class="rk-circuit">${escapeHTML(header.circuitName || 'Classement')}</div>
          <div class="rk-session">Classement complet${session.title ? ' — ' + escapeHTML(session.title) : ''}</div>
        </div>
        ${header.logoUrl ? `<img class="rk-band-logo" src="${escapeHTML(header.logoUrl)}" alt="" onerror="this.remove()">` : ''}
        <div class="rk-band-right">
          <div class="rk-band-date">${escapeHTML(dateTxt)}</div>
          <div class="rk-band-count">${rows.length} pilote${rows.length > 1 ? 's' : ''}${pageTag}</div>
        </div>
      </div>
      <div class="rk-body">
        <div class="rk-pod-col">
          <div class="rk-sect">Podium</div>
          ${podiumHTML(podium)}
          ${qrBlockHTML(session.results_token)}
        </div>
        <div class="rk-table">
          <div class="rk-sect">Classement complet</div>
          <div class="rk-cols${dens}" style="grid-template-columns:repeat(${nCols},minmax(0,1fr))">
            ${cols.map(c => `<div class="rk-colblock">${RANK_HEAD_HTML}<div class="rk-rows">${c.map(r => rankRowHTML(r, nCols > 1)).join('')}</div></div>`).join('')}
          </div>
        </div>
      </div>
      <div class="rk-foot">
        <span class="rk-brand">Trinisette</span>
        ${recordHolder ? `<span class="rk-record">${BOLT_SVG}Record de piste — ${escapeHTML(pilotName(recordHolder))} · ${fmtTime(recordHolder.best_lap)}</span>` : '<span></span>'}
        <span>Actualisé à <b>${escapeHTML(fmtClock())}</b></span>
      </div>
    </div>`;
  };
  paint();

  if (pages.length > 1) {
    subTimer = setInterval(() => { page = (page + 1) % pages.length; paint(); }, PAGE_MS);
  }
  return true;
}

/* ------------------------------------------ ÉCRAN 2 — HALL OF FAME (v30)
   Exactement la même charpente que l'écran classement (bandeau, colonne de
   gauche, tableau, pied) : les deux écrans doivent se ressembler quand ils
   alternent sur la même TV. Seul le contenu change — ici les meilleurs chronos
   de tous les temps, par catégorie, au lieu de la dernière course. */

const HOF_HEAD_HTML = `<div class="rk-head">
  <span class="c"></span><span></span><span>Pilote</span>
  <span class="c">Kart</span><span class="c">Date</span><span class="c">Meill. tour</span>
</div>`;

function hofRowHTML(r, twoCols) {
  const name = pilotName({ pilot: r.pilot, kart: r.kart });
  return `<div class="rk-row${r.pos <= 3 ? ' top3' : ''}">
    <div class="rk-pos">${r.pos}</div>
    <div class="rk-av">${avatarHTML(r.photo, r.kart, r.scheme)}</div>
    <div class="rk-name${nameCls(name, twoCols)}">${flagOf(r.nat) ? `<span class="rk-flag">${flagOf(r.nat)}</span>` : ''}${escapeHTML(name)}</div>
    <div class="rk-kart">${r.kart ?? '-'}</div>
    <div class="rk-date">${escapeHTML(fmtDateShort(r.achieved_at))}</div>
    <div class="rk-best">${fmtTime(r.lap_time_s)}</div>
  </div>`;
}

function hofPodiumHTML(rows) {
  return rows.map(r => {
    const name = pilotName({ pilot: r.pilot, kart: r.kart });
    const showKart = r.kart != null && !/^Kart /.test(name);
    return `
    <div class="pod p${r.pos}">
      <div class="pod-rank">${r.pos}</div>
      <div class="pod-av">${avatarHTML(r.photo, r.kart, r.scheme)}</div>
      <div class="pod-info">
        <div class="pod-name${podNameCls(name, r.pos)}">${escapeHTML(name)}</div>
        <div class="pod-time">${fmtTime(r.lap_time_s)}</div>
        <div class="pod-meta">
          ${showKart ? `<span>Kart <b>${r.kart}</b></span>` : ''}
          <span>Le <b>${escapeHTML(fmtDate(r.achieved_at))}</b></span>
        </div>
      </div>
    </div>`;
  }).join('');
}

async function renderHofScreen() {
  clearSubTimer();
  root.innerHTML = `<div class="k-head"><div class="k-head-txt"><div class="k-eyebrow">Chargement…</div></div></div>`;

  const [{ data: hof, error }, header] = await Promise.all([
    db.rpc('my_hall_of_fame_top20'),
    getTenantHeader(),
  ]);
  applyTheme(header.theme);

  if (error || !hof) {
    root.innerHTML = headHTML(header, 'Hall of Fame', '') + emptyHTML('Hall of Fame indisponible', 'Impossible de lire les records pour le moment.');
    return false;
  }

  const types = Array.isArray(hof.types) ? hof.types : [];
  if (!types.length) {
    root.innerHTML = headHTML(header, 'Hall of Fame', '') +
      emptyHTML('Aucun record enregistré', 'Publie une première session pour voir apparaître les meilleurs chronos.');
    return false;
  }

  // Le Hall of Fame reste affiché assez longtemps pour que TOUTES les
  // catégories du circuit défilent au moins une fois avant de rendre la main
  // au classement — sinon les dernières ne seraient jamais vues.
  hofScreenMs = Math.max(HOF_MS, types.length * CAT_MS);

  let idx = hofCatIdx % types.length;
  const paint = () => {
    const t = types[idx];
    const list = t.rows || [];
    const podium = list.slice(0, 3);
    const nCols = list.length > 14 ? 2 : 1;
    const perCol = Math.ceil(list.length / nCols);
    const cols = [];
    for (let i = 0; i < nCols; i++) cols.push(list.slice(i * perCol, (i + 1) * perCol));
    const dens = perCol <= 6 ? ' airy' : perCol > 11 ? ' dense' : '';

    root.innerHTML = `<div id="screen-rank">
      <div class="rk-band">
        <div class="rk-band-left">
          <div class="rk-circuit">${escapeHTML(header.circuitName || 'Hall of Fame')}</div>
          <div class="rk-session">Hall of Fame — Catégorie ${escapeHTML(typeLabel(t.session_type))}</div>
        </div>
        ${header.logoUrl ? `<img class="rk-band-logo" src="${escapeHTML(header.logoUrl)}" alt="" onerror="this.remove()">` : ''}
        <div class="rk-band-right">
          <div class="rk-band-date">Meilleurs chronos</div>
          <div class="rk-band-count">${list.length} pilote${list.length > 1 ? 's' : ''} classé${list.length > 1 ? 's' : ''}</div>
        </div>
      </div>
      <div class="rk-body">
        <div class="rk-pod-col">
          <div class="rk-sect">Les plus rapides</div>
          ${hofPodiumHTML(podium)}
          <div class="rk-top20">${TROPHY_SVG}<span>Top ${Math.min(20, list.length)}</span></div>
        </div>
        <div class="rk-table">
          <div class="rk-sect">Records — ${escapeHTML(typeLabel(t.session_type))}</div>
          <div class="rk-cols hof${nCols > 1 ? ' twocol' : ''}${dens}" style="grid-template-columns:repeat(${nCols},minmax(0,1fr))">
            ${cols.map(c => `<div class="rk-colblock">${HOF_HEAD_HTML}<div class="rk-rows">${c.map(r => hofRowHTML(r, nCols > 1)).join('')}</div></div>`).join('')}
          </div>
        </div>
      </div>
      <div class="rk-foot">
        <span class="rk-brand">Trinisette</span>
        <span></span>
        <span>Actualisé à <b>${escapeHTML(fmtClock())}</b></span>
      </div>
    </div>`;
  };
  paint();

  if (types.length > 1) {
    subTimer = setInterval(() => {
      idx = (idx + 1) % types.length;
      hofCatIdx = idx;   // mémorisé pour le prochain passage sur cet écran
      paint();
    }, CAT_MS);
  }
  return true;
}

/* --------------------------------------------------------- boucle écran */

/* ----------------------------------------------------------- plein écran
   Pourquoi un bouton et pas un plein écran automatique : l'API Fullscreen
   exige une activation utilisateur DANS le document qui la demande. Ouvrir
   kiosk.html depuis Paramètres avec ?fs=1 ne suffit pas — Chrome ne transmet
   pas l'activation du clic au nouvel onglet une fois qu'il a navigué, et la
   demande échoue en silence. C'était le cas de la première version : l'écran
   s'ouvrait dans un onglet normal, barre d'adresse comprise.

   Donc : on tente quand même au chargement (ça passe sur certaines
   configurations), et si ça ne passe pas, un bouton s'affiche. Un clic — ou la
   touche F, ou Entrée, ou un double-clic n'importe où — et l'écran est en
   plein écran pour de bon. Le bouton réapparaît si le staff en sort (Échap).

   Pour une TV allumée en permanence, le vrai réglage reste de lancer le
   navigateur en mode kiosque (chrome --kiosk <url>) : c'est expliqué dans
   Paramètres > Kiosque, avec la commande toute prête. */

function isFullscreen() {
  return !!(document.fullscreenElement || document.webkitFullscreenElement);
}

function goFullscreen() {
  const el = document.documentElement;
  const req = el.requestFullscreen || el.webkitRequestFullscreen;
  if (!req) return Promise.reject();
  try {
    const p = req.call(el);
    return (p && typeof p.then === 'function') ? p : Promise.resolve();
  } catch (e) {
    return Promise.reject(e);
  }
}

// Empêche la mise en veille de l'écran : une TV d'accueil qui s'éteint au bout
// de dix minutes ne sert à rien. Le verrou saute quand l'onglet passe en
// arrière-plan, on le reprend au retour.
let wakeLock = null;
async function keepAwake() {
  try {
    if (!('wakeLock' in navigator)) return;
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => { wakeLock = null; });
  } catch (e) { /* refusé (onglet caché, navigateur ancien) : sans conséquence */ }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && !wakeLock) keepAwake();
});

function syncFullscreenUI() {
  const on = isFullscreen();
  document.body.classList.toggle('is-fs', on);
  const btn = document.getElementById('fs-btn');
  if (btn) btn.hidden = on;
}

function setupFullscreen() {
  const btn = document.createElement('button');
  btn.id = 'fs-btn';
  btn.type = 'button';
  btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" aria-hidden="true">'
    + '<path d="M3 9V4h5M21 9V4h-5M3 15v5h5M21 15v5h-5"/></svg><span>Plein écran</span>';
  btn.addEventListener('click', () => { goFullscreen().then(keepAwake).catch(() => {}); });
  document.body.appendChild(btn);

  // Raccourcis : F, Entrée, ou double-clic n'importe où sur l'écran. Le staff
  // n'a pas forcément la souris sous la main devant une TV.
  document.addEventListener('keydown', (e) => {
    if (isFullscreen()) return;
    if (e.key === 'f' || e.key === 'F' || e.key === 'Enter') { goFullscreen().then(keepAwake).catch(() => {}); }
  });
  document.addEventListener('dblclick', () => {
    if (!isFullscreen()) goFullscreen().then(keepAwake).catch(() => {});
  });
  document.addEventListener('fullscreenchange', syncFullscreenUI);
  document.addEventListener('webkitfullscreenchange', syncFullscreenUI);

  // Tentative automatique : inoffensive, et elle passe sur certaines
  // configurations (navigateur déjà lancé en mode kiosque, par exemple).
  if (params.get('fs') === '1') {
    goFullscreen().then(keepAwake).catch(() => {});
  }
  syncFullscreenUI();
  keepAwake();
}

let current = 'hof'; // pour que le premier tick affiche le classement
let nextDelay = RANK_MS;

async function tick() {
  const screen = fixedScreen || (current === 'rank' ? 'hof' : 'rank');
  current = screen;
  window.__kioskCurrentScreen = screen;

  const ok = screen === 'rank' ? await renderRankScreen() : await renderHofScreen();

  // Repli utile : un écran vide ne doit pas monopoliser la TV. Si le
  // classement n'a rien à montrer (aucune session publiée) et qu'on est en
  // rotation, on enchaîne tout de suite sur le Hall of Fame au lieu
  // d'attendre 40 secondes devant un message.
  if (!ok && !fixedScreen) { nextDelay = 4000; return; }
  nextDelay = fixedScreen ? REFRESH_MS : (screen === 'rank' ? RANK_MS : hofScreenMs);
}

// Boucle à délai variable (les deux écrans n'ont pas la même durée) : un
// setTimeout ré-armé plutôt qu'un setInterval fixe.
async function loop() {
  await tick();
  setTimeout(loop, nextDelay);
}

async function main() {
  const { data: { session } } = await db.auth.getSession();
  if (!session) {
    root.innerHTML = `<div class="gate">
      <h1>Connexion requise</h1>
      <p>Cet écran affiche les données de ton circuit — il faut d'abord être connecté en tant qu'admin sur ce navigateur.</p>
      <p>Ouvre <code>admin.html</code>, connecte-toi, puis reviens sur cette page (<code>kiosk.html</code>).</p>
    </div>`;
    return;
  }
  setupFullscreen();
  loop();
}

// Exposé pour les tests automatisés (Playwright) uniquement : déclencher des
// cycles à la demande sans attendre les vrais délais. Sans effet en production.
if (typeof window !== 'undefined') window.__kioskTick = tick;

main();
