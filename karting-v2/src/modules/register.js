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
import { teamBadgeHTML, teamLogoHTML } from './teams.js';
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
// Mode Ecurie. `teams` porte deja `taken` et `full` calcules par la RPC : on
// n'interroge jamais la base depuis ici pour savoir si une ecurie est pleine.
teamMode: false,
teamSizeMax: 2,
teams: [],
teamId: null,
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
  // Mode Ecurie : absent = desactive. Un circuit qui n'y a pas droit, ou une
  // base ou la migration n'est pas encore passee, retombe naturellement ici.
  team_mode: false,
  team_size_max: 2,
  teams: [],
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
 * En-tete de session (ancien bandeau vert). `label` est le petit libelle
 * au-dessus, `state` vaut 'error' pour repasser le bloc en rouge d'alerte.
 * Silencieux si le noeud n'existe pas (ecran de selection de circuit).
 */
function setSessionTitle(text, state, label) {
  const el = document.getElementById('session-name');
  if (!el) return;
  el.textContent = text;
  el.setAttribute('data-label', label || (state === 'error' ? 'Inscription' : 'Session'));
  if (state) el.setAttribute('data-state', state);
  else el.removeAttribute('data-state');
}

/* -----------------------------------------------------------------------------
   Consentements — CGV/CGU, confidentialite (RGPD) et opt-in promotionnel
   -----------------------------------------------------------------------------
   01/08 : les textes ci-dessous sont des GABARITS. Ils decrivent la structure
   attendue mais ne constituent pas des conditions juridiques : chaque circuit
   doit y coller ses propres CGV/CGU et sa politique de confidentialite (une
   entree Parametres > Mentions legales est prevue pour cela). Le mecanisme
   d'acceptation, lui, est bien reel : sans la case cochee, pas d'inscription,
   et l'horodatage part en base (session_registrations.consent_accepted_at).
   -------------------------------------------------------------------------- */
const LEGAL_DOCS = {
  cgv: {
    title: 'Conditions générales',
    html:
      '<h3>1. Objet</h3><p>Les présentes conditions encadrent l\'inscription à une session de karting organisée par le circuit et l\'utilisation du service de résultats en ligne.</p>' +
      '<h3>2. Inscription</h3><p>L\'inscription vaut engagement à respecter le règlement intérieur de la piste, les consignes du staff et les conditions d\'accès (âge, taille, équipement).</p>' +
      '<h3>3. Sécurité</h3><p>Le port des équipements fournis est obligatoire. Le circuit peut refuser ou interrompre la participation d\'un pilote dont le comportement met en danger les autres usagers.</p>' +
      '<h3>4. Résultats</h3><p>Les temps mesurés et le classement sont publiés sur la page de résultats de la session. Ils sont fournis à titre indicatif et peuvent être corrigés par le staff.</p>' +
      '<h3>5. Annulation</h3><p>Les conditions d\'annulation et de remboursement sont celles affichées à l\'accueil du circuit.</p>' +
      '<div class="legal-note">Texte de démonstration — le circuit renseignera ici ses propres conditions générales avant l\'ouverture au public.</div>',
  },
  rgpd: {
    title: 'Confidentialité',
    html:
      '<h3>Responsable du traitement</h3><p>Le circuit auprès duquel vous vous inscrivez est responsable de vos données. Il utilise TRINISETTE comme prestataire technique (sous-traitant au sens du RGPD) pour les héberger et les traiter en son nom.</p>' +
      '<h3>Données collectées</h3><p>Pseudo, prénom, nom, adresse e-mail, date de naissance, nationalité choisie, avatar (aucune photo), ainsi que les temps réalisés lors de vos sessions.</p>' +
      '<h3>Pourquoi</h3><p>Pour vous inscrire à la session, afficher le classement, et vous envoyer par e-mail vos résultats et votre carte de performance à l\'issue de la course.</p>' +
      '<h3>Communication commerciale</h3><p>Les offres et nouveautés du circuit ne vous sont envoyées que si vous cochez la case dédiée. Ce choix est indépendant de l\'inscription et se retire à tout moment.</p>' +
      '<h3>Durée de conservation</h3><p>Votre profil pilote est conservé tant que vous roulez sur le circuit. Trois ans après votre dernière session, votre nom, votre e-mail et les autres données qui vous identifient sont effacés automatiquement ; vos performances (chronos, classements) restent dans les archives du circuit, mais ne sont plus associées à votre identité.</p>' +
      '<h3>Vos droits</h3><p>Accès, rectification, suppression et opposition à tout moment : il suffit d\'en faire la demande à l\'accueil du circuit ou à l\'adresse de contact affichée sur cette page. Le circuit peut supprimer définitivement votre profil et votre historique à votre demande.</p>' +
      '<div class="legal-note">Politique de confidentialité TRINISETTE, applicable à tous les circuits utilisant le service.</div>',
  },
};

