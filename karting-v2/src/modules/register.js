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
// private.avatar_config(tenant_id) a déjà tranché côté serveur (Pro ou pas),
// exactement comme le fait déjà site-config.js pour results.html.
import { db } from '../lib/supabase.js';
import { kartAvatarSVG } from './kart-avatar.js';
import {
  configureSignatureAvatars,
  wireSignatureAvatarFallback,
  signatureAvatarsActive,
  signatureAvatarHTML,
} from './signature-avatar.js';

// Liste déroulante (plus adaptée qu'une grille de boutons à une liste qui va
// grandir) : UE au complet + principaux pays hors UE, "Autre" en repli final.
// Codes ISO 3166-1 alpha-2 conservés partout où possible.
const NATS = [
  { code: 'FR', flag: '🇫🇷', label: 'France' },
  { code: 'BE', flag: '🇧🇪', label: 'Belgique' },
  { code: 'DE', flag: '🇩🇪', label: 'Allemagne' },
  { code: 'IT', flag: '🇮🇹', label: 'Italie' },
  { code: 'ES', flag: '🇪🇸', label: 'Espagne' },
  { code: 'GB', flag: '🇬🇧', label: 'Angleterre' },
  { code: 'NL', flag: '🇳🇱', label: 'Pays-Bas' },
  { code: 'CH', flag: '🇨🇭', label: 'Suisse' },
  { code: 'PT', flag: '🇵🇹', label: 'Portugal' },
  { code: 'PL', flag: '🇵🇱', label: 'Pologne' },
  { code: 'AT', flag: '🇦🇹', label: 'Autriche' },
  { code: 'SE', flag: '🇸🇪', label: 'Suède' },
  { code: 'NO', flag: '🇳🇴', label: 'Norvège' },
  { code: 'DK', flag: '🇩🇰', label: 'Danemark' },
  { code: 'FI', flag: '🇫🇮', label: 'Finlande' },
  { code: 'IE', flag: '🇮🇪', label: 'Irlande' },
  { code: 'LU', flag: '🇱🇺', label: 'Luxembourg' },
  { code: 'MA', flag: '🇲🇦', label: 'Maroc' },
  { code: 'DZ', flag: '🇩🇿', label: 'Algérie' },
  { code: 'TN', flag: '🇹🇳', label: 'Tunisie' },
  { code: 'US', flag: '🇺🇸', label: 'États-Unis' },
  { code: 'CA', flag: '🇨🇦', label: 'Canada' },
  { code: 'OTHER', flag: '🌍', label: 'Autre' },
];

const AVATAR_COUNT = 24;

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
};

// 🆕 v17 : la nationalité est demandée dès le premier écran (création de
// profil OU recherche de profil existant), plus en toute fin de parcours —
// et via un combobox réellement recherchable (la liste est amenée à
// s'allonger, un <select> natif devient vite pénible sur mobile). Deux
// instances identiques cohabitent (écran 1a et écran 1b, un seul des deux
// étant visible à la fois selon le chemin choisi par le pilote) ; elles
// partagent le même état (regState.selectedNat) et restent synchronisées
// l'une avec l'autre au cas où le pilote navigue entre les deux.
function natLabel(n) {
  return n.flag + ' ' + n.label;
}

function findNat(code) {
  return NATS.find((n) => n.code === code) || NATS[0];
}

export function renderNats() {
  ['1a', '1b'].forEach((suffix) => {
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
  renderNatOptions(suffix, document.getElementById('nat-search-' + suffix).value === natLabel(findNat(regState.selectedNat)) ? '' : document.getElementById('nat-search-' + suffix).value);
  dropdown.classList.add('open');
  if (!natComboOpen._wired) {
    natComboOpen._wired = true;
    document.addEventListener('click', (e) => {
      ['1a', '1b'].forEach((s) => {
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
  ['1a', '1b'].forEach((s) => {
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

function applyCircuitBranding(cfg) {
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
}

export async function initRegisterPage() {
  const params = new URLSearchParams(window.location.search);
  const token = params.get('session');
  if (!token) {
    document.getElementById('session-name').textContent = 'Lien invalide';
    return;
  }
  regState.registrationToken = token;
  const { data: sess } = await db.from('sessions').select('id,title').eq('public_registration_token', token).single();
  if (!sess) {
    document.getElementById('session-name').textContent = 'Session introuvable';
    return;
  }
  regState.sessionId = sess.id;
  document.getElementById('session-name').textContent = sess.title;

  applyCircuitBranding(await loadRegistrationConfig(token));
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
    const { data, error } = await db.rpc('find_pilot_by_query', { _query: query });
    if (error) throw error;
    if (!data) {
      regState.foundCandidate = null;
      resultEl.innerHTML = '<div class="not-found-card">Aucun profil trouvé pour "' +
        escapeHTML(query) + '". Vérifie l\'orthographe, ou inscris-toi comme nouveau pilote.</div>';
      return;
    }
    regState.foundCandidate = data;
    resultEl.innerHTML =
      '<div class="pilot-found-card">' +
      '<div class="pilot-found-pseudo">🏁 ' + escapeHTML(data.pseudo) + '</div>' +
      '<div class="choice-sub">' + escapeHTML(data.first_name || '') + '</div>' +
      '</div>' +
      '<button type="button" class="btn btn-primary" onclick="confirmPilotFound()">C\'est moi, continuer</button>';
  } catch (e) {
    showMsg('msg-1b', e.message || 'Erreur lors de la recherche.', 'err');
  } finally {
    btn.disabled = false; btn.textContent = 'Rechercher';
  }
}

export async function confirmPilotFound() {
  if (!regState.foundCandidate) return;
  regState.pilot = { id: regState.foundCandidate.id, pseudo: regState.foundCandidate.pseudo };
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
  const all = Array.from({ length: AVATAR_COUNT }, (_, i) => i);
  let taken = [];
  try {
    const { data, error } = await db.rpc('session_taken_avatars', { _session_id: regState.sessionId });
    if (error) throw error;
    taken = Array.isArray(data) ? data : [];
  } catch (e) {
    // Le carrousel est un confort, pas un bloquant : si la RPC échoue
    // (migration pas encore appliquée, réseau...) on retombe sur la liste
    // complète plutôt que d'empêcher l'inscription.
    console.warn('[register] avatars pris introuvables — carrousel non filtré.', e);
  }
  regState.avatarPool = all.filter((i) => taken.indexOf(i) < 0);
  if (!regState.avatarPool.length) {
    // Tous les avatars de cette session sont déjà pris (session très
    // fréquentée, ou pool corrompu) : on retombe sur la liste complète
    // plutôt que de bloquer l'inscription — le pire cas est une collision
    // sur avatar_scheme, déjà gérée par submitForm() (code 23505).
    regState.avatarPool = all;
  }
  regState.avatarIndex = 0;
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
    status.textContent = (regState.avatarIndex + 1) + ' / ' + regState.avatarPool.length +
      ' disponibles — utilise les flèches pour changer';
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
    if (e && e.code === '23505') {
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
