// Module d'inscription publique (register.html) — accès par QR code / lien, sans auth.
//
// 🔧 v13 : formulaire à une seule étape, étape photo retirée (réservée à une
// offre future Compétition/Séminaires — voir session_type).
//
// 🆕 v14 : identité pilote GLOBALE (plateforme-entière, pseudo unique,
// cross-tenant) + choix d'avatar par session. Le formulaire à une étape de
// v13 devient 3 écrans :
//   0  — choix « 1ère fois sur ce circuit » / « déjà pilote sur ce circuit »
//   1a — création du profil pilote (pseudo/prénom/nom/email/naissance) via
//        register_new_pilot() — le pseudo est LE seul identifiant public
//        (display_name), jamais l'email ni le nom réel.
//   1b — recherche du profil existant par email OU pseudo via
//        find_pilot_by_query() (ne renvoie jamais l'email : un visiteur qui
//        ne connaît que le pseudo d'un pilote ne peut pas en déduire son
//        adresse).
//   2  — écran de session existant (nationalité) + NOUVEAU carrousel
//        d'avatar (session_taken_avatars() exclut ceux déjà pris pour CETTE
//        session ; avatar_scheme est ensuite envoyé avec l'inscription).
// Dans les deux cas (1a et 1b), pilot_id est connu avant l'écran 2 : c'est
// lui qui alimente session_registrations.pilot_id, et un trigger serveur
// (fill_registration_from_pilot) recopie first_name/last_name/email depuis
// `pilots` à l'insertion — le front n'a donc JAMAIS besoin de connaître ou
// de transmettre l'email du pilote à l'écran 1b.
//
// Le pack d'avatars (classic/signature) affiché dans le carrousel n'est
// JAMAIS décidé ici : public_registration_config() relaie tel quel ce que
// private.avatar_config(tenant_id) a déjà tranché côté serveur (Premium ou pas),
// exactement comme le fait déjà site-config.js pour results.html.
import { db } from '../lib/supabase.js';
import { kartAvatarSVG } from './kart-avatar.js';
import {
  configureSignatureAvatars,
  wireSignatureAvatarFallback,
  signatureAvatarsActive,
  signatureAvatarHTML,
SIGNATURE_SCHEME_COUNT,
} from './signature-avatar.js';
import { NATS } from './countries.js';

// Nombre de vignettes du pack Classic (24 illustrations). Le pack Signature a
// SON PROPRE compteur (SIGNATURE_SCHEME_COUNT, 16 depuis le 30/07) : le
// carrousel doit utiliser l'un ou l'autre selon le pack actif, jamais 24 en
// dur, sinon les slots 16-23 en Signature rejoueraient les schemas 0-7 tout
// en étant comptés comme "distincts" par le suivi des avatars pris.
const AVATAR_COUNT = 24;

function avatarPoolSize() {
  return signatureAvatarsActive() ? SIGNATURE_SCHEME_COUNT : AVATAR_COUNT;
}

const regState = {
  selectedNat: 'FR',
  sessionId: null,
  registrationToken: null,
  // Pilote résolu (créé en 1a ou retrouvé/confirmé en 1b) : { id, pseudo }.
  pilot: null,
  // Candidat renvoyé par find_pilot_by_query(), en attente de confirmation
  // explicite avant de devenir regState.pilot (écran 1b).
  foundCandidate: null,
  // Schémas 0..23 encore disponibles pour CETTE session (déjà pris exclus).
  avatarPool: [],
avatarIndex: 0,
avatarReused: false,
};

// Validation email basique — suffisante pour un formulaire mobile, pas une
// vérification RFC complète (pas de vérification de délivrabilité côté front).
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Même règle que la contrainte SQL pilots_pseudo_format : lettres/chiffres/
// tiret/underscore/point uniquement, AUCUN accent, refusé net (pas de
// translittération silencieuse — demande explicite du client).
const PSEUDO_RE = /^[A-Za-z0-9_.-]+$/;

const FALLBACK_CONFIG = {
  avatar_pack: 'classic',
  avatar_type: 'kartpilot',
  avatar_small_type: 'helmet',
  avatar_outline: true,
  avatar_background: 'studio',
  circuit_name: null,
  logo_url: null,
  results_token: null,
};

// 🆕 v17 : la nationalité est demandée via un combobox réellement
// recherchable (la liste est amenée à s'allonger, un <select> natif devient
// vite pénible sur mobile).
// 🆕 v18 : le choix est désormais DÉFINITIF, porté par pilots.nationality
// (voir migration v18) — l'écran 1a (nouveau profil) reste le seul endroit
// où il est demandé systématiquement. L'écran 1b (profil retrouvé) ne le
// redemande QUE si find_pilot_by_query() renvoie nationality=null (profil
// créé avant v18) — dans ce cas, un combobox est injecté dynamiquement dans
// #search-result par renderFoundCard() ci-dessous, avec le suffixe
// "1bfound". La liste des instances actives n'est donc plus figée à
// ['1a','1b'] : on la déduit du DOM (activeNatSuffixes()) pour rester
// correcte quel que soit le combobox réellement présent à l'écran.
function natLabel(n) {
  return n.flag + ' ' + n.label;
}