export function openLegal(key, ev) {
  if (ev) { ev.preventDefault(); ev.stopPropagation(); }
  const doc = LEGAL_DOCS[key] || LEGAL_DOCS.cgv;
  const overlay = document.getElementById('legal-overlay');
  if (!overlay) return;
  const t = document.getElementById('legal-title');
  const b = document.getElementById('legal-body');
  if (t) t.textContent = doc.title;
  if (b) { b.innerHTML = doc.html; b.scrollTop = 0; }
  overlay.classList.add('open');
  document.body.style.overflow = 'hidden';
}

export function closeLegal() {
  const overlay = document.getElementById('legal-overlay');
  if (!overlay) return;
  overlay.classList.remove('open');
  document.body.style.overflow = '';
}

/** Ferme uniquement si le clic a eu lieu SUR le fond, pas dans le panneau. */
export function closeLegalFromBackdrop(ev) {
  if (ev && ev.target && ev.target.id === 'legal-overlay') closeLegal();
}

/** La case CGV/CGU pilote l'activation du bouton d'inscription. */
export function onConsentChange() {
  const box = document.getElementById('chk-consent');
  const btn = document.getElementById('btn-submit');
  if (btn) btn.disabled = !(box && box.checked);
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
  if (!t) { try { if (window.__ktReveal) window.__ktReveal(); } catch (e) {} return; }
  // 02/08 (client) : "l'instant d'une milliseconde il affiche d'abord en rouge avant de
  // passer au theme". Le theme n'arrivait qu'apres l'aller-retour reseau : on le
  // memorise ici pour que le script en tete de register.html / results.html le pose
  // AVANT le premier rendu a la visite suivante et a chaque bascule inscription <-> resultats.
  try { localStorage.setItem('kt_theme', String(themeKey).trim()); } catch (e) {}
  const r = document.documentElement.style;
  r.setProperty('--acc', t.acc);
  r.setProperty('--acc2', t.acc2);
  r.setProperty('--acc-deep', t.deep);
  try { if (window.__ktReveal) window.__ktReveal(); } catch (e) {}
}

