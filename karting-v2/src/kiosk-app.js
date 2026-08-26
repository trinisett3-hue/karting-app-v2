// Écran KIOSQUE (K-28, dernier mot du 25/08) — page STAFF, jamais publique.
// Contrairement à results.html (page pilote/publique), cette page n'a
// AUCUN jeton dans l'URL : elle utilise le client Supabase normal, avec
// la session persistée de l'admin déjà connecté sur cette machine (voir
// lib/supabase.js — 'kiosk' n'est pas dans isPublicPage, donc client
// authentifié standard, exactement comme admin.html). Si personne n'est
// connecté sur ce navigateur, l'écran affiche un message et rien d'autre
// — jamais de repli anonyme, jamais de jeton à distribuer.
//
// Deux écrans :
//   1) Le PDF classement.pdf de la dernière session publiée — LE MÊME
//      fichier que celui reçu par les pilotes (session_assets, kind=
//      'full_pdf'), affiché via une URL signée (bucket privé session-
//      exports, policy admin déjà en place — aucune nouvelle exposition).
//   2) Hall of Fame TOP 20 par catégorie (type de session), avec avatar,
//      nationalité et meilleur temps (my_hall_of_fame_top20(), v29).
//
// ?screen=pdf ou ?screen=hof fige l'écran (plusieurs TV différentes) ;
// sans paramètre, rotation entre les deux (30s), et l'écran Hall of Fame
// fait lui-même défiler les catégories (9s) sans recharger la page.

import { db } from './lib/supabase.js';
import { kartAvatarSVG } from './modules/kart-avatar.js';

const ROTATE_MS = 30000;   // alternance PDF <-> HOF quand aucun ?screen= n'est fixé
const REFRESH_MS = 180000; // re-vérifie la dernière session publiée / les records
const CAT_ROTATE_MS = 9000; // alternance entre catégories sur l'écran Hall of Fame

const root = document.getElementById('root');
const params = new URLSearchParams(window.location.search);
const fixedScreen = (params.get('screen') === 'pdf' || params.get('screen') === 'hof') ? params.get('screen') : null;

// Minuteur de rotation des catégories (écran HOF) — UNE seule instance à la
// fois. Bug corrigé : renderHofScreen() est ré-appelée toutes les 30s (mode
// rotation) ou 180s (écran fixe), et créait un nouveau setInterval à CHAQUE
// appel sans jamais annuler le précédent — la rotation des catégories
// accélérait au fil du temps (plusieurs minuteurs empilés qui tournent tous
// en parallèle) au lieu de rester à 9s. Un seul minuteur nommé, toujours
// coupé avant d'en reposer un.
let catTimer = null;
function clearCatTimer() {
  if (catTimer) { clearInterval(catTimer); catTimer = null; }
}