function findNat(code) {
  return NATS.find((n) => n.code === code) || NATS[0];
}

function activeNatSuffixes() {
  return Array.from(document.querySelectorAll('[id^="nat-combo-"]')).map((el) => el.id.slice('nat-combo-'.length));
}

export function renderNats() {
  activeNatSuffixes().forEach((suffix) => {
    const input = document.getElementById('nat-search-' + suffix);
    if (!input) return;
    input.value = natLabel(findNat(regState.selectedNat));
    renderNatOptions(suffix, '');
  });
}

function renderNatOptions(suffix, query) {
  const dropdown = document.getElementById('nat-dropdown-' + suffix);
  if (!dropdown) return;
  const q = query.trim().toLowerCase();
  const matches = q
    ? NATS.filter((n) => n.label.toLowerCase().includes(q) || n.code.toLowerCase().includes(q))
    : NATS;
  dropdown.innerHTML = matches.length
    ? matches.map(
        (n) =>
          '<div class="nat-option' + (n.code === regState.selectedNat ? ' sel' : '') +
          '" data-code="' + n.code + '" onclick="natComboSelect(\'' + suffix + '\',\'' + n.code + '\')">' +
          n.flag + ' ' + n.label + '</div>'
      ).join('')
    : '<div class="nat-empty">Aucun pays trouvé</div>';
}

export function natComboOpen(suffix) {
  const dropdown = document.getElementById('nat-dropdown-' + suffix);
  if (!dropdown) return;
  const input = document.getElementById('nat-search-' + suffix);
  renderNatOptions(suffix, input && input.value === natLabel(findNat(regState.selectedNat)) ? '' : (input ? input.value : ''));
  dropdown.classList.add('open');
  if (!natComboOpen._wired) {
    natComboOpen._wired = true;
    document.addEventListener('click', (e) => {
      activeNatSuffixes().forEach((s) => {
        const combo = document.getElementById('nat-combo-' + s);
        if (combo && !combo.contains(e.target)) {
          const dd = document.getElementById('nat-dropdown-' + s);
          if (dd) dd.classList.remove('open');
        }
      });
    });
  }
}

export function natComboFilter(suffix) {
  const input = document.getElementById('nat-search-' + suffix);
  renderNatOptions(suffix, input ? input.value : '');
  const dropdown = document.getElementById('nat-dropdown-' + suffix);
  if (dropdown) dropdown.classList.add('open');
}

export function natComboSelect(suffix, code) {
  regState.selectedNat = code;
  activeNatSuffixes().forEach((s) => {
    const input = document.getElementById('nat-search-' + s);
    if (input) input.value = natLabel(findNat(code));
  });
  const dropdown = document.getElementById('nat-dropdown-' + suffix);
  if (dropdown) dropdown.classList.remove('open');
}

// Conservée pour compatibilité (ancien appel onchange direct sur un
// <select>) — plus utilisée par le HTML actuel mais inoffensive à garder.
export function selectNat(code) {
  regState.selectedNat = code;
}

function showMsg(id, msg, type) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = msg;
  el.className = 'msg ' + type;
}

function clearMsg(id) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = '';
  el.className = 'msg';
}

function showScreen(id) {
  document.querySelectorAll('.reg-screen').forEach((s) => s.classList.remove('active'));
  const el = document.getElementById(id);
  if (el) el.classList.add('active');
}

/**
 * Configuration publique (thème/logo/pack d'avatars) du circuit de cette
 * session. Jamais d'exception qui remonte : la page doit rester utilisable
 * (avatars classiques, sans logo) même si la RPC n'existe pas encore côté
 * base (migration v14 pas encore appliquée) ou si le token est invalide.
 */
async function loadRegistrationConfig(token) {
  if (!token) return FALLBACK_CONFIG;
  try {
    const res = await db.rpc('public_registration_config', { _registration_token: token });
    if (res.error) throw res.error;
    if (!res.data) return FALLBACK_CONFIG;
    return Object.assign({}, FALLBACK_CONFIG, res.data);
  } catch (e) {
    console.warn('[register] configuration publique indisponible — repli sur' +
      ' le thème et les avatars par défaut (migration v14 appliquée ?).', e);
    return FALLBACK_CONFIG;
  }
}