function applyCircuitBranding(cfg) {
  // 31/07 : le nom du circuit etait ecrit en dur dans les 4 en-tetes de cette
  // page. Il vient desormais TOUJOURS de Parametres > Identite du circuit
  // (app_settings.circuit_name, relaye par public_registration_config).
  const circuitName = String(cfg && cfg.circuit_name || '').trim() || 'Karting';
  document.querySelectorAll('.js-circuit-name').forEach(el => { el.textContent = circuitName; });
  document.title = 'Inscription — ' + circuitName;
  applyThemeAccent(cfg && cfg.results_theme);
const wmBadge = document.getElementById('wm-badge');
if (wmBadge) wmBadge.style.display = (cfg && cfg.plan === 'starter') ? 'inline-flex' : 'none';
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

function applyResultsNavLink(cfg) {
  // 31/07 (correctif navigation) : le jeton de circuit ?v= etait perdu au
  // changement d'onglet — on atterrissait sur "results.html" nu, sans aucune
  // information. Le circuit prime desormais sur la session : tant qu'on
  // connait ?v=, l'onglet Resultats renvoie vers le selecteur de sessions
  // terminees du circuit (meme lien, contenu qui se met a jour tout seul).
  const p = new URLSearchParams(window.location.search);
  const venueToken = p.get('v') || p.get('venue');
  let href = 'results';
  if (venueToken) href = 'results?v=' + encodeURIComponent(venueToken);
  else if (cfg && cfg.results_token) href = 'results?result=' + encodeURIComponent(cfg.results_token);
  const link = document.getElementById('nav-results-link');
  if (link) link.href = href;
  prefetchNav(href);
  renderVenueTabs(href);
}

// La pilule flottante Inscription/Resultats chevauchait le titre : on la
// remplace par des onglets integres a l'entete, identiques a ceux de la page
// resultats (meme design, meme contrat de lien).
function renderVenueTabs(resultsHref) {
  const floatSwitch = document.querySelector('.page-switch');
  if (floatSwitch) floatSwitch.remove();
  if (!document.body) return;
  // 02/08 — Client : « la barre ne reste pas au meme endroit quand tu changes de
  // page ». Mesure faite en production : sur les deux ecrans de SELECTION la
  // pastille tombe a top=26 / left=576 / largeur=304, alors que sur l'ecran de
  // FORMULAIRE elle tombait a top=140 — un saut de 114 px — parce qu'elle etait
  // inseree DANS la carte (#screen-0), elle-meme centree verticalement par le
  // flex du body. Trois consequences corrigees ici :
  //   1. la pastille sort de la carte et vient dans un bandeau en tete de body,
  //      avec exactement la geometrie de .venue-wrap (33rem, padding 1.6rem) ;
  //   2. le body cesse de centrer verticalement, sinon aucun top fixe n'est
  //      possible ;
  //   3. elle etait greffee sur #screen-0 seul, donc elle disparaissait des
  //      ecrans 1a/1b/2 : dans le bandeau, elle reste visible tout du long.
  // Les regles .venue-tabs sont copiees a l'identique de VENUE_CSS (marge basse
  // 2rem comprise). Aucune couleur en dur : les jetons de theme decident.
  if (!document.getElementById('venue-tabs-css')) {
    document.head.insertAdjacentHTML('beforeend', `<style id="venue-tabs-css">
body.has-venue-tabs{justify-content:flex-start!important;padding-top:0!important}
#venue-tabs-band{flex:0 0 auto;width:100%;max-width:33rem;margin:0 auto;padding:1.6rem 1.15rem 0;box-sizing:border-box}
.venue-tabs{display:flex;justify-content:center;gap:.25rem;width:19rem;max-width:100%;margin:0 auto 2rem;padding:.19rem;border:1px solid var(--c-border,var(--bord,rgba(255,255,255,.14)));border-radius:999px;background:rgba(255,255,255,.04)}
.venue-tabs a,.venue-tabs span{flex:1 1 0;text-align:center;padding:.5rem .6rem;border-radius:999px;font-family:var(--font-body,inherit);font-size:.75rem;font-weight:700;letter-spacing:.07em;text-transform:uppercase;text-decoration:none;color:var(--c-muted,var(--mut,#8a8f9a));transition:color .15s}
.venue-tabs a:hover{color:var(--c-text,var(--txt,#fff))}
.venue-tabs span{background:var(--c-accent,var(--acc,#ffb238));color:var(--c-bg,var(--bg,#0b0b0f))}
</style>`);
  }
  let band = document.getElementById('venue-tabs-band');
  if (!band) {
    band = document.createElement('div');
    band.id = 'venue-tabs-band';
    document.body.insertAdjacentElement('afterbegin', band);
    document.body.classList.add('has-venue-tabs');
  }
  let tabs = document.getElementById('venue-tabs');
  if (!tabs) {
    tabs = document.createElement('nav');
    tabs.id = 'venue-tabs';
    tabs.className = 'venue-tabs';
    tabs.setAttribute('aria-label', 'Navigation');
    band.appendChild(tabs);
  } else if (tabs.parentElement !== band) {
    band.appendChild(tabs);
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
/* Coque commune : bloc STRICTEMENT identique a celui de public-results.js.
   Toute divergence ici se voit immediatement a l'ecran (la pastille d'onglets
   saute quand on change d'onglet). Aucune couleur en dur. */
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

/* Voir public-results.js : la coque est montee en enfant direct de <body>,
   hors du gabarit de la page hote (ici : body centre verticalement + carte de
   432px), sinon la geometrie ne peut pas coincider entre les deux onglets. */
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
    applyThemeAccent(data.results_theme);
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
  // Logo de Parametres affiche tel quel, sans pastille accentuee derriere.
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

// Prend entierement la main sur l'ecran 0 : le formulaire n'a rien a faire la
// tant qu'aucune session n'est choisie.
function renderVenueScreen(data, venueToken) {
  const floatSwitch = document.querySelector('.page-switch');
  if (floatSwitch) floatSwitch.remove();

  const resultsHref = 'results?v=' + encodeURIComponent(venueToken);
  const tabs = '<nav class="venue-tabs" aria-label="Navigation"><span>Inscription</span>' +
    '<a href="' + resultsHref + '" id="nav-results-link">Résultats</a></nav>';

  const open = (data && Array.isArray(data.open_sessions) ? data.open_sessions.slice() : []);
  // Ordre chronologique : la session qui part le plus tot en premier.
  open.sort((a, b) => String(a.starts_at || '').localeCompare(String(b.starts_at || '')));

  const rows = open.length
    ? open.map((s, i) => venueRow(
        'register?session=' + encodeURIComponent(s.registration_token) +
          '&v=' + encodeURIComponent(venueToken),
        i === 0 ? 'Prochaine' : 'Ouverte',
        s.title || 'Session',
        [venueTime(s.starts_at) ? 'départ ' + venueTime(s.starts_at) : '', venuePeople(s.participants)]
          .filter(Boolean).join(' · '),
        i === 0
      )).join('')
    : '<div class="venue-empty">Aucune session ouverte à l’inscription pour le moment.<br>Rescanne le QR du circuit un peu plus tard.</div>';

  mountVenue(tabs +
    venueHero(data && data.logo_url, lastVenueName, 'Choisis ta session',
              'Inscris-toi à la session que tu vas courir.') +
    rows +
    '<p class="venue-note">Cette page se met à jour toute seule.<br>Garde-la en favori ou rescanne le QR du circuit.</p>');
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
        setSessionTitle('Lien invalide', 'error');
        return;
      }
      renderVenueScreen(data, venueToken);
      return;
    }
    setSessionTitle('Lien invalide', 'error');
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
    setSessionTitle('Session introuvable', 'error');
    return;
  }
  regState.sessionId = cfg.session_id;
  regState.teamMode = !!cfg.team_mode;
  regState.teamSizeMax = cfg.team_size_max || 2;
  regState.teams = Array.isArray(cfg.teams) ? cfg.teams : [];
  setSessionTitle(cfg.session_title || '--');

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

/* -----------------------------------------------------------------------------
   MODE ÉCURIE — choix de l'écurie
   -----------------------------------------------------------------------------
   Volontairement posé SUR l'écran 2, au-dessus du carrousel d'avatar, et pas
   dans un écran de plus : le parcours d'inscription reste à deux étapes, on
   n'allonge pas le tunnel. Un pilote qui ne choisit rien s'inscrit quand même —
   l'organisateur lui attribuera une écurie depuis le registre. Bloquer ici
   ferait perdre des inscriptions pour rien.

   La disponibilité vient de la RPC (`taken` / `full`), jamais d'un comptage
   côté client : deux pilotes peuvent viser la dernière place en même temps, et
   c'est le trigger serveur qui tranche à la soumission.
*/
function renderTeamPicker() {
  const field = document.getElementById('team-field');
  if (!field) return;
  if (!regState.teamMode || !regState.teams.length) {
    field.style.display = 'none';
    regState.teamId = null;
    return;
  }
  field.style.display = 'block';

  const grid = document.getElementById('team-grid');
  grid.innerHTML = regState.teams.map((t) => {
    const left = Math.max(0, regState.teamSizeMax - (t.taken || 0));
    const full = !!t.full;
    return '<button type="button" class="team-card' + (full ? ' full' : '') +
      (regState.teamId === t.id ? ' on' : '') + '" data-team="' + t.id + '"' +
      (full ? ' disabled aria-disabled="true"' : '') +
      ' style="--tc:' + t.color + '">' +
      teamBadgeHTML(t, 86) +
      '<span class="tc-state">' + (full ? 'Complète' : left + ' place' + (left > 1 ? 's' : '')) + '</span>' +
      '</button>';
  }).join('');

  grid.querySelectorAll('.team-card').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (btn.disabled) return;
      // Re-clic sur la même écurie = on se désaffilie. Sans ça, un pilote qui
      // a cliqué par erreur n'a aucun moyen de revenir en arrière.
      regState.teamId = (regState.teamId === btn.dataset.team) ? null : btn.dataset.team;
      renderTeamPicker();
    });
  });

  const hint = document.getElementById('team-hint');
  if (hint) {
    const chosen = regState.teams.find((t) => t.id === regState.teamId);
    hint.textContent = chosen
      ? 'Tu cours pour ' + chosen.name + '. Re-clique dessus pour annuler.'
      : 'Facultatif — tu peux t\'inscrire sans écurie, le circuit t\'en attribuera une.';
  }
}