function escapeHTML(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function flagOf(nat) {
  const n = String(nat || '').trim().toUpperCase();
  const MAP = { FR: '🇫🇷', BE: '🇧🇪', CH: '🇨🇭', DE: '🇩🇪', ES: '🇪🇸', IT: '🇮🇹', GB: '🇬🇧', US: '🇺🇸', LU: '🇱🇺', NL: '🇳🇱', PT: '🇵🇹' };
  return MAP[n] || '';
}

function fmtTime(sec) {
  const n = Number(sec);
  if (!Number.isFinite(n) || n <= 0) return '--';
  if (n >= 60) { const m = Math.floor(n / 60); const s = (n % 60).toFixed(3).padStart(6, '0'); return `${m}:${s}`; }
  return `${n.toFixed(3)}s`;
}

// Date du record en dd/mm/aaaa : chaque ligne est un record précis d'un
// pilote donné (pas une moyenne du mois), la date complète a donc plus de
// sens qu'un simple "août 2026" qui gommerait l'info exacte.
function fmtDate(iso) {
  const d = iso ? new Date(iso) : null;
  if (!d || Number.isNaN(d.getTime())) return '';
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  return `${dd}/${mm}/${d.getFullYear()}`;
}

// ------------------------------------------------------------------
// Thème visuel — dérivé de app_settings.global.results_theme, EXACTEMENT
// les mêmes tokens que results.html (Paramètres > Apparence). Le kiosque
// ne doit jamais afficher un fond neutre indépendant de ce que le circuit
// a choisi pour sa page publique.
// ------------------------------------------------------------------
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

function applyTheme(themeKey) {
  const t = KIOSK_THEMES[themeKey] || KIOSK_THEMES.classic;
  const s = document.documentElement.style;
  s.setProperty('--k-bg', t.bg);
  s.setProperty('--k-bg2', t.bg2);
  s.setProperty('--k-text', t.text);
  s.setProperty('--k-muted', t.muted);
  s.setProperty('--accent', t.accent);
  s.setProperty('--accent-2', t.accent2);
}

// Même moteur d'avatars que partout ailleurs dans l'app (public-results.js,
// exports PDF, admin) : le vrai kart illustré (24 vignettes dessinées à la
// main), pas un simple rond de couleur — photo du pilote en priorité si elle
// existe, sinon l'avatar kart illustré correspondant au numéro/scheme.
function avatarHTML(photo, kart, scheme) {
  if (photo) {
    return `<img src="${escapeHTML(photo)}" alt="" loading="lazy" onerror="this.style.display='none'">`;
  }
  return kartAvatarSVG(kart, { scheme, title: kart != null ? `Kart ${kart}` : '' });
}

function typeLabel(type) {
  const t = String(type || '').trim();
  if (!t) return 'Records';
  return t.charAt(0).toUpperCase() + t.slice(1);
}

async function getTenantHeader() {
  const { data } = await db.from('app_settings').select('value').eq('key', 'global').maybeSingle();
  const v = (data && data.value) || {};
  return { circuitName: v.circuit_name || '', logoUrl: v.logo_url || null, theme: v.results_theme || 'classic' };
}

// ------------------------------------------------------------------
// ÉCRAN 1 — PDF classement complet (le même que celui reçu par les
// pilotes), dernière session publiée.
// ------------------------------------------------------------------
async function renderPdfScreen() {
  clearCatTimer();
  document.body.classList.remove('hof-bg');
  root.innerHTML = `<div class="k-head"><div class="k-eyebrow">Chargement…</div></div>`;

  const { data: sess, error: sErr } = await db
    .from('session_assets')
    .select('storage_path, created_at')
    .eq('kind', 'full_pdf')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (sErr || !sess) {
    root.innerHTML = `<div id="screen-pdf"><div class="pdf-empty">Aucun classement publié pour l'instant.</div></div>`;
    return false;
  }

  const { data: signed, error: uErr } = await db.storage
    .from('session-exports')
    .createSignedUrl(sess.storage_path, 3600);

  if (uErr || !signed || !signed.signedUrl) {
    root.innerHTML = `<div id="screen-pdf"><div class="pdf-empty">Impossible de charger le PDF (droits ou fichier manquant).</div></div>`;
    return false;
  }

  // #toolbar=0&view=FitH : plein écran sans barre d'outils, ajusté en
  // largeur — le PDF est généré en portrait (impression pilote) ; sur une
  // TV en paysage on le laisse centré à sa taille naturelle plutôt que de
  // le déformer, le fond blanc de la page reste visible autour.
  root.innerHTML = `<div id="screen-pdf"><embed id="pdf-frame" src="${signed.signedUrl}#toolbar=0&navpanes=0&view=FitH" type="application/pdf"></div>`;
  return true;
}

// ------------------------------------------------------------------
// ÉCRAN 2 — Hall of Fame top 20 par catégorie
// ------------------------------------------------------------------
async function renderHofScreen() {
  clearCatTimer();
  root.innerHTML = `<div class="k-head"><div class="k-eyebrow">Chargement…</div></div>`;

  const [{ data: hof, error: hErr }, header] = await Promise.all([
    db.rpc('my_hall_of_fame_top20'),
    getTenantHeader(),
  ]);

  if (hErr || !hof) {
    root.innerHTML = `<div id="screen-hof"><div class="hof-empty">Hall of Fame indisponible.</div></div>`;
    return false;
  }

  applyTheme(header.theme);

  const types = Array.isArray(hof.types) ? hof.types : [];
  if (!types.length) {
    root.innerHTML =
      headHTML(header, 'Hall of Fame', 'Aucun record enregistré pour l’instant.') +
      `<div id="screen-hof"><div class="hof-empty">Publie une première session pour voir apparaître le classement ici.</div></div>`;
    return true;
  }

  document.body.classList.add('hof-bg');

  let idx = 0;
  const paint = () => {
    const t = types[idx];
    const half = Math.ceil((t.rows || []).length / 2);
    const col1 = (t.rows || []).slice(0, half);
    const col2 = (t.rows || []).slice(half);
    const topCls = (pos) => pos === 1 ? ' top1' : pos === 2 ? ' top2' : pos === 3 ? ' top3' : '';
    // La date suit le nom SUR LA MÊME LIGNE (pas empilée sous le temps) :
    // .hof-main est en ligne, le nom prend sa largeur naturelle et la date
    // va chercher tout l'espace qui restait inutilisé jusqu'au temps
    // (margin-left:auto côté CSS) — rien n'est ajouté en hauteur.
    const colHTML = (list) => list.map(r => `
      <div class="hof-row${topCls(r.pos)}">
        <div class="hof-rank">${r.pos}</div>
        <div class="hof-av-ring"><div class="hof-av">${avatarHTML(r.photo, r.kart, r.scheme)}</div></div>
        <div class="hof-main">
          <div class="hof-name"><span class="hof-flag">${flagOf(r.nat)}</span>${escapeHTML(r.pilot || 'Pilote')}</div>
          <div class="hof-date">${escapeHTML(fmtDate(r.achieved_at))}</div>
        </div>
        <div class="hof-time">${fmtTime(r.lap_time_s)}</div>
      </div>`).join('');
    // Plus d'onglets "LOISIR / COMPET" en dessous — juste la catégorie
    // active nommée dans l'en-tête ("Catégorie : Loisir"), et un bandeau
    // "TOP 20" à la place des anciens onglets, en gros avec le trophée :
    // c'est le concept de l'écran qui doit sauter aux yeux, pas la liste
    // des catégories du circuit.
    root.innerHTML =
      headHTML(header, 'Hall of Fame', 'Catégorie : ' + typeLabel(t.session_type)) +
      TOP20_BANNER +
      `<div id="screen-hof"><div class="hof-grid"><div class="hof-col">${colHTML(col1)}</div><div class="hof-col">${colHTML(col2)}</div></div></div>`;
  };
  paint();

  if (types.length > 1) {
    catTimer = setInterval(() => { idx = (idx + 1) % types.length; paint(); }, CAT_ROTATE_MS);
  }
  return true;
}

// En-tête — adapté du header de la page 1 de results.html (.circuit-header) :
// carte encadrée, glow d'accent, tirets décoratifs en haut-gauche, équerre en
// haut-droite, logo posé SUR LE CÔTÉ (coin haut-droit, comme sur results.html)
// et non au-dessus en pleine largeur.
function headHTML(header, title, sub) {
  return `<div class="k-head">
    ${header.logoUrl ? `<img class="k-logo" src="${escapeHTML(header.logoUrl)}" alt="" onerror="this.remove()">` : ''}
    <div class="k-eyebrow">${escapeHTML(header.circuitName || '')}</div>
    <h1 class="k-title">${escapeHTML(title)}</h1>
    ${sub ? `<p class="k-sub">${escapeHTML(sub)}</p>` : ''}
  </div>`;
}

const TROPHY_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M8 21h8M12 17v4M7 4h10v4a5 5 0 0 1-10 0V4z"/><path d="M7 6H4a1 1 0 0 0-1 1c0 2.5 1.8 4.5 4.2 4.9M17 6h3a1 1 0 0 1 1 1c0 2.5-1.8 4.5-4.2 4.9"/></svg>';
// Bandeau "TOP 20" — remplace les anciens onglets LOISIR/COMPET : le nom de
// la catégorie active est déjà dans l'en-tête ("Catégorie : …"), ici c'est
// uniquement le concept de l'écran qu'on veut voir de loin.
const TOP20_BANNER = `<div class="k-top20">${TROPHY_SVG}<span>Top 20</span></div>`;

// ------------------------------------------------------------------
// Boucle principale
// ------------------------------------------------------------------
async function tick() {
  let screen = fixedScreen;
  if (!screen) {
    screen = (window.__kioskCurrentScreen === 'pdf') ? 'hof' : 'pdf';
  }
  window.__kioskCurrentScreen = screen;

  if (screen === 'pdf') await renderPdfScreen();
  else await renderHofScreen();
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

  await tick();
  const delay = fixedScreen ? REFRESH_MS : ROTATE_MS;
  setInterval(tick, delay);
}

// Exposé uniquement pour les tests automatisés (Playwright) : permet de
// déclencher des cycles tick() à la demande sans attendre ROTATE_MS/
// REFRESH_MS en conditions réelles, pour vérifier qu'aucun minuteur ne
// s'accumule d'un cycle à l'autre. Ne fait rien d'autre en production.
if (typeof window !== 'undefined') window.__kioskTick = tick;

main();