// 31/07 (correctif couleurs) : cette page avait un accent rouge fixe
// (--acc dans le <style> du haut), independant du theme choisi dans
// Parametres > Apparence, alors que la page resultats le suit (data-theme).
// Meme table de couleurs que resultats (public-results.js / initTheme MAP)
// tant que public_registration_config() ne relaie pas encore le theme —
// best effort : si cfg.results_theme est absent, rien ne change (repli rouge).
const THEME_TOKENS = {
  classic:   { acc: '#ff2a2a', acc2: '#ff6a4d', deep: '#c81e18' },
  neon:      { acc: '#00d4ff', acc2: '#5ce1ff', deep: '#0088aa' },
  carbon:    { acc: '#c9a84c', acc2: '#e0c476', deep: '#8f7529' },
  checkered: { acc: '#ece8dd', acc2: '#ffffff', deep: '#a9a396' },
  endurance: { acc: '#ffb238', acc2: '#ffcb73', deep: '#c47c12' },
  pitlane:   { acc: '#f0c419', acc2: '#ffdc5c', deep: '#b08c00' },
  champagne: { acc: '#d9b978', acc2: '#f0d7a4', deep: '#a1854a' },
  arctic:    { acc: '#1a6fbd', acc2: '#4f9fe0', deep: '#0d4a83' },
};

// 01/08 : toutes les teintes rouges ecrites en dur dans register.html ont ete
// remplacees par des derivations de --acc (color-mix). Il suffit donc de
// poser --acc / --acc2 / --acc-deep pour que TOUTE la page suive le theme
// choisi dans Parametres > Apparence. Aucune couleur n'est decidee par le
// code : elle vient de app_settings.global.results_theme.
function applyThemeAccent(themeKey) {
  const t = THEME_TOKENS[String(themeKey || '').trim()];
  if (!t) return;
  const r = document.documentElement.style;
  r.setProperty('--acc', t.acc);
  r.setProperty('--acc2', t.acc2);
  r.setProperty('--acc-deep', t.deep);
}

function applyCircuitBranding(cfg) {
  // 31/07 : le nom du circuit etait ecrit en dur dans les 4 en-tetes de cette
  // page. Il vient desormais TOUJOURS de Parametres > Identite du circuit
  // (app_settings.circuit_name, relaye par public_registration_config).
  const circuitName = String(cfg && cfg.circuit_name || '').trim() || 'Karting';
  document.querySelectorAll('.js-circuit-name').forEach(el => { el.textContent = circuitName; });
  document.title = 'Inscription — ' + circuitName;
  if (cfg && cfg.results_theme) applyThemeAccent(cfg.results_theme);
  const wrap = document.getElementById('circuit-logo-wrap');
  if (wrap) {
    wrap.innerHTML = cfg.logo_url
      ? '<img class="circuit-logo" src="' + cfg.logo_url + '" alt="' + (cfg.circuit_name || 'Circuit') + '">'
      : '';
  }
  // private.avatar_config() ne redescend jamais 'signature' pour un tenant
  // non entitled (voir commentaire de public_registration_config() dans la
  // migration v14) : le pack reçu ici EST déjà la décision commerciale.
  // 'entitled' n'a donc besoin d'être vrai que si le pack reçu est
  // 'signature' — inutile (et non fourni par cette RPC allégée) de le
  // redemander séparément.
  configureSignatureAvatars({
    pack: cfg.avatar_pack,
    type: cfg.avatar_type,
    small_type: cfg.avatar_small_type,
    outline: cfg.avatar_outline,
    background: cfg.avatar_background,
    entitled: cfg.avatar_pack === 'signature',
  });
  wireSignatureAvatarFallback();
  applyResultsNavLink(cfg);
}

// 🆕 QR code unique : un seul QR (register.html?session=TOKEN) doit permettre
// d'atteindre aussi bien l'inscription que les résultats de LA MÊME session.
// public_registration_config() relaie désormais sessions.public_results_token
// (clé 'results_token') — voir migration v28. Quand il est présent, le lien
// "Résultats" de la pilule de nav pointe vers cette session précise ; sinon
// (session sans résultats publiés — inscriptions encore ouvertes, aucun
// classement à montrer) il reste volontairement sur results.html nu plutôt
// que d'être masqué : le visiteur peut toujours cliquer et voir un message
// "aucun résultat" cohérent, moins déroutant qu'un lien qui disparaît.
function applyResultsNavLink(cfg) {
  // 31/07 (correctif navigation) : le jeton de circuit ?v= etait perdu au
  // changement d'onglet — on atterrissait sur "results.html" nu, sans aucune
  // information. Le circuit prime desormais sur la session : tant qu'on
  // connait ?v=, l'onglet Resultats renvoie vers le selecteur de sessions
  // terminees du circuit (meme lien, contenu qui se met a jour tout seul).
  const p = new URLSearchParams(window.location.search);
  const venueToken = p.get('v') || p.get('venue');
  let href = 'results.html';
  if (venueToken) href = 'results.html?v=' + encodeURIComponent(venueToken);
  else if (cfg && cfg.results_token) href = 'results.html?result=' + encodeURIComponent(cfg.results_token);
  const link = document.getElementById('nav-results-link');
  if (link) link.href = href;
  renderVenueTabs(href);
}