// Recharge les compteurs juste avant l'affichage : entre le chargement de la
// page et l'arrivée sur l'écran 2, d'autres pilotes ont pu prendre des places.
async function refreshTeamAvailability() {
  if (!regState.teamMode || !regState.registrationToken) return;
  try {
    const res = await db.rpc('public_registration_config', { _registration_token: regState.registrationToken });
    if (!res.error && res.data && Array.isArray(res.data.teams)) {
      regState.teams = res.data.teams;
      regState.teamSizeMax = res.data.team_size_max || regState.teamSizeMax;
      // L'écurie visée vient peut-être de se remplir : on lâche la sélection
      // plutôt que de laisser le pilote se prendre un refus à la soumission.
      const cur = regState.teams.find((t) => t.id === regState.teamId);
      if (cur && cur.full) regState.teamId = null;
    }
  } catch (e) {
    console.warn('[register] disponibilité des écuries non rafraîchie', e);
  }
}

async function enterScreen2() {
  clearMsg('msg-2');
  const sub = document.getElementById('screen2-sub');
  if (sub && regState.pilot) sub.textContent = 'Dernière étape, ' + regState.pilot.pseudo + ' !';
  // Les consentements repartent decoches a chaque passage sur l'ecran 2 (un
  // retour arriere puis un autre pilote ne doit jamais heriter du oui du
  // precedent), et le bouton d'inscription reste bloque tant que les CGV/CGU
  // ne sont pas acceptees.
  const cons = document.getElementById('chk-consent');
  const promo = document.getElementById('chk-promo');
  if (cons) cons.checked = false;
  if (promo) promo.checked = false;
  onConsentChange();
  showScreen('screen-2');
  await refreshTeamAvailability();
  renderTeamPicker();
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

  // Garde-fou serveur-independant : meme si quelqu'un reactive le bouton via
  // la console, l'inscription ne part pas sans acceptation des CGV/CGU.
  const consentBox = document.getElementById('chk-consent');
  if (!consentBox || !consentBox.checked) {
    showMsg('msg-2', 'Tu dois accepter les CGV/CGU et la politique de confidentialité pour t\'inscrire.', 'err');
    return;
  }
  const promoBox = document.getElementById('chk-promo');

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
      // Consentement : horodatage de l'acceptation des CGV/CGU + politique de
      // confidentialite, et opt-in commercial (independant, facultatif).
      // Ces deux colonnes remontent dans le registre admin et les exports
      // CSV/XLSX pour que le circuit puisse trier ses contacts opt-in.
      consent_accepted_at: new Date().toISOString(),
      promo_opt_in: !!(promoBox && promoBox.checked),
      // Hors mode Ecurie, le trigger serveur remet cette valeur a NULL de
      // toute facon : on peut l'envoyer sans condition.
      team_id: regState.teamMode ? regState.teamId : null,
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
        // Mode Ecurie : trg_validate_registration_team leve un 23505 SANS nom
        // de contrainte quand l'ecurie s'est remplie entre l'affichage et la
        // soumission. Sans ce test, ce cas tomberait dans la branche « avatar
        // deja pris » juste en dessous, et le pilote changerait d'avatar en
        // boucle sans jamais comprendre.
        if (e && /ecurie|écurie/i.test(constraint)) {
          await refreshTeamAvailability();
          renderTeamPicker();
          showMsg('msg-2', 'Cette écurie vient d\'être complétée — choisis-en une autre.', 'err');
        } else if (e && e.code === '23505' && constraint.indexOf('session_pilot_uidx') !== -1) {
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