// La pilule flottante Inscription/Resultats chevauchait le titre : on la
// remplace par des onglets integres a l'entete, identiques a ceux de la page
// resultats (meme design, meme contrat de lien).
function renderVenueTabs(resultsHref) {
  const floatSwitch = document.querySelector('.page-switch');
  if (floatSwitch) floatSwitch.remove();
  const anchor = document.querySelector('#screen-0 .subtitle');
  if (!anchor) return;
  if (!document.getElementById('venue-tabs-css')) {
    document.head.insertAdjacentHTML('beforeend', `<style id="venue-tabs-css">
.venue-tabs{display:flex;gap:8px;justify-content:center;margin:16px 0 4px;padding-top:14px;border-top:1px solid rgba(255,255,255,.12)}
.venue-tabs a,.venue-tabs span{padding:8px 20px;border-radius:999px;font-size:13px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;text-decoration:none}
.venue-tabs a{background:rgba(255,255,255,.05);color:rgba(255,255,255,.55);border:1px solid rgba(255,255,255,.1)}
.venue-tabs a:hover{color:#fff}
.venue-tabs span{background:var(--acc,#ffb238);color:#0b0b0f}
</style>`);
  }
  let tabs = document.getElementById('venue-tabs');
  if (!tabs) {
    tabs = document.createElement('div');
    tabs.id = 'venue-tabs';
    tabs.className = 'venue-tabs';
    anchor.insertAdjacentElement('afterend', tabs);
  }
  tabs.innerHTML = '<span>Inscription</span><a href="' + resultsHref + '" id="nav-results-link">Résultats</a>';
}

/* ---------------------------------------------------------------------------
   SELECTEUR DE SESSION (31/07)
   Le staff peut ouvrir plusieurs sessions en meme temps, et il n'y a plus
   qu'un seul QR permanent pour le circuit (?v=<public_venue_token>) : le
   pilote doit donc pouvoir CHOISIR sa session. Les sessions ouvertes du jour
   viennent du RPC public_venue_sessions (SECURITY DEFINER, rien de nominatif).
   - ?session=TOKEN seul  -> comportement historique inchange (lien direct).
   - ?v=TOKEN             -> liste deroulante des sessions ouvertes.
   - les deux             -> session pre-selectionnee + possibilite d'en changer.
   -------------------------------------------------------------------------- */
/* ---------------------------------------------------------------------------
   ECRAN DE SELECTION DE SESSION (refonte 01/08)
   Le staff peut ouvrir plusieurs sessions en meme temps et il n'y a plus qu'un
   seul QR permanent par circuit (?v=<public_venue_token>) : le pilote doit
   donc CHOISIR sa session. Cet ecran est desormais AUTONOME — il ne reutilise
   plus l'entete du formulaire d'inscription — et partage exactement la meme
   grammaire visuelle que le selecteur de la page resultats (memes onglets,
   meme hero, memes lignes), pour que le passage d'un onglet a l'autre soit
   sans rupture. Donnees : RPC public_venue_sessions (SECURITY DEFINER, rien
   de nominatif, strictement limite au tenant porteur du jeton de circuit).
   -------------------------------------------------------------------------- */
const VENUE_CSS = `<style id="venue-pick-css">
.venue-wrap{max-width:34rem;margin:0 auto;padding:0 .25rem .5rem;text-align:left}
.venue-tabs{display:flex;justify-content:center;gap:.25rem;width:max-content;margin:.25rem auto 1.9rem;padding:.19rem;border:1px solid var(--bord);border-radius:999px;background:rgba(255,255,255,.04)}
.venue-tabs a,.venue-tabs span{padding:.5rem 1.4rem;border-radius:999px;font-family:var(--font-body);font-size:.75rem;font-weight:700;letter-spacing:.07em;text-transform:uppercase;text-decoration:none;color:var(--mut);transition:color .15s}
.venue-tabs a:hover{color:var(--txt)}
.venue-tabs span{background:var(--acc);color:var(--bg)}
.venue-hero{text-align:center;margin:0 0 1.75rem}
.venue-logo{width:3.25rem;height:3.25rem;border-radius:.9rem;margin:0 auto .85rem;display:flex;align-items:center;justify-content:center;font-size:1.5rem;background:var(--acc);color:var(--bg);overflow:hidden}
.venue-logo img{width:100%;height:100%;object-fit:cover;display:block}
.venue-circuit{font-size:.72rem;font-weight:700;letter-spacing:.22em;text-transform:uppercase;color:var(--acc);margin:0 0 .6rem}
.venue-title{font-family:var(--font-display);font-size:clamp(1.55rem,6vw,2.1rem);font-weight:700;line-height:1.1;text-transform:uppercase;margin:0 0 .35rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.venue-sub{margin:0;font-size:.85rem;line-height:1.5;color:var(--mut)}
.venue-row{display:flex;align-items:center;gap:.8rem;padding:.95rem 1.05rem;margin:0 0 .55rem;border:1px solid var(--bord);border-radius:.9rem;background:rgba(255,255,255,.03);text-decoration:none;color:inherit;transition:border-color .15s,transform .15s}
.venue-row:hover{border-color:var(--acc);transform:translateY(-1px)}
.venue-row.hot{border-color:color-mix(in srgb,var(--acc) 40%,transparent);background:color-mix(in srgb,var(--acc) 5%,transparent)}
.venue-tag{flex:0 0 auto;font-size:.63rem;font-weight:700;letter-spacing:.1em;text-transform:uppercase;padding:.38rem .55rem;border-radius:999px;background:rgba(255,255,255,.08);color:var(--mut);white-space:nowrap}
.venue-row.hot .venue-tag{background:var(--acc);color:var(--bg)}
.venue-txt{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:.19rem}
.venue-txt b{font-size:.95rem;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.venue-txt i{font-style:normal;font-size:.78rem;color:var(--mut);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.venue-chev{flex:0 0 auto;opacity:.4}
.venue-empty{padding:1.25rem;border:1px dashed var(--bord);border-radius:.9rem;font-size:.87rem;line-height:1.6;color:var(--mut);text-align:center}
.venue-note{margin:1.6rem 0 0;font-size:.75rem;line-height:1.6;color:var(--mut);opacity:.7;text-align:center}
</style>`;

let lastVenueName = '';

async function loadVenue(venueToken) {
  try {
    const { data, error } = await db.rpc('public_venue_sessions', { _venue_token: venueToken });
    if (error || !data) return null;
    lastVenueName = String(data.venue_name || '').trim();
    if (lastVenueName) {
      document.querySelectorAll('.js-circuit-name').forEach(el => { el.textContent = lastVenueName; });
      document.title = 'Inscription — ' + lastVenueName;
    }
    // Le theme suit Parametres > Apparence des l'ecran de selection, alors
    // qu'avant il ne s'appliquait qu'une fois une session choisie (la page
    // restait donc rouge, quelle que soit la configuration du circuit).
    if (data.results_theme) applyThemeAccent(data.results_theme);
    return data;
  } catch (e) { return null; }
}

function venueTime(iso) {
  if (!iso) return '';
  try { return new Date(iso).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }); }
  catch (e) { return ''; }
}

// 01/08 : plus de libelle "aujourd'hui / hier" — on affiche le nombre de
// participants deja inscrits, information utile au pilote qui choisit.
function venuePeople(n) {
  const v = Number(n || 0);
  if (!v) return 'Sois le premier inscrit';
  return v + (v > 1 ? ' inscrits' : ' inscrit');
}

function venueRow(href, tag, title, meta, hot) {
  return `<a class="venue-row${hot ? ' hot' : ''}" href="${href}">
<span class="venue-tag">${escapeHTML(tag)}</span>
<span class="venue-txt"><b>${escapeHTML(title)}</b><i>${escapeHTML(meta)}</i></span>
<svg class="venue-chev" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18l6-6-6-6"/></svg>
</a>`;
}

function venueHero(logoUrl, circuit, title, sub) {
  const logo = logoUrl
    ? '<img src="' + escapeHTML(logoUrl) + '" alt="">'
    : '<span aria-hidden="true">\u{1F3C1}</span>';
  return '<div class="venue-hero">' +
    '<div class="venue-logo">' + logo + '</div>' +
    (circuit ? '<div class="venue-circuit">' + escapeHTML(circuit) + '</div>' : '') +
    '<h1 class="venue-title">' + escapeHTML(title) + '</h1>' +
    (sub ? '<p class="venue-sub">' + escapeHTML(sub) + '</p>' : '') +
    '</div>';
}

// Prend entierement la main sur l'ecran 0 : le formulaire n'a rien a faire la
// tant qu'aucune session n'est choisie.
function renderVenueScreen(data, venueToken) {
  const host = document.getElementById('screen-0');
  if (!host) return;
  if (!document.getElementById('venue-pick-css')) {
    document.head.insertAdjacentHTML('beforeend', VENUE_CSS);
  }
  const floatSwitch = document.querySelector('.page-switch');
  if (floatSwitch) floatSwitch.remove();

  const resultsHref = 'results.html?v=' + encodeURIComponent(venueToken);
  const tabs = '<nav class="venue-tabs" aria-label="Navigation"><span>Inscription</span>' +
    '<a href="' + resultsHref + '" id="nav-results-link">Résultats</a></nav>';

  const open = (data && Array.isArray(data.open_sessions) ? data.open_sessions.slice() : []);
  // Ordre chronologique : la session qui part le plus tot en premier.
  open.sort((a, b) => String(a.starts_at || '').localeCompare(String(b.starts_at || '')));

  const rows = open.length
    ? open.map((s, i) => venueRow(
        'register.html?session=' + encodeURIComponent(s.registration_token) +
          '&v=' + encodeURIComponent(venueToken),
        i === 0 ? 'Prochaine' : 'Ouverte',
        s.title || 'Session',
        [venueTime(s.starts_at) ? 'départ ' + venueTime(s.starts_at) : '', venuePeople(s.participants)]
          .filter(Boolean).join(' · '),
        i === 0
      )).join('')
    : '<div class="venue-empty">Aucune session ouverte à l’inscription pour le moment.<br>Rescanne le QR du circuit un peu plus tard.</div>';

  host.innerHTML = VENUE_CSS + '<div class="venue-wrap">' + tabs +
    venueHero(data && data.logo_url, lastVenueName, 'Choisis ta session',
              'Inscris-toi à la session que tu vas courir.') +
    rows +
    '<p class="venue-note">Cette page se met à jour toute seule.<br>Garde-la en favori ou rescanne le QR du circuit.</p>' +
    '</div>';
  host.classList.remove('card');
}

export async function initRegisterPage() {
  const params = new URLSearchParams(window.location.search);
  const token = params.get('session');
  const venueToken = params.get('v') || params.get('venue');
  applyResultsNavLink(null);

  if (!token) {
    // Sans lien direct mais avec un jeton de circuit : ecran de selection
    // autonome. L'URL reste ?v=<circuit> (un seul lien permanent, contenu qui
    // evolue tout seul) et le formulaire d'inscription n'apparait pas encore.
    if (venueToken) {
      const data = await loadVenue(venueToken);
      if (!data) {
        document.getElementById('session-name').textContent = 'Lien invalide';
        return;
      }
      renderVenueScreen(data, venueToken);
      return;
    }
    document.getElementById('session-name').textContent = 'Lien invalide';
    return;
  }
  // Session pre-selectionnee : on charge quand meme le circuit pour appliquer
  // son theme et son nom des le premier rendu (sans attendre la config de
  // session), sans jamais reafficher le selecteur par-dessus le formulaire.
  if (venueToken) { loadVenue(venueToken); }
  regState.registrationToken = token;
  // Plus de lecture directe de public.sessions avec la cle anon : id et titre
  // viennent desormais du bundle RPC token-gated public_registration_config.
  const cfg = await loadRegistrationConfig(token);
  if (!cfg || !cfg.session_id) {
    document.getElementById('session-name').textContent = 'Session introuvable';
    return;
  }
  regState.sessionId = cfg.session_id;
  document.getElementById('session-name').textContent = cfg.session_title || '--';

  applyCircuitBranding(cfg);
}

/* -----------------------------------------------------------------------------
   ÉCRAN 0 — choix d'identité
   -------------------------------------------------------------------------- */

export function goFirstTime() {
  clearMsg('msg-0');
  showScreen('screen-1a');
}

export function goAlreadyPilot() {
  clearMsg('msg-0');
  showScreen('screen-1b');
}

export function backToScreen0() {
  regState.pilot = null;
  regState.foundCandidate = null;
  clearMsg('msg-1a');
  clearMsg('msg-1b');
  clearMsg('msg-2');
  showScreen('screen-0');
}

/* -----------------------------------------------------------------------------
   ÉCRAN 1a — première fois : création du profil pilote
   -------------------------------------------------------------------------- */

export async function createPilot() {
  clearMsg('msg-1a');
  const pseudo = document.getElementById('inp-name').value.trim();
  const firstName = document.getElementById('inp-firstname').value.trim();
  const lastName = document.getElementById('inp-lastname').value.trim();
  const email = document.getElementById('inp-email').value.trim();
  const birthdate = document.getElementById('inp-birthdate').value || null;

  if (!pseudo) { showMsg('msg-1a', 'Entre ton pseudo.', 'err'); return; }
  if (!PSEUDO_RE.test(pseudo)) {
    showMsg('msg-1a', "Pseudo invalide : pas d'accents, uniquement lettres/chiffres/tiret/underscore.", 'err');
    return;
  }
  if (!firstName) { showMsg('msg-1a', 'Entre ton prénom.', 'err'); return; }
  if (!lastName) { showMsg('msg-1a', 'Entre ton nom.', 'err'); return; }
  if (!email) { showMsg('msg-1a', 'Entre ton email.', 'err'); return; }
  if (!EMAIL_RE.test(email)) { showMsg('msg-1a', 'Email invalide.', 'err'); return; }

  const btn = document.getElementById('btn-create-pilot');
  btn.disabled = true; btn.textContent = 'Création…';
  try {
    const { data, error } = await db.rpc('register_new_pilot', {
      _first_name: firstName,
      _last_name: lastName,
      _email: email,
      _pseudo: pseudo,
      _birth_date: birthdate,
      // 🆕 v18 : figée définitivement sur le profil pilote dès la création —
      // plus jamais redemandée ensuite (voir migration v18).
      _nationality: regState.selectedNat,
      _registration_token: regState.registrationToken,
    });
    if (error) throw error;
    regState.pilot = { id: data, pseudo };
    await enterScreen2();
  } catch (e) {
    showMsg('msg-1a', e.message || 'Erreur lors de la création du profil.', 'err');
  } finally {
    btn.disabled = false; btn.textContent = 'Continuer';
  }
}

/* -----------------------------------------------------------------------------
   ÉCRAN 1b — déjà pilote : recherche par email ou pseudo
   -------------------------------------------------------------------------- */

export function escapeHTML(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

export async function searchPilot() {
  clearMsg('msg-1b');
  const query = document.getElementById('inp-search').value.trim();
  const resultEl = document.getElementById('search-result');
  if (!query) { showMsg('msg-1b', 'Entre ton email ou ton pseudo.', 'err'); return; }

  const btn = document.getElementById('btn-search-pilot');
  btn.disabled = true; btn.textContent = 'Recherche…';
  resultEl.innerHTML = '';
  try {
    const { data, error } = await db.rpc('find_pilot_by_query', { _query: query, _registration_token: regState.registrationToken });
    if (error) throw error;
    if (!data) {
      regState.foundCandidate = null;
      resultEl.innerHTML = '<div class="not-found-card">Aucun profil trouvé pour "' +
        escapeHTML(query) + '". Vérifie l\'orthographe, ou inscris-toi comme nouveau pilote.</div>';
      return;
    }
    regState.foundCandidate = data;
    // 🆕 v18 : la nationalité choisie à la première inscription est
    // définitive (voir migration v18) — on ne la redemande PAS ici. Le seul
    // cas où un champ reapparaît est un profil créé AVANT v18
    // (data.nationality === null) : on lui laisse la choisir une dernière
    // fois, et set_pilot_nationality_if_unset() la fige au moment de
    // confirmer (jamais réécrite ensuite, même via ce même écran).
    const needsNatPrompt = !data.nationality;
    const natFieldHTML = needsNatPrompt
      ? '<div class="field" style="margin-top:14px;text-align:left">' +
        '<label>🌍 Quel pays veux-tu représenter ?</label>' +
        '<div class="nat-combo" id="nat-combo-1bfound">' +
        '<input type="text" class="nat-search" id="nat-search-1bfound" placeholder="Rechercher un pays…" autocomplete="off" onfocus="natComboOpen(\'1bfound\')" oninput="natComboFilter(\'1bfound\')"/>' +
        '<div class="nat-dropdown" id="nat-dropdown-1bfound"></div>' +
        '</div>' +
        '<div class="hint">Profil créé avant l\'ajout de ce choix — il ne te sera plus jamais redemandé après.</div>' +
        '</div>'
      : '';
    resultEl.innerHTML =
      '<div class="pilot-found-card">' +
      '<div class="pilot-found-pseudo">🏁 ' + escapeHTML(data.pseudo) + '</div>' +
      '<div class="choice-sub">' + escapeHTML(data.first_name || '') + '</div>' +
      '</div>' +
      natFieldHTML +
      '<button type="button" class="btn btn-primary" onclick="confirmPilotFound()">C\'est moi, continuer</button>';
    if (needsNatPrompt) renderNats();
  } catch (e) {
    showMsg('msg-1b', e.message || 'Erreur lors de la recherche.', 'err');
  } finally {
    btn.disabled = false; btn.textContent = 'Rechercher';
  }
}

export async function confirmPilotFound() {
  if (!regState.foundCandidate) return;
  const candidate = regState.foundCandidate;
  regState.pilot = { id: candidate.id, pseudo: candidate.pseudo };
  if (candidate.nationality) {
    // Déjà fixée à une inscription précédente (ou à la création) : on la
    // reprend telle quelle, silencieusement — c'est tout le sens de la
    // demande "ne plus jamais redemander".
    regState.selectedNat = candidate.nationality;
  } else {
    // Profil pré-v18 : le combobox "1bfound" (voir searchPilot()) porte le
    // choix fait à l'instant dans regState.selectedNat — on la fige côté
    // serveur pour toutes les prochaines fois.
    try {
      await db.rpc('set_pilot_nationality_if_unset', { _pilot_id: candidate.id, _nationality: regState.selectedNat, _registration_token: regState.registrationToken });
    } catch (e) {
      // Non-bloquant : au pire on redemandera à la prochaine reconnexion —
      // ne doit jamais empêcher l'inscription du jour.
      console.warn('[register] set_pilot_nationality_if_unset a échoué — non bloquant.', e);
    }
  }
  await enterScreen2();
}

/* -----------------------------------------------------------------------------
   ÉCRAN 2 — session : nationalité + carrousel d'avatar
   -------------------------------------------------------------------------- */

async function enterScreen2() {
  clearMsg('msg-2');
  const sub = document.getElementById('screen2-sub');
  if (sub && regState.pilot) sub.textContent = 'Dernière étape, ' + regState.pilot.pseudo + ' !';
  showScreen('screen-2');
  await initAvatarCarousel();
}

async function initAvatarCarousel() {
const size = avatarPoolSize();
const all = Array.from({ length: size }, (_, i) => i);
let taken = [];
try {
const { data, error } = await db.rpc('session_taken_avatars', { _session_id: regState.sessionId, _registration_token: regState.registrationToken });
if (error) throw error;
taken = Array.isArray(data) ? data : [];
} catch (e) {
console.warn('[register] avatars pris introuvables - carrousel non filtre.', e);
}
regState.avatarPool = all.filter((i) => taken.indexOf(i) < 0);
if (!regState.avatarPool.length) {
// Tous les schemas distincts du pack actif sont deja pris pour cette
// session (plus de pilotes que de schemas disponibles) : on retombe sur
// la liste complete plutot que de bloquer l'inscription, avec un INDEX
// ALEATOIRE (decision produit du 30/07 - plus jamais index 0 systematique)
// et un flag qui declenche la notice explicite dans renderAvatarStage().
regState.avatarPool = all;
regState.avatarIndex = Math.floor(Math.random() * all.length);
regState.avatarReused = true;
} else {
regState.avatarIndex = 0;
regState.avatarReused = false;
}
renderAvatarStage();
}

function renderAvatarStage() {
const stage = document.getElementById('avatar-stage');
const status = document.getElementById('avatar-status');
if (!stage) return;
const scheme = regState.avatarPool[regState.avatarIndex];
stage.innerHTML = signatureAvatarsActive()
? signatureAvatarHTML(null, { scheme, size: 140 })
: kartAvatarSVG(null, { scheme, size: 140 });
if (status) {
if (regState.avatarReused) {
status.textContent = 'Tous les avatars uniques de cette session sont deja pris \u2014 le tien sera attribue au hasard parmi ceux qui existent deja (il pourra ressembler a celui d\'un autre pilote).';
} else {
status.textContent = (regState.avatarIndex + 1) + ' / ' + regState.avatarPool.length +
' disponibles \u2014 utilise les fleches pour changer';
}
}
const prevBtn = document.getElementById('avatar-prev');
const nextBtn = document.getElementById('avatar-next');
const single = regState.avatarPool.length <= 1;
if (prevBtn) prevBtn.disabled = single;
if (nextBtn) nextBtn.disabled = single;
}

export function avatarPrev() {
  if (!regState.avatarPool.length) return;
  regState.avatarIndex = (regState.avatarIndex - 1 + regState.avatarPool.length) % regState.avatarPool.length;
  renderAvatarStage();
}

export function avatarNext() {
  if (!regState.avatarPool.length) return;
  regState.avatarIndex = (regState.avatarIndex + 1) % regState.avatarPool.length;
  renderAvatarStage();
}

export async function submitForm() {
  if (!regState.sessionId) { showMsg('msg-2', 'Session invalide.', 'err'); return; }
  if (!regState.pilot) { showMsg('msg-2', 'Profil pilote manquant — retourne en arrière.', 'err'); return; }

  const btn = document.getElementById('btn-submit');
  btn.disabled = true; btn.textContent = 'Inscription en cours…';
  const chosenScheme = regState.avatarPool.length ? regState.avatarPool[regState.avatarIndex] : null;
  try {
    const { error } = await db.from('session_registrations').insert({
      session_id: regState.sessionId,
      pilot_id: regState.pilot.id,
      // display_name reste sous le contrôle exclusif du front (voir
      // fill_registration_from_pilot() dans la migration v14) : c'est le
      // pseudo, seul identifiant public — first_name/last_name/email sont
      // recopiés serveur-side depuis `pilots` via pilot_id, jamais envoyés
      // depuis ici (l'écran 1b ne les connaît d'ailleurs pas).
      display_name: regState.pilot.pseudo,
      nationality: regState.selectedNat,
      avatar_scheme: chosenScheme,
      driver_id: null,
      is_unknown: false,
    });
    if (error) throw error;
    document.getElementById('screen-2').classList.remove('active');
    document.getElementById('success-card').style.display = 'block';
    document.getElementById('success-name').textContent = 'Bonne course ' + regState.pilot.pseudo + ' !';
  } catch (e) {
    // Deux contraintes uniques distinctes peuvent lever un 23505 ici : il
        // faut les distinguer par leur nom, sinon un pilote qui tente de se
        // réinscrire une seconde fois se voit répondre « avatar déjà pris »,
        // ce qui n'a aucun sens et l'incite à retenter en boucle (bug A4/B28,
        // corrigé le 30/07 — la contrainte session_registrations_session_pilot_uidx
        // n'existait pas avant, donc les doublons passaient silencieusement).
        const constraint = (e && (e.details || e.message || '')) + '';
        if (e && e.code === '23505' && constraint.indexOf('session_pilot_uidx') !== -1) {
                showMsg('msg-2', 'Tu es déjà inscrit à cette session — inutile de t\'inscrire une seconde fois.', 'err');
        } else if (e && e.code === '23505') {
      // Collision sur (session_id, avatar_scheme) : un autre pilote vient de
      // prendre exactement le même avatar entre le chargement du carrousel
      // et la soumission. On rafraîchit la liste des disponibles et on
      // laisse le pilote réessayer, sans perdre le reste du formulaire.
      showMsg('msg-2', 'Cet avatar vient d\'être pris par un autre pilote — choisis-en un autre.', 'err');
      await initAvatarCarousel();
    } else {
      showMsg('msg-2', 'Erreur: ' + e.message, 'err');
    }
  } finally {
    btn.disabled = false; btn.textContent = "S'inscrire à la course 🏁";
  }
}
