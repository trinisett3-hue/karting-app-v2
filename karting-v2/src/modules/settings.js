// Module Paramètres — préférences globales (karts par défaut, tours, unité de temps),
// numéros de karts (flotte), apparence des résultats publics (thème + avatars kart), et
// activation des secteurs.
//
// L'ancien système de "casques" à couleurs aléatoires a été remplacé par les avatars kart
// (module kart-avatar.js) : chaque pilote reçoit automatiquement l'avatar de son kart, le
// numéro affiché est celui du kart et la couleur est propre à chaque numéro — rien à
// configurer manuellement. Cet onglet montre la flotte et un aperçu en direct de la page
// de résultats (thème + avatars).
import { db } from '../lib/supabase.js';
import { mountTeamBlock } from './teams-admin.js';
import { state, setPrefs, markPrefsDirty } from '../state.js';
import { showMsg, formatTime, formatDate } from './ui.js';
import { toggleSectorsField, loadRanking } from './results.js';
import {
  IFRAME_LOAD_TIMEOUT, BRIDGE_TIMEOUT, PDF_TIMEOUT,
  withTimeout, exportUrl, openHiddenFrame, waitForBridge,
} from './pdf-bridge.js';
import { kartAvatarSVG } from './kart-avatar.js';
import { pilotAvatarSVG } from './pilot-avatar.js';
import { hasFeature, getCurrentPlanCode } from './plan.js';
import { requestPasswordReset as authRequestPasswordReset } from './auth.js';
import { qrSVG, qrCanvas } from './qr.js';
import { renderSessionTypesEditor, refreshSessionTypeSelects, readSessionTypesFromEditor } from '../state.js';
import {
configureSignatureAvatars,
signatureAvatarHTML,
signatureAvatarsActive,
} from './signature-avatar.js';

// Génère l'avatar (kart ou pilote) utilisé dans les aperçus Paramètres, selon le style
// actuellement sélectionné (même logique que public-results.js > genAvatarSVG).
function previewAvatarSVG(kart, opts) {
if (currentPack() === 'signature') {
// L'admin doit voir CE QU'IL CHOISIT, meme si son plan ne l'autorise pas encore :
// on force donc entitled ici. La page publique, elle, obeit a private.avatar_config()
// qui reimpose 'classic' si l'entitlement manque — le cloisonnement reste serveur.
configureSignatureAvatars(Object.assign(signaturePrefsFromForm(), { entitled: true, plan: 'pro' }));
return signatureAvatarHTML(kart, opts || {});
}
const mode = document.getElementById('pref-avatar-mode')?.value || state.prefs.avatar_mode || 'kart';
if (mode === 'pilot_kart') return pilotAvatarSVG(kart, kart);
if (mode === 'pilot') return pilotAvatarSVG(kart, null, { hidePlate: true });
return kartAvatarSVG(kart);
}

// Couleurs des 3 thèmes (identiques à results.html) — pour l'aperçu en direct, l'admin
// n'étant pas lui-même thémé.
//
// gapBg / gapText sont les valeurs réelles de --c-gap-bg / --c-gap-text de
// results.html. L'aperçu peignait auparavant le badge d'écart en blanc sur un
// fond accent en dur : sur « carbon » cela donnait du blanc sur or (contraste
// 2,3) et surtout une pastille pleine, alors que la vraie page affiche une
// pastille transparente bordée d'or. L'aperçu est maintenant fidèle.
const THEME_COLORS = {
classic: { bg: '#050608', surf: '#0d0f14', mut: '#7a7d8a', acc: '#ff2a2a', text: '#f4f5f8', p2: 'rgba(255,255,255,.28)', p3: 'rgba(184,134,90,.6)', gapBg: '#ff2a2a', gapText: '#fff' },
neon: { bg: '#060810', surf: '#0b0e18', mut: '#6a7a9a', acc: '#00d4ff', text: '#f0f4ff', p2: 'rgba(255,0,128,.5)', p3: 'rgba(255,0,128,.3)', gapBg: '#00d4ff', gapText: '#060810' },
carbon: { bg: '#111214', surf: '#181a1e', mut: '#8a8880', acc: '#c9a84c', text: '#f5f0e8', p2: 'rgba(180,180,180,.35)', p3: 'rgba(150,110,70,.5)', gapBg: 'transparent', gapText: '#c9a84c' },
// Thèmes Premium (v15) — mêmes tokens que les blocs [data-theme="..."] de results.html.
checkered: { bg: '#08090b', surf: '#101114', mut: '#9a9a94', acc: '#ece8dd', text: '#f7f6f2', p2: 'rgba(255,255,255,.4)', p3: 'rgba(201,163,93,.35)', gapBg: '#ece8dd', gapText: '#0a0a0a' },
endurance: { bg: '#03050b', surf: '#070a17', mut: '#7580a6', acc: '#ffb238', text: '#eef1fb', p2: 'rgba(79,178,255,.48)', p3: 'rgba(255,178,56,.3)', gapBg: '#ffb238', gapText: '#04060d' },
pitlane: { bg: '#0a0b0b', surf: '#131613', mut: '#8d8f80', acc: '#f0c419', text: '#f6f4ea', p2: 'rgba(255,255,255,.32)', p3: 'rgba(255,106,31,.4)', gapBg: '#f0c419', gapText: '#0b0c0c' },
champagne: { bg: '#0c0a07', surf: '#161009', mut: '#a4937b', acc: '#d9b978', text: '#f8f1e3', p2: 'rgba(224,224,224,.32)', p3: 'rgba(163,122,66,.48)', gapBg: 'transparent', gapText: '#d9b978' },
arctic: { bg: '#f4f6f9', surf: '#ffffff', mut: '#565c72', acc: '#1a6fbd', text: '#11131c', p2: 'rgba(10,15,30,.3)', p3: 'rgba(26,111,189,.24)', gapBg: '#1a6fbd', gapText: '#ffffff' },
};

// Slugs des thèmes réservés au plan Premium (entitlement `premium_themes`,
// cf. public.my_theme_entitlement() dans migration-v15-registre-stats-themes.sql).
// Exportée : source de vérité unique, reprise par stats.js (audit 28/07, section 4.1 —
// la liste était dupliquée dans les deux fichiers, avec un risque d'oubli à l'ajout d'un thème).
export const PREMIUM_THEMES = new Set(['checkered', 'endurance', 'pitlane', 'champagne', 'arctic']);
function isPremiumTheme(val) { return PREMIUM_THEMES.has(val); }

// Libellé du style d'avatar courant, utilisé dans les textes explicatifs pour
// qu'ils ne parlent plus systématiquement du kart.
function avatarModeLabel() {
const mode = document.getElementById('pref-avatar-mode')?.value || state.prefs.avatar_mode || 'kart';
if (mode === 'pilot_kart') return { gal: 'le buste du pilote avec le numéro de son kart', apercu: 'le buste pilote avec son numéro de kart' };
if (mode === 'pilot') return { gal: 'le buste du pilote, sans numéro', apercu: 'le buste pilote, sans numéro' };
return { gal: "l'avatar de son kart, coloré selon le numéro", apercu: "l'avatar de son kart" };
}

export function updateDefaultsInfo() {
// Le bloc Mode Ecurie du panneau de creation se monte ici plutot qu'au
// demarrage : updateDefaultsInfo() est deja rappelee a chaque retour sur
// l'onglet Creer, ce qui remet le bloc a zero entre deux sessions au lieu de
// garder la selection d'ecuries de la precedente.
mountTeamBlock('s').catch(() => {});
const el = document.getElementById('s-defaults-info');
const kartsWrap = document.getElementById('s-karts-wrap');
if (!el) return;
if (state.prefs.karts_locked) {
kartsWrap.style.display = 'none';
el.textContent =
'Valeurs par defaut: ' + state.prefs.default_karts + ' karts max' + (state.prefs.laps_enabled ? ', ' + state.prefs.default_laps + ' tours' : '') + ' (modifiable dans Parametres).';
} else {
kartsWrap.style.display = 'block';
document.getElementById('s-karts').value = state.prefs.default_karts;
el.textContent = state.prefs.laps_enabled ? state.prefs.default_laps + ' tours par defaut (modifiable dans Parametres).' : '';
}
}

export async function loadPrefs() {
try {
const { data } = await db.from('app_settings').select('*').eq('key', 'global').maybeSingle();
if (data && data.value) {
setPrefs(data.value);
state.prefs.level_expert_max_seconds = state.prefs.level_expert_max_seconds || 45;
state.prefs.level_intermediaire_max_seconds = state.prefs.level_intermediaire_max_seconds || 55;
}
} catch (e) {
// pas de préférences enregistrées pour l'instant — on garde les valeurs par défaut
}
if (!Array.isArray(state.prefs.kart_numbers)) state.prefs.kart_numbers = [];
state.prefs.sectors_enabled = !!state.prefs.sectors_enabled;
state.prefs.sector_count = Number(state.prefs.sector_count || 3);
// pref-date-format / pref-circuit-name (developpement reel, 30/07) : meme mecanisme
// que le reste des prefs — cle JSON dans app_settings.value ('global'), aucune
// migration SQL necessaire (colonne value est deja jsonb). date_format pilote
// formatDate() (ui.js) ; circuit_name devient la source de verite du nom de circuit
// affiche partout (voir commentaire au-dessus de renderLogoPreview plus bas et
// public-results.js > initTheme()).
state.prefs.date_format = state.prefs.date_format === 'mdy' ? 'mdy' : 'dmy';
state.prefs.circuit_name = String(state.prefs.circuit_name || '').slice(0, CIRCUIT_NAME_MAX);
// Deux noms dedies aux exports PDF (31/07). Vides = on retombe sur circuit_name
// cote public-results.js, donc aucune migration ni valeur par defaut a poser.
state.prefs.circuit_name_pdf_header = String(state.prefs.circuit_name_pdf_header || '').slice(0, CIRCUIT_HEAD_MAX);
state.prefs.circuit_name_pdf_footer = String(state.prefs.circuit_name_pdf_footer || '').slice(0, CIRCUIT_FOOT_MAX);
state.prefs.results_theme = state.prefs.results_theme || 'classic';
state.prefs.avatar_mode = state.prefs.avatar_mode || 'kart';
state.prefs.avatar_pack = state.prefs.avatar_pack || 'classic';
state.prefs.avatar_type = state.prefs.avatar_type || 'kartpilot';
state.prefs.avatar_small_type = state.prefs.avatar_small_type || 'helmet';
state.prefs.avatar_background = state.prefs.avatar_background || 'studio';
state.prefs.avatar_outline = state.prefs.avatar_outline !== false;
state.prefs.avatar_shape = state.prefs.avatar_shape || 'round';
state.prefs.card_qr_url = state.prefs.card_qr_url || '';
// booking_url (25/08) : lien de reservation utilise dans l'e-mail de resultats
// (CTA "reserver une prochaine seance"). Meme mecanisme que card_qr_url, aucune
// migration SQL — colonne app_settings.value deja jsonb.
state.prefs.booking_url = String(state.prefs.booking_url || '').slice(0, 300);
state.prefs.card_tagline = String(state.prefs.card_tagline || '').slice(0, CARD_TAGLINE_MAX);
state.prefs.card_address = String(state.prefs.card_address || '').slice(0, 60);
if (!Array.isArray(state.prefs.card_position_picks)) state.prefs.card_position_picks = [];
state.prefs.card_position_picks = state.prefs.card_position_picks.slice(0, CARD_POSITION_MAX);
if (!state.prefs.card_record_picks || typeof state.prefs.card_record_picks !== 'object') {
state.prefs.card_record_picks = {};
}

renderLogoPreview();

// 02/08 (client) : types de session configurables - editeur + tous les <select> de l'admin.
renderSessionTypesEditor();
refreshSessionTypeSelects();

const elUrl = document.getElementById('pref-card-url');
if (elUrl) elUrl.value = state.prefs.card_qr_url || '';
const elTag = document.getElementById('pref-card-tagline');
if (elTag) elTag.value = state.prefs.card_tagline || '';
const elAddr = document.getElementById('pref-card-address');
if (elAddr) elAddr.value = state.prefs.card_address || '';
updateTaglineCount();
renderCardQR();

document.getElementById('pref-karts').value = state.prefs.default_karts;
document.getElementById('pref-laps').value = state.prefs.default_laps;
document.getElementById('pref-level-expert').value = state.prefs.level_expert_max_seconds;
document.getElementById('pref-level-intermediaire').value = state.prefs.level_intermediaire_max_seconds;
document.getElementById('pref-time-unit').value = state.prefs.time_unit;
const dateFmtEl = document.getElementById('pref-date-format');
if (dateFmtEl) dateFmtEl.value = state.prefs.date_format || 'dmy';
const circuitNameEl = document.getElementById('pref-circuit-name');
if (circuitNameEl) circuitNameEl.value = state.prefs.circuit_name || '';
const bookingUrlEl = document.getElementById('pref-booking-url');
if (bookingUrlEl) bookingUrlEl.value = state.prefs.booking_url || '';
const circuitHeadEl = document.getElementById('pref-circuit-name-pdf-header');
if (circuitHeadEl) circuitHeadEl.value = state.prefs.circuit_name_pdf_header || '';
const circuitFootEl = document.getElementById('pref-circuit-name-pdf-footer');
if (circuitFootEl) circuitFootEl.value = state.prefs.circuit_name_pdf_footer || '';
updateCircuitCounts();
loadVenueLink();
document.getElementById('pref-laps-enabled').checked = state.prefs.laps_enabled;
document.getElementById('pref-karts-locked').checked = state.prefs.karts_locked;
toggleLapsField();
renderKartNumbersList();

const sel = document.getElementById('pref-results-theme');
if (sel) sel.value = state.prefs.results_theme;
document.querySelectorAll('.theme-option-row').forEach((r) => {
r.style.borderColor = r.dataset.themeVal === state.prefs.results_theme ? 'var(--acc)' : 'var(--bord)';
});
await loadThemeEntitlement();
const avSel = document.getElementById('pref-avatar-mode');
if (avSel) avSel.value = state.prefs.avatar_mode;
document.querySelectorAll('.avatar-mode-row').forEach((r) => {
r.style.borderColor = r.dataset.avatarVal === state.prefs.avatar_mode ? 'var(--acc)' : 'var(--bord)';
});
await loadAvatarEntitlement();
const setV = (id, val) => { const e = document.getElementById(id); if (e) e.value = val; };
const setC = (id, val) => { const e = document.getElementById(id); if (e) e.checked = val; };
setV('pref-avatar-pack', state.prefs.avatar_pack);
setV('pref-avatar-type', state.prefs.avatar_type);
setV('pref-avatar-small-type', state.prefs.avatar_small_type);
// 'none' n'est pas une entree du menu des motifs : c'est la case a cocher qui le
// represente. Un fond a 'none' laisse donc le menu sur sa valeur precedente, grise.
setC('pref-avatar-bg-on', state.prefs.avatar_background !== 'none');
if (state.prefs.avatar_background !== 'none') setV('pref-avatar-background', state.prefs.avatar_background);
setC('pref-avatar-outline', state.prefs.avatar_outline);
setV('pref-avatar-shape', state.prefs.avatar_shape);
renderSignatureControls();

const on = document.getElementById('pref-sectors-enabled');
const n = document.getElementById('pref-sector-count');
if (on) on.checked = state.prefs.sectors_enabled;
if (n) n.value = String(state.prefs.sector_count);
toggleSectorsField();

// Format d'import personnalisable (24/08) — voir results.js > getChronoImportFormat().
const ci = state.prefs.chrono_import;
const customized = !!(ci && ci.customized);
setC('pref-chrono-custom', customized);
if (customized) {
setV('pref-chrono-delim', ci.delimiter || 'auto');
setC('pref-chrono-header', !!ci.has_header);
setV('pref-chrono-col-kart', ci.col_kart || 2);
setV('pref-chrono-col-lap', ci.col_lap != null ? ci.col_lap : 3);
setV('pref-chrono-col-time', ci.col_time || 4);
setV('pref-chrono-col-sectors', (ci.col_sectors || []).join(','));
}
toggleChronoCustomFormat();
}

// Affiche/masque le mapping de colonnes personnalisé — appelé au chargement des
// Paramètres et au clic sur la case "Personnaliser le format d'import".
export function toggleChronoCustomFormat() {
const on = document.getElementById('pref-chrono-custom')?.checked;
const wrap = document.getElementById('pref-chrono-custom-wrap');
if (wrap) wrap.style.display = on ? 'block' : 'none';
}

export function renderKartNumbersList() {
const el = document.getElementById('kart-numbers-list');
if (!el) return;
const nums = (state.prefs.kart_numbers || []).slice().sort((a, b) => a - b);
if (!nums.length) {
el.innerHTML = '<div class="empty" style="grid-column:1/-1;padding:14px">Aucun numero defini. Utilise "Generer 1 a N" ou ajoute-les un par un.</div>';
return;
}
el.innerHTML = nums.map((n) => '<div class="kart-pastille free" style="cursor:pointer" title="Retirer" onclick="removeKartNumber(' + n + ')">' + n + '</div>').join('');
}

export function addKartNumber() {
const inp = document.getElementById('pref-kart-num-input');
const v = parseInt(inp.value);
if (isNaN(v) || v < 1) {
showMsg('msg-kart-numbers', 'Numero invalide.', 'err');
return;
}
if (!Array.isArray(state.prefs.kart_numbers)) state.prefs.kart_numbers = [];
if (state.prefs.kart_numbers.includes(v)) {
showMsg('msg-kart-numbers', 'Ce numero existe deja.', 'err');
return;
}
state.prefs.kart_numbers.push(v);
inp.value = '';
renderKartNumbersList();
renderKartAvatarGallery();
markPrefsDirty();
showMsg('msg-kart-numbers', 'Numero ' + v + ' ajoute. Clique Enregistrer pour sauvegarder.', 'ok');
}

export function removeKartNumber(n) {
state.prefs.kart_numbers = (state.prefs.kart_numbers || []).filter((x) => x !== n);
renderKartNumbersList();
renderKartAvatarGallery();
markPrefsDirty();
showMsg('msg-kart-numbers', 'Numero ' + n + ' retire. Clique Enregistrer pour sauvegarder.', 'ok');
}

export function autoFillKartNumbers() {
const max = parseInt(document.getElementById('pref-karts').value) || state.prefs.default_karts || 12;
state.prefs.kart_numbers = Array.from({ length: max }, (_, i) => i + 1);
renderKartNumbersList();
renderKartAvatarGallery();
markPrefsDirty();
showMsg('msg-kart-numbers', 'Numeros 1 a ' + max + ' generes. Clique Enregistrer pour sauvegarder.', 'ok');
}

export function toggleLapsField() {
const enabled = document.getElementById('pref-laps-enabled').checked;
document.getElementById('pref-laps-wrap').style.display = enabled ? 'block' : 'none';
}

// --- Logo du circuit ------------------------------------------------------------------------
// Un seul logo par organisation pour l'instant (colonne app_settings.value.logo_url,
// bucket Storage "org-logos", upload réservé à l'admin connecté). Affiché sur
// results.html (voir public-results.js > initTheme). Redimensionné côté client en PNG
// (garde la transparence) avant upload, comme les photos pilotes sur register.html.
function compressLogo(file, maxDim) {
return new Promise((resolve) => {
const img = new Image();
const url = URL.createObjectURL(file);
img.onload = () => {
const MAX = maxDim || 400;
let w = img.width, h = img.height;
if (w > MAX || h > MAX) {
if (w > h) { h = Math.round((h * MAX) / w); w = MAX; }
else { w = Math.round((w * MAX) / h); h = MAX; }
}
const canvas = document.createElement('canvas');
canvas.width = w; canvas.height = h;
canvas.getContext('2d').drawImage(img, 0, 0, w, h);
URL.revokeObjectURL(url);
canvas.toBlob((blob) => resolve(blob || file), 'image/png');
};
img.onerror = () => resolve(file);
img.src = url;
});
}

export function renderLogoPreview() {
const wrap = document.getElementById('pref-logo-preview-wrap');
const img = document.getElementById('pref-logo-preview');
const removeBtn = document.getElementById('pref-logo-remove-btn');
// Point 5 (complément) : le logo n'était jusqu'ici visible que dans l'aperçu
// des Paramètres et sur results.html — jamais dans l'admin elle-même. On le
// reflète aussi dans la sidebar, seul endroit visible à tout moment.
const sbLogo = document.getElementById('sb-circuit-logo');
if (sbLogo) {
if (state.prefs.logo_url) {
sbLogo.src = state.prefs.logo_url;
sbLogo.style.display = 'block';
} else {
sbLogo.style.display = 'none';
}
}
if (!wrap || !img) return;
if (state.prefs.logo_url) {
img.src = state.prefs.logo_url;
wrap.style.display = 'flex';
if (removeBtn) removeBtn.style.display = 'inline-flex';
} else {
wrap.style.display = 'none';
if (removeBtn) removeBtn.style.display = 'none';
}
}

// --- Stockage : chemins scopes par tenant -----------------------------------------------------
// Historiquement les visuels etaient ecrits a plat ('logos/<timestamp>.png'). Aucune policy RLS
// ne pouvait alors distinguer les fichiers d'un circuit de ceux d'un autre : n'importe quel admin
// authentifie pouvait ecraser ou supprimer le logo d'un concurrent. On prefixe desormais par
// l'identifiant du tenant, ce qui permet aux policies de verifier (storage.foldername(name))[2].
let _tenantIdCache = null;
async function currentTenantId() {
  if (_tenantIdCache) return _tenantIdCache;
  // La RLS de public.tenants limite deja la selection au tenant de l'admin connecte.
  const { data, error } = await db.from('tenants').select('id').limit(1).maybeSingle();
  if (error || !data || !data.id) return null;
  _tenantIdCache = data.id;
  return _tenantIdCache;
}

// Retrouve le chemin interne d'un objet a partir de son URL publique
// (.../storage/v1/object/public/org-logos/<chemin>), pour pouvoir le supprimer.
function storagePathFromPublicUrl(url, bucket) {
  if (!url) return null;
  const marker = '/storage/v1/object/public/' + bucket + '/';
  const i = String(url).indexOf(marker);
  if (i === -1) return null;
  return decodeURIComponent(String(url).slice(i + marker.length).split('?')[0]);
}

// Supprime les fichiers du dossier du tenant qui ne sont plus references par les preferences.
// Appele UNIQUEMENT apres un enregistrement reussi : tant que l'admin n'a pas clique
// "Enregistrer", l'ancien visuel est encore celui publie en ligne, il ne faut pas y toucher.
async function cleanupOrphanStorage() {
  try {
    const tenantId = await currentTenantId();
    if (!tenantId) return;
    const keep = [state.prefs.logo_url]
      .map((u) => storagePathFromPublicUrl(u, 'org-logos'))
      .filter(Boolean);
    for (const folder of ['logos']) {
      const prefix = folder + '/' + tenantId;
      const { data, error } = await db.storage.from('org-logos').list(prefix, { limit: 100 });
      if (error || !data) continue;
      const doomed = data
        .map((f) => prefix + '/' + f.name)
        .filter((p) => keep.indexOf(p) === -1);
      if (doomed.length) await db.storage.from('org-logos').remove(doomed);
    }
  } catch (e) {
    // Best effort : un menage rate ne doit jamais faire echouer l'enregistrement.
  }
}

export async function uploadLogo(input) {
const file = input.files && input.files[0];
if (!file) return;
const msgId = 'msg-logo';
try {
showMsg(msgId, 'Upload du logo…', 'ok');
const compressed = await compressLogo(file);
const tenantId = await currentTenantId();
if (!tenantId) {
  showMsg(msgId, 'Session admin expiree : reconnecte-toi avant d\'envoyer un logo.', 'err');
  return;
}
const path = 'logos/' + tenantId + '/' + Date.now() + '.png';
const { error: upErr } = await db.storage.from('org-logos').upload(path, compressed, {
upsert: true,
contentType: 'image/png',
});
if (upErr) {
showMsg(msgId, 'Upload échoué (' + upErr.message + ').', 'err');
return;
}
const { data: urlData } = db.storage.from('org-logos').getPublicUrl(path);
state.prefs.logo_url = urlData.publicUrl;
renderLogoPreview();
markPrefsDirty();
showMsg(msgId, 'Logo uploadé. Clique Enregistrer pour le publier.', 'ok');
} catch (e) {
showMsg(msgId, 'Erreur: ' + e.message, 'err');
} finally {
input.value = '';
}
}

export function removeLogo() {
state.prefs.logo_url = null;
renderLogoPreview();
markPrefsDirty();
showMsg('msg-logo', 'Logo retiré. Clique Enregistrer pour confirmer.', 'ok');
}

// 02/08 (client) : "enleve l'option plan du circuit pour le moment partout".
// L'option est retiree de l'UI, des preferences et de la page publique. La colonne
// app_settings.value.track_map_url est nettoyee cote base ; rien d'autre n'en depend.

// Sous-onglets de l'onglet Parametres (voir admin.html > panel-parametres) : meme
// convention pastille/.selected que switchStatsSubtab() dans stats.js — un seul bloc
// de reglages visible a la fois pour reduire la quantite d'info affichee.
//
// Refonte 30/07 (client) : passage de 5 a 8 sous-onglets avec ISOLATION TOTALE — aucun
// composant n'est partage entre deux onglets. En particulier l'apercu podium
// (#results-live-preview) n'existe plus qu'a l'interieur du bloc "podium" : il etait
// auparavant dans une colonne de droite visible depuis tous les sous-onglets.
//
// Fusion 30/07 (client, meme jour) : 8 -> 6 sous-onglets. "Secteurs & chronos" et
// "Flotte" sont retires de cette liste et leur contenu HTML deplace dans le bloc
// "sessions" (voir admin.html) — ids et comportement JS inchanges, seul le
// regroupement visuel change.
//
// Refonte 30/07 (client, meme jour, 2e passe) : 6 -> 5 sous-onglets. "Podium" n'existe
// plus en tant qu'onglet autonome : son contenu (QR, accroche, cartes, apercu en direct)
// est desormais le volet "Résultats" a l'interieur de "apparence" (voir admin.html —
// #apparence-resultats-panel). Tous les ids sont conserves a l'identique, seul le
// regroupement visuel change. Voir refreshAppearancePreviews().
const PARAMS_SUBTABS = ['general', 'sessions', 'apparence', 'pdf', 'kiosque', 'compte'];
export function switchParamsSubtab(tab) {
  if (!PARAMS_SUBTABS.includes(tab)) return;
  PARAMS_SUBTABS.forEach((key) => {
    const panel = document.getElementById('params-subtab-' + key);
    if (panel) panel.classList.toggle('active', key === tab);
  });
  document.querySelectorAll('.subtab-btn[data-ptab-val]').forEach((b) => {
    b.classList.toggle('selected', b.dataset.ptabVal === tab);
  });
  if (tab === 'apparence') { renderKartAvatarGallery(); renderCardsTab(); refreshAppearancePreviews(undefined, true); }
  if (tab === 'pdf') refreshPdfPreview();
  if (tab === 'compte') renderAccountTab();
}

// --- Onglet Kiosque (K-28) ---------------------------------------------------------
// Le kiosque (kiosk.html) est une page staff authentifiée, pas une page publique — voir
// kiosk-app.js. Ici on donne juste au staff un moyen de l'ouvrir SANS taper d'URL : un
// bouton par écran, qui ouvre kiosk.html dans un nouvel onglet et bascule en plein écran.
// Le plein écran est demandé côté kiosk.html lui-même (main(), sur &fs=1) plutôt que
// depuis cette fenêtre-ci sur la fenêtre ouverte : l'API Fullscreen exige un geste
// utilisateur DANS le document qui la demande, et l'activation utilisateur du clic ne se
// transmet de façon fiable au nouvel onglet que jusqu'à sa propre navigation initiale —
// donc c'est ce document (kiosk.html), au chargement, qui doit faire la demande lui-même.
export function openKioskScreen(mode) {
  // 'rank' = classement de la dernière session publiée, 'hof' = Hall of Fame,
  // rien = rotation entre les deux. (L'écran s'appelait 'pdf' avant le 26/08 :
  // il affichait le fichier PDF dans un visionneur, remplacé depuis par un
  // rendu natif plein écran — voir kiosk-app.js.)
  const qs = mode === 'rank' ? '?screen=rank&fs=1' : mode === 'hof' ? '?screen=hof&fs=1' : '?fs=1';
  window.open('kiosk.html' + qs, '_blank');
}

// --- Entitlement "thèmes premium" (plan Premium) ---------------------------------------
// Même pattern que avatarEntitlement ci-dessous : rempli une fois au chargement par
// public.my_theme_entitlement(), utilisé UNIQUEMENT pour l'affichage (griser/verrouiller
// les thèmes Premium dans le picker). La décision réelle appartient au serveur, et elle y est
// désormais appliquée : le trigger trg_enforce_premium_settings nettoie chaque écriture de
// app_settings et le RPC public_site_config() re-nettoie à la lecture publique. Un thème
// Premium forcé par un plan Basique retombe donc sur "classic" côté serveur.
let themeEntitlement = { entitled: false, plan: 'free' };

export async function loadThemeEntitlement() {
try {
const { data, error } = await db.rpc('my_theme_entitlement');
if (!error && data) themeEntitlement = data;
} catch (e) {
// Sans reponse on reste sur { entitled:false } : les thèmes Premium restent verrouillés
// dans l'UI plutôt que de promettre a tort qu'ils sont disponibles.
}
renderThemeGating();
}

// Applique le verrouillage visuel des lignes de thèmes Premium (grisé + icône cadenas),
// sans jamais désactiver les 3 thèmes gratuits historiques.
function renderThemeGating() {
document.querySelectorAll('.theme-option-row').forEach((r) => {
const locked = isPremiumTheme(r.dataset.themeVal) && !themeEntitlement.entitled;
r.classList.toggle('theme-locked', locked);
});
const ups = document.getElementById('themes-upsell');
if (ups) {
const currentIsPremiumLocked = isPremiumTheme(state.prefs.results_theme) && !themeEntitlement.entitled;
ups.style.display = (!themeEntitlement.entitled) ? 'block' : 'none';
if (currentIsPremiumLocked) {
// Cas résiduel (downgrade après sélection) : la préférence enregistrée pointe vers
// un thème Premium que le tenant n'a plus le droit d'utiliser. On ne la modifie pas
// silencieusement ici — voir la lacune connue côté public_site_config() — mais on
// le signale clairement dans l'encart plutôt que de laisser un message générique.
ups.innerHTML = 'Le thème actuellement enregistré est un thème <strong>Premium</strong> et ton plan ne l\'inclut plus : la page publique peut continuer à l\'afficher jusqu\'à ce que tu en choisisses un autre ici. Passe au plan supérieur pour le conserver, ou choisis un thème gratuit.';
} else {
ups.innerHTML = 'Les thèmes premium sont réservés au plan <strong>Premium</strong>. Passe au plan supérieur pour les débloquer.';
}
}
}

export function selectResultsTheme(val) {
if (isPremiumTheme(val) && !themeEntitlement.entitled) {
// Garde-fou côté picker : on ne laisse pas sélectionner/appliquer un thème Premium sans
// entitlement — la RPC my_theme_entitlement() reste la source de vérité, ceci n'est
// qu'un confort d'UI pour ne pas laisser croire que le choix a été pris en compte.
renderThemeGating();
return;
}
const sel = document.getElementById('pref-results-theme');
if (sel) sel.value = val;
document.querySelectorAll('.theme-option-row').forEach((r) => {
r.style.borderColor = r.dataset.themeVal === val ? 'var(--acc)' : 'var(--bord)';
});
state.prefs.results_theme = val;   // les vignettes de cartes suivent le theme choisi
renderCardsTab();
refreshAppearancePreviews(val);
markPrefsDirty();
}

// --- Pack d'avatars (Classic / Signature Premium) ---------------------------------------
// Etat commercial du tenant connecte, rempli une fois au chargement par
// public.my_avatar_entitlement(). Sert UNIQUEMENT a afficher ou non l'encart
// « reserve au plan Premium » : la decision reelle est prise par le serveur.
let avatarEntitlement = { entitled: false, plan: 'free' };

function currentPack() {
return document.getElementById('pref-avatar-pack')?.value || state.prefs.avatar_pack || 'classic';
}

// Lit les six reglages Signature depuis le formulaire. Un seul endroit, pour que
// l'apercu, la galerie et l'enregistrement ne puissent pas diverger.
function signaturePrefsFromForm() {
const v = (id, def) => document.getElementById(id)?.value || def;
const c = (id) => !!document.getElementById(id)?.checked;
return {
pack: currentPack(),
type: v('pref-avatar-type', 'kartpilot'),
small_type: v('pref-avatar-small-type', 'helmet'),
background: c('pref-avatar-bg-on') ? v('pref-avatar-background', 'studio') : 'none',
outline: c('pref-avatar-outline'),
shape: v('pref-avatar-shape', 'round'),
};
}

export async function loadAvatarEntitlement() {
try {
const { data, error } = await db.rpc('my_avatar_entitlement');
if (!error && data) avatarEntitlement = data;
} catch (e) {
// Sans reponse on reste sur { entitled:false } : on affiche l'encart plutot que
// de promettre a tort que le pack sera visible en ligne.
}
}

export function selectAvatarPack(val) {
const sel = document.getElementById('pref-avatar-pack');
if (sel) sel.value = val;
markPrefsDirty();
renderSignatureControls();
}

// Cache de la session reelle utilisee par les 3 apercus Apparence (podium/classement/
// fiche). Rempli une seule fois par ouverture du sous-onglet (voir switchParamsSubtab),
// puis reutilise par tous les recalculs "visuels seuls" (changement de theme/avatar) qui
// n'ont pas besoin de retourner interroger Supabase — seul un nouveau requetage explicite
// (reouverture du sous-onglet) rafraichit la donnee. Meme table de sessions archivees que
// refreshPdfPreview() (voir fetchPdfPreviewSessions/loadRanking plus bas), donc meme
// perimetre RLS/tenant : aucune requete supplementaire n'est inventee ici.
let appearancePreviewRanking = null;   // tableau normalise (reel ou DEMO_RANKING), null = pas encore charge
let appearancePreviewFetchInFlight = null;   // Promise en cours, pour eviter les requetes concurrentes

// Transforme le resultat brut de loadRanking() (name/kart/t) en la forme attendue par les
// 3 apercus (pos/kart/name/t/gap/best/s1/s2/s3). loadRanking() ne calcule ni meilleur tour
// ni secteurs (le total par pilote seulement) : ces deux champs retombent donc sur le temps
// total, ce qui reste un rendu "reel" fidele au classement plutot qu'une fabrication --
// seuls s1/s2/s3 (non disponibles agreges dans loadRanking) affichent '--'.
function normalizeRealRanking(rows) {
if (!rows || !rows.length) return null;
const sorted = rows.slice().sort((a, b) => a.t - b.t);
const leader = sorted[0].t;
return sorted.map((r, i) => ({
pos: i + 1,
kart: r.kart,
name: r.name,
t: formatTime(r.t),
gap: i === 0 ? '—' : '+' + formatTime(r.t - leader),
best: formatTime(r.t),
s1: '--', s2: '--', s3: '--',
}));
}

// Recupere la session reelle la plus recente (meme logique que refreshPdfPreview) et la
// convertit au format attendu par les apercus. Retombe sur DEMO_RANKING si aucune session
// archivee n'existe encore ou si la requete echoue -- jamais d'ecran vide.
async function fetchAppearancePreviewRanking() {
try {
const sessions = await fetchPdfPreviewSessions();
if (sessions.length) {
const rows = await loadRanking(sessions[0]);
const normalized = normalizeRealRanking(rows);
if (normalized) return normalized;
}
} catch (e) {
// Pas de session exploitable / erreur reseau : on retombe silencieusement sur la
// demo plutot que de casser l'onglet Apparence.
}
return DEMO_RANKING;
}

// Recalcule les 3 apercus reels du volet Apparence > Résultats (podium, classement final,
// fiche pilote/temps) a partir du theme et des reglages avatar courants du formulaire.
// Fonction centrale appelee depuis tout changement de theme ou d'avatar (voir
// selectResultsTheme/selectAvatarPack/selectAvatarMode/renderSignatureControls), et a
// l'ouverture du sous-onglet Apparence (switchParamsSubtab) pour un rendu immediat sans
// attendre une premiere modification.
//
// `refetch` (reserve a l'ouverture du sous-onglet) force un nouveau requetage de la
// derniere session archivee ; tous les autres appels (theme/avatar) reutilisent le cache
// en memoire pour ne pas re-interroger Supabase a chaque clic sur une pastille de theme.
export async function refreshAppearancePreviews(theme, refetch) {
if (refetch || !appearancePreviewRanking) {
if (!appearancePreviewFetchInFlight) {
appearancePreviewFetchInFlight = fetchAppearancePreviewRanking().finally(() => {
appearancePreviewFetchInFlight = null;
});
}
appearancePreviewRanking = await appearancePreviewFetchInFlight;
}
const ranking = appearancePreviewRanking || DEMO_RANKING;
renderResultsPreview(theme, ranking);
renderClassementPreview(theme, ranking);
renderFichePreview(theme, ranking);
}

// Applique l'etat du formulaire a l'ecran : surlignage des pastilles de pack,
// affichage des deux blocs d'options, encart Premium, bande d'apercu, galerie.
export function renderSignatureControls() {
const pack = currentPack();
document.querySelectorAll('.avatar-pack-row').forEach((r) => {
r.style.borderColor = r.dataset.packVal === pack ? 'var(--acc)' : 'var(--bord)';
});
const cls = document.getElementById('avatar-classic-options');
const sig = document.getElementById('avatar-signature-options');
if (cls) cls.style.display = pack === 'signature' ? 'none' : 'block';
if (sig) sig.style.display = pack === 'signature' ? 'block' : 'none';
const ups = document.getElementById('signature-upsell');
if (ups) ups.style.display = (pack === 'signature' && !avatarEntitlement.entitled) ? 'block' : 'none';

// Le contour blanc n'existe que detoure sur un fond : sans fond il dessinerait une
// aureole blanche sur la page. On le grise plutot que de le laisser mentir.
const bgOn = !!document.getElementById('pref-avatar-bg-on')?.checked;
const bgSel = document.getElementById('pref-avatar-background');
const outl = document.getElementById('pref-avatar-outline');
if (bgSel) bgSel.disabled = !bgOn;
if (outl) outl.disabled = !bgOn;
const note = document.getElementById('outline-note');
if (note) note.style.opacity = bgOn ? '1' : '.5';

if (pack === 'signature') renderSignaturePreview();
refreshAppearancePreviews();
renderKartAvatarGallery();
}

// Bande d'apercu : le grand format et le petit format cote a cote, aux tailles
// reelles de la page publique (podium 96 px, tableau 40 px), pour que le choix se
// juge sur ce qui sera vraiment affiche et non sur une vignette agrandie.
function renderSignaturePreview() {
const wrap = document.getElementById('signature-preview');
if (!wrap) return;
const cell = (n, size, small, lbl) =>
'<div style="text-align:center"><div style="width:' + size + 'px;height:' + size + 'px;margin:0 auto">' +
previewAvatarSVG(n, { size, small }) +
'</div><div style="font-size:9px;color:var(--mut);margin-top:6px;text-transform:uppercase;letter-spacing:.06em">' + lbl + '</div></div>';
wrap.innerHTML = cell(7, 96, false, 'Podium') + cell(7, 40, true, 'Tableau') +
cell(14, 40, true, 'Tableau') + cell(21, 40, true, 'Tableau');
}

// Style d'avatar : 'kart' (dessin par numéro de kart, actuel), 'pilot_kart' (buste pilote
// illustré + numéro de kart affiché) ou 'pilot' (même buste, sans numéro).
export function selectAvatarMode(val) {
const sel = document.getElementById('pref-avatar-mode');
if (sel) sel.value = val;
document.querySelectorAll('.avatar-mode-row').forEach((r) => {
r.style.borderColor = r.dataset.avatarVal === val ? 'var(--acc)' : 'var(--bord)';
});
refreshAppearancePreviews();
renderKartAvatarGallery();
markPrefsDirty();
}

// Aperçu en direct de la PAGE 1 des résultats (podium + top) avec le thème choisi et les
// vrais avatars kart — rendu dans la zone de droite des Paramètres.
export function renderResultsPreview(theme, ranking) {
const box = document.getElementById('results-live-preview');
if (!box) return;
const t = THEME_COLORS[theme || document.getElementById('pref-results-theme')?.value || state.prefs.results_theme || 'classic'] || THEME_COLORS.classic;
const data = ranking || DEMO_RANKING;
const byPos = (n) => data.find((d) => d.pos === n);
const podium = [
byPos(2) && { ...byPos(2), border: t.p2 },
byPos(1) && { ...byPos(1), gap: byPos(1).t, border: t.acc, first: true },
byPos(3) && { ...byPos(3), border: t.p3 },
].filter(Boolean);
const rows = data.slice(3, 5);
const av = (k) => `<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center">${previewAvatarSVG(k)}</div>`;
const podHTML = podium.map((d) => `
<div style="display:flex;flex-direction:column;background:${t.surf};border:1px solid ${d.border};border-radius:8px;overflow:hidden;${d.first ? 'box-shadow:0 0 16px ' + t.acc + '55;' : 'margin-top:14px;'}">
<div style="position:relative;flex:1;min-height:${d.first ? '92' : '74'}px;display:flex;align-items:center;justify-content:center;padding:6px">
<span style="position:absolute;top:2px;left:5px;font-weight:900;font-style:italic;font-size:${d.first ? 26 : 20}px;color:${d.first ? t.acc : t.mut}">${d.pos}</span>
${av(d.kart)}
</div>
<div style="background:linear-gradient(to top,rgba(0,0,0,.85),transparent);padding:5px 6px">
<div style="font-weight:900;font-style:italic;font-size:11px;color:${t.text}">${d.name}</div>
<div style="display:flex;justify-content:space-between;align-items:center;margin-top:2px">
<span style="font-size:8px;color:${t.mut}">KART ${d.kart}</span>
<span style="font-size:8px;font-weight:800;color:${t.gapText};background:${t.gapBg};border:1px solid ${t.acc};padding:1px 5px;border-radius:4px">${d.gap}</span>
</div>
</div>
</div>`).join('');
const rowsHTML = rows.map((d) => `
<div style="display:grid;grid-template-columns:20px 26px 1fr auto;gap:7px;align-items:center;padding:5px 8px;border-top:1px solid rgba(255,255,255,.06)">
<span style="font-weight:900;font-style:italic;font-size:13px;color:${t.mut}">${d.pos}</span>
<div style="width:26px;height:26px;border-radius:50%;overflow:hidden;background:${t.bg};display:flex;align-items:center;justify-content:center">${previewAvatarSVG(d.kart)}</div>
<div><div style="font-weight:800;font-style:italic;font-size:11px;color:${t.text}">${d.name}</div><div style="font-size:8px;color:${t.mut}">KART ${d.kart}</div></div>
<span style="font-size:9px;font-weight:800;color:${t.gapText};background:${t.gapBg};border:1px solid ${t.acc};padding:2px 6px;border-radius:4px">${d.gap}</span>
</div>`).join('');
box.style.cssText = `background:${t.bg};border:1px solid ${t.acc}44;border-radius:12px;padding:12px;box-shadow:inset 0 0 40px ${t.acc}14`;
box.innerHTML = `
<div style="display:flex;justify-content:space-between;align-items:center;border:1px solid ${t.acc}66;background:${t.surf};padding:8px 10px;border-radius:6px;margin-bottom:10px">
<div><div style="font-weight:900;font-size:14px;text-transform:uppercase;color:${t.text}">Circuit de Trinisette</div><div style="font-size:8px;color:${t.mut};margin-top:1px">SESSION DU JOUR · APERÇU</div></div>
<div style="color:${t.acc};font-size:18px;font-weight:900;font-style:italic">PODIUM</div>
</div>
<div style="display:grid;grid-template-columns:1fr 1.15fr 1fr;gap:6px;align-items:end;margin-bottom:10px">${podHTML}</div>
<div style="background:${t.surf};border:1px solid rgba(255,255,255,.08);border-radius:6px;overflow:hidden">${rowsHTML}</div>
<div style="margin-top:8px;font-size:8px;color:${t.mut};text-transform:uppercase;letter-spacing:.08em">Aperçu fidèle — chaque pilote affiche ${avatarModeLabel().apercu}</div>`;
}

// Jeu de demonstration partage par les 3 apercus (podium/classement/fiche) quand aucune
// session n'est utilisee comme reference — mêmes noms/karts/temps/ecarts pour que les 3
// rendus racontent une seule et même course cohérente.
const DEMO_RANKING = [
{ pos: 1, kart: 1, name: 'PILOTE 1', t: '1:02.345', gap: '—', best: '1:02.345', s1: '0:20.11', s2: '0:21.02', s3: '0:21.22' },
{ pos: 2, kart: 4, name: 'PILOTE 2', t: '1:04.542', gap: '+2.197', best: '1:04.201', s1: '0:20.55', s2: '0:21.40', s3: '0:22.55' },
{ pos: 3, kart: 7, name: 'PILOTE 3', t: '1:09.476', gap: '+7.131', best: '1:07.980', s1: '0:21.10', s2: '0:22.02', s3: '0:26.36' },
{ pos: 4, kart: 9, name: 'PILOTE 4', t: '1:11.745', gap: '+9.4', best: '1:09.512', s1: '0:21.40', s2: '0:22.90', s3: '0:27.41' },
{ pos: 5, kart: 2, name: 'PILOTE 5', t: '1:14.445', gap: '+12.1', best: '1:11.033', s1: '0:22.02', s2: '0:23.60', s3: '0:28.83' },
];

// Aperçu en direct du CLASSEMENT FINAL complet (tableau, avec avatars et écarts) — même
// palette THEME_COLORS et même fonction d'avatar (previewAvatarSVG) que le podium, pour
// rester un vrai rendu et non une maquette indépendante.
export function renderClassementPreview(theme, ranking) {
const box = document.getElementById('results-classement-preview');
if (!box) return;
const t = THEME_COLORS[theme || document.getElementById('pref-results-theme')?.value || state.prefs.results_theme || 'classic'] || THEME_COLORS.classic;
const data = ranking || DEMO_RANKING;
const rowsHTML = data.map((d) => `
<div style="display:grid;grid-template-columns:20px 30px 1fr auto auto;gap:7px;align-items:center;padding:6px 8px;border-top:1px solid rgba(255,255,255,.06)">
<span style="font-weight:900;font-style:italic;font-size:12px;color:${d.pos <= 3 ? t.acc : t.mut}">${d.pos}</span>
<div style="width:30px;height:30px;border-radius:50%;overflow:hidden;background:${t.bg};display:flex;align-items:center;justify-content:center">${previewAvatarSVG(d.kart)}</div>
<div><div style="font-weight:800;font-style:italic;font-size:11px;color:${t.text}">${d.name}</div><div style="font-size:8px;color:${t.mut}">KART ${d.kart} · ${d.t}</div></div>
<span style="font-size:9px;font-weight:800;color:${t.gapText};background:${t.gapBg};border:1px solid ${t.acc};padding:2px 6px;border-radius:4px">${d.gap}</span>
<span style="font-size:8px;color:${t.mut}">meilleur ${d.best}</span>
</div>`).join('');
box.style.cssText = `background:${t.bg};border:1px solid ${t.acc}44;border-radius:12px;padding:10px`;
box.innerHTML = `
<div style="display:flex;justify-content:space-between;align-items:center;border:1px solid ${t.acc}66;background:${t.surf};padding:8px 10px;border-radius:6px;margin-bottom:8px">
<div><div style="font-weight:900;font-size:13px;text-transform:uppercase;color:${t.text}">Classement final</div><div style="font-size:8px;color:${t.mut};margin-top:1px">CIRCUIT DE TRINISETTE · APERÇU</div></div>
</div>
<div style="background:${t.surf};border:1px solid rgba(255,255,255,.08);border-radius:6px;overflow:hidden">${rowsHTML}</div>
<div style="margin-top:8px;font-size:8px;color:${t.mut};text-transform:uppercase;letter-spacing:.08em">Aperçu fidèle — chaque pilote affiche ${avatarModeLabel().apercu}</div>`;
}

// Aperçu en direct de la FICHE PILOTE / TEMPS — reprend les mêmes champs que la fiche
// individuelle publique (nom, kart, meilleur tour, écart au leader, secteurs si activés).
export function renderFichePreview(theme, ranking) {
const box = document.getElementById('results-fiche-preview');
if (!box) return;
const t = THEME_COLORS[theme || document.getElementById('pref-results-theme')?.value || state.prefs.results_theme || 'classic'] || THEME_COLORS.classic;
const data = ranking || DEMO_RANKING;
const d = data[1] || data[0]; // pilote non-leader : l'écart au leader a du sens dans l'aperçu
const sectorsOn = !!document.getElementById('pref-sectors-enabled')?.checked;
const sectorsHTML = sectorsOn ? `
<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-top:10px">
${[['S1', d.s1], ['S2', d.s2], ['S3', d.s3]].map(([lbl, v]) => `
<div style="background:${t.surf};border:1px solid rgba(255,255,255,.08);border-radius:6px;padding:8px;text-align:center">
<div style="font-size:9px;color:${t.mut};text-transform:uppercase;letter-spacing:.06em">${lbl}</div>
<div style="font-size:13px;font-weight:800;color:${t.text};margin-top:2px">${v}</div>
</div>`).join('')}
</div>` : '';
box.style.cssText = `background:${t.bg};border:1px solid ${t.acc}44;border-radius:12px;padding:16px`;
box.innerHTML = `
<div style="display:flex;gap:16px;align-items:center">
<div style="width:96px;height:96px;flex:none;border-radius:${document.getElementById('pref-avatar-shape')?.value === 'square' ? '18px' : '50%'};overflow:hidden;background:${t.surf};display:flex;align-items:center;justify-content:center;border:2px solid ${t.acc}">${previewAvatarSVG(d.kart)}</div>
<div style="flex:1">
<div style="font-weight:900;font-style:italic;font-size:20px;color:${t.text}">${d.name}</div>
<div style="font-size:11px;color:${t.mut};margin-top:2px">KART ${d.kart} · POSITION ${d.pos}</div>
<div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap">
<span style="font-size:11px;font-weight:800;color:${t.text};background:${t.surf};border:1px solid ${t.acc};padding:3px 8px;border-radius:5px">Meilleur tour ${d.best}</span>
<span style="font-size:11px;font-weight:800;color:${t.gapText};background:${t.gapBg};border:1px solid ${t.acc};padding:3px 8px;border-radius:5px">Écart leader ${d.gap}</span>
<span style="font-size:11px;font-weight:700;color:${t.mut};background:${t.surf};border:1px solid rgba(255,255,255,.1);padding:3px 8px;border-radius:5px">Temps total ${d.t}</span>
</div>
</div>
</div>
${sectorsHTML}
<div style="margin-top:10px;font-size:8px;color:${t.mut};text-transform:uppercase;letter-spacing:.08em">Aperçu fidèle — même avatar, mêmes champs que la fiche pilote publique${sectorsOn ? '' : ' (secteurs desactives dans Sessions)'}</div>`;
}

// Galerie des avatars de la flotte (numéros de karts configurés, sinon 1→défaut).
export function renderKartAvatarGallery() {
const wrap = document.getElementById('kart-avatars-gallery');
if (!wrap) return;
// Le texte d'intro dépend du style d'avatar choisi dans l'onglet Thème : il
// parlait toujours du kart, même en mode « Pilote seul » où aucun numéro
// n'est affiché.
const intro = document.getElementById('kart-avatars-intro');
if (intro) {
if (currentPack() === 'signature') {
intro.innerHTML = 'Rendu du pack <b style="color:var(--txt)">Signature</b> pour les numéros de ta flotte, ' +
'au format et à la forme choisis ci-dessus :';
} else
intro.innerHTML = 'Chaque pilote reçoit automatiquement son avatar selon le ' +
'<b style="color:var(--txt)">style choisi dans l\'onglet Thème</b> — actuellement ' +
avatarModeLabel().gal + ' (identique d\'une session à l\'autre). ' +
'Voici le rendu pour les numéros de ta flotte :';
}
let nums = (state.prefs.kart_numbers || []).slice().sort((a, b) => a - b);
if (!nums.length) {
const max = Math.min(24, Number(state.prefs.default_karts) || 12);
nums = Array.from({ length: max }, (_, i) => i + 1);
}
wrap.innerHTML = nums.map((n) => `
<div style="background:var(--surf2);border:1px solid var(--bord);border-radius:10px;padding:8px 4px;text-align:center">
<div style="width:52px;height:54px;margin:0 auto">${previewAvatarSVG(n)}</div>
<div style="font-size:10px;font-weight:700;color:var(--mut);margin-top:4px">KART ${n}</div>
</div>`).join('');
}

export async function savePrefs() {
const karts = parseInt(document.getElementById('pref-karts').value) || 12;
const laps = parseInt(document.getElementById('pref-laps').value) || 5;
const unit = document.getElementById('pref-time-unit').value;
const lapsEnabled = document.getElementById('pref-laps-enabled').checked;
const kartsLocked = document.getElementById('pref-karts-locked').checked;
setPrefs({
default_karts: karts,
default_laps: laps,
time_unit: unit,
date_format: document.getElementById('pref-date-format')?.value === 'mdy' ? 'mdy' : 'dmy',
circuit_name: (document.getElementById('pref-circuit-name')?.value || '').trim().slice(0, CIRCUIT_NAME_MAX),
circuit_name_pdf_header: (document.getElementById('pref-circuit-name-pdf-header')?.value || '').trim().slice(0, CIRCUIT_HEAD_MAX),
circuit_name_pdf_footer: (document.getElementById('pref-circuit-name-pdf-footer')?.value || '').trim().slice(0, CIRCUIT_FOOT_MAX),
booking_url: (document.getElementById('pref-booking-url')?.value || '').trim().slice(0, 300),
laps_enabled: lapsEnabled,
karts_locked: kartsLocked,
kart_numbers: state.prefs.kart_numbers || [],
sectors_enabled: !!document.getElementById('pref-sectors-enabled')?.checked,
sector_count: Number(document.getElementById('pref-sector-count')?.value || 3),
chrono_import: document.getElementById('pref-chrono-custom')?.checked ? {
customized: true,
delimiter: document.getElementById('pref-chrono-delim')?.value || 'auto',
has_header: !!document.getElementById('pref-chrono-header')?.checked,
col_name: 0, // le nom du fichier n'est plus utilise : rapprochement par n° de kart
col_kart: parseInt(document.getElementById('pref-chrono-col-kart')?.value) || 2,
// 0 (ou vide) = le fichier n'a pas de colonne de tour, on numerote automatiquement par kart
col_lap: parseInt(document.getElementById('pref-chrono-col-lap')?.value) || 0,
col_time: parseInt(document.getElementById('pref-chrono-col-time')?.value) || 4,
col_sectors: String(document.getElementById('pref-chrono-col-sectors')?.value || '')
.split(',').map((s) => parseInt(s.trim())).filter((v) => Number.isFinite(v)),
} : null,
results_theme: document.getElementById('pref-results-theme')?.value || 'classic',
avatar_mode: document.getElementById('pref-avatar-mode')?.value || 'kart',
avatar_pack: currentPack(),
avatar_type: document.getElementById('pref-avatar-type')?.value || 'kartpilot',
avatar_small_type: document.getElementById('pref-avatar-small-type')?.value || 'helmet',
avatar_background: document.getElementById('pref-avatar-bg-on')?.checked
? (document.getElementById('pref-avatar-background')?.value || 'studio')
: 'none',
avatar_outline: !!document.getElementById('pref-avatar-outline')?.checked,
avatar_shape: document.getElementById('pref-avatar-shape')?.value || 'round',
card_qr_url: (document.getElementById('pref-card-url')?.value || '').trim().slice(0, 179),
card_tagline: (document.getElementById('pref-card-tagline')?.value || '').trim().slice(0, CARD_TAGLINE_MAX),
card_address: (document.getElementById('pref-card-address')?.value || '').trim().slice(0, 60),
card_position_picks: (state.prefs.card_position_picks || []).slice(0, CARD_POSITION_MAX),
card_record_picks: state.prefs.card_record_picks || {},
logo_url: state.prefs.logo_url || null,
session_types: readSessionTypesFromEditor(),
level_expert_max_seconds: Math.max(1, parseInt(document.getElementById('pref-level-expert')?.value, 10) || 45),
level_intermediaire_max_seconds: Math.max(1, parseInt(document.getElementById('pref-level-intermediaire')?.value, 10) || 55),
});
// Nettoyage de l'ancien système d'avatars (casques) s'il traîne encore dans les prefs.
delete state.prefs.helmet_choice;
delete state.prefs.helmet_colors;
try {
// supabase-js v2 NE LEVE PAS sur erreur : il resout avec { data, error }.
// Le try/catch autour de cet appel n'a donc jamais rien attrape, et l'appli
// affichait "Parametres enregistres !" meme quand Postgres refusait tout.
const { error: upErr } = await db.from('app_settings')
.upsert({ key: 'global', value: state.prefs }, { onConflict: 'tenant_id,key' });
if (upErr) {
if (upErr.code === '23502' || upErr.code === '42501') {
throw new Error('connexion admin requise pour enregistrer (auth non branchee)');
}
throw upErr;
}
showMsg('msg-prefs', 'Parametres enregistres !', 'ok');
// Les <select> de type de session refletent immediatement la nouvelle liste.
refreshSessionTypeSelects();
renderSessionTypesEditor();
showMsg('msg-kart-numbers', 'Numeros de karts enregistres !', 'ok');
updateDefaultsInfo();
state.prefsDirty = false;
await cleanupOrphanStorage();
} catch (e) {
showMsg('msg-prefs', 'Erreur: ' + e.message, 'err');
}
}

export function populateTimeSelect() {
const sel = document.getElementById('s-time');
let opts = '';
for (let h = 8; h <= 22; h++) {
for (let m = 0; m < 60; m += 30) {
const hh = String(h).padStart(2, '0');
const mm = String(m).padStart(2, '0');
opts += '<option value="' + hh + ':' + mm + '">' + hh + 'h' + mm + '</option>';
}
}
sel.innerHTML = opts;
const now = new Date();
const roundedMin = now.getMinutes() < 30 ? '00' : '30';
const cur = String(now.getHours()).padStart(2, '0') + ':' + roundedMin;
sel.value = cur;
}


// =====================================================================================
// Cartes resultat partageables (onglet Parametres > Cartes partageables)
// =====================================================================================
// Les visuels sont generes hors ligne (voir gen3.js dans le depot de design) et livres
// sous forme de vignettes /assets/cards/<concept>__<theme>.jpg : la vignette affichee
// suit donc automatiquement le theme choisi dans l'onglet Theme.
//
// Deux familles de cartes :
//   - POSITION  : jusqu'a 5 visuels coches ; a la fin d'une session chaque pilote en
//                 recoit UN, tire au hasard parmi les coches (varie d'une session a
//                 l'autre sans intervention de l'organisateur).
//   - RECORD    : un seul visuel par portee (piste / semaine / mois / perso). L'envoi
//                 est declenche par le serveur des qu'un chrono bat la reference, jamais
//                 a la main. Un pilote qui bat plusieurs records recoit plusieurs cartes,
//                 toujours accompagnees de sa carte de position.

/* Limites de caracteres des noms de circuit (31/07).
   CIRCUIT_NAME_MAX : nom affiche partout (web, cartes, apercus).
   CIRCUIT_HEAD_MAX : en-tete PDF. La zone la plus etroite est le bloc circuit de
   la FICHE PILOTE (200px de large a 12.5px) : au-dela de ~28 caracteres la police
   se reduit. On borne donc la saisie plutot que de laisser rapetisser.
   CIRCUIT_FOOT_MAX : pied de page PDF, pleine largeur, donc plus permissif. */
export const CIRCUIT_NAME_MAX = 40;
export const CIRCUIT_HEAD_MAX = 28;
export const CIRCUIT_FOOT_MAX = 60;

// Compteurs "x / max" sous les trois champs, meme principe que updateTaglineCount().
export function updateCircuitCounts() {
  const pairs = [
    ['pref-circuit-name', 'pref-circuit-name-count', CIRCUIT_NAME_MAX],
    ['pref-circuit-name-pdf-header', 'pref-circuit-name-pdf-header-count', CIRCUIT_HEAD_MAX],
    ['pref-circuit-name-pdf-footer', 'pref-circuit-name-pdf-footer-count', CIRCUIT_FOOT_MAX],
  ];
  pairs.forEach(([inputId, outId, max]) => {
    const inp = document.getElementById(inputId);
    const out = document.getElementById(outId);
    if (!inp || !out) return;
    const len = (inp.value || '').length;
    out.textContent = len + ' / ' + max;
    out.style.color = len >= max ? 'var(--acc)' : 'var(--mut)';
  });
}

export const CARD_TAGLINE_MAX = 46;   // 642 px utiles / ~14 px par glyphe Mono 20 px
export const CARD_POSITION_MAX = 5;

const CARD_CATALOG = {
position: [
{ id: '01-track-hero', name: 'Track Hero' },
{ id: '02-avatar-central', name: 'Avatar Central' },
{ id: '03-chrono-editorial', name: 'Chrono Editorial' },
{ id: '04-split-diagonal', name: 'Split Diagonal' },
{ id: '05-telemetrie', name: 'Telemetrie' },
{ id: '06-bloc-massif', name: 'Bloc Massif' },
{ id: '07-damier-dissous', name: 'Damier Dissous' },
{ id: '08-ligne-arrivee', name: "Ligne d'Arrivee" },
{ id: '09-grille-indice', name: 'Grille Indice' },
{ id: '10-filigrane', name: 'Filigrane Numero' },
],
perso: [
{ id: '01r-track-record', name: 'Track Hero — Record' },
{ id: '02r-avatar-record', name: 'Avatar Central — Record' },
],
piste: [{ id: '11r-record-piste', name: 'Record de la Piste' }],
semaine: [{ id: '12r-record-semaine', name: 'Record de la Semaine' }],
mois: [{ id: '13r-record-mois', name: 'Record du Mois' }],
};

const SCOPE_LABELS = {
perso: 'Record personnel du pilote',
piste: 'Record de la piste (absolu)',
semaine: 'Record de la semaine',
mois: 'Record du mois',
};

const cardThumb = (id) =>
'assets/cards/' + id + '__' + (state.prefs.results_theme || 'classic') + '.jpg';

function cardTile(item, on, dimmed) {
return '<div class="card-pick' + (on ? ' on' : '') + (dimmed ? ' off' : '') +
'" data-card-id="' + item.id + '">' +
'<img loading="lazy" src="' + cardThumb(item.id) + '" alt="' + item.name + '"/>' +
'<div class="cp-tick">&check;</div>' +
'<div class="cp-name">' + item.name + '</div></div>';
}

export function renderCardsTab() {
const picks = state.prefs.card_position_picks || [];
const grid = document.getElementById('cards-grid-position');
if (grid) {
const full = picks.length >= CARD_POSITION_MAX;
grid.innerHTML = CARD_CATALOG.position
.map((c) => cardTile(c, picks.includes(c.id), full && !picks.includes(c.id)))
.join('');
grid.querySelectorAll('.card-pick').forEach((el) => {
el.onclick = () => togglePositionCard(el.dataset.cardId);
});
}

const box = document.getElementById('cards-record-scopes');
if (box) {
const chosen = state.prefs.card_record_picks || {};
box.innerHTML = Object.keys(SCOPE_LABELS).map((scope) =>
'<div class="scope-block"><h4>' + SCOPE_LABELS[scope] + '</h4>' +
'<div class="cards-grid">' +
CARD_CATALOG[scope].map((c) => cardTile(c, chosen[scope] === c.id, false)).join('') +
'</div></div>'
).join('');
box.querySelectorAll('.scope-block').forEach((blk, i) => {
const scope = Object.keys(SCOPE_LABELS)[i];
blk.querySelectorAll('.card-pick').forEach((el) => {
el.onclick = () => pickRecordCard(scope, el.dataset.cardId);
});
});
}
renderCardQR();
updateTaglineCount();
}

function togglePositionCard(id) {
const picks = state.prefs.card_position_picks || (state.prefs.card_position_picks = []);
const i = picks.indexOf(id);
if (i >= 0) picks.splice(i, 1);
else if (picks.length < CARD_POSITION_MAX) picks.push(id);
else { showMsg('msg-prefs', CARD_POSITION_MAX + ' cartes de position au maximum.', false); return; }
markPrefsDirty();
renderCardsTab();
}

function pickRecordCard(scope, id) {
const picks = state.prefs.card_record_picks || (state.prefs.card_record_picks = {});
picks[scope] = picks[scope] === id ? null : id;   // un second clic retire la carte
markPrefsDirty();
renderCardsTab();
}

export function updateTaglineCount() {
const el = document.getElementById('pref-card-tagline');
const out = document.getElementById('tagline-count');
if (el && out) out.textContent = String(el.value.length);
}

// =====================================================================================
// QR UNIQUE DU CIRCUIT (31/07)
// =====================================================================================
// Les deux QR par session (inscription + resultats) ont ete retires de l'onglet
// Sessions : ils obligeaient a reimprimer un QR a chaque course. A la place, un
// seul QR permanent par circuit, base sur tenants.public_venue_token.
//
// Cible le 03/08 (client) : register.html?v=<token>, pas results.html?v=<token>.
// Un QR affiche a l'accueil sert d'abord a s'inscrire ; register.js sait deja
// basculer vers "Resultats" pour ce meme venueToken (nav-results-link,
// applyResultsNavLink), donc rien n'est perdu — on choisit juste le meilleur
// point d'entree pour quelqu'un qui scanne en arrivant sur le circuit.
let _venueLinkCache = null;

export async function loadVenueLink() {
  const input = document.getElementById('venue-link');
  const box = document.getElementById('venue-qr');
  if (!input && !box) return '';
  let url = _venueLinkCache;
  if (!url) {
    const { data, error } = await db.from('tenants').select('public_venue_token').limit(1).maybeSingle();
    if (error || !data || !data.public_venue_token) {
      if (input) input.value = '';
      if (box) box.innerHTML = '';
      return '';
    }
    url = window.location.origin + '/register?v=' + data.public_venue_token;
    _venueLinkCache = url;
  }
  if (input) input.value = url;
  if (box) {
    try { box.innerHTML = qrSVG(url); } catch (e) { box.innerHTML = ''; }
  }
  return url;
}

export async function copyVenueLink() {
  const url = document.getElementById('venue-link')?.value || await loadVenueLink();
  if (!url) return;
  try {
    await navigator.clipboard.writeText(url);
    const el = document.getElementById('venue-link');
    if (el) { const old = el.value; el.value = 'Lien copie !'; setTimeout(() => { el.value = old; }, 1200); }
  } catch (e) { /* presse-papiers indisponible : le champ reste selectionnable */ }
}

// Telechargement en PNG et non plus en SVG. Le SVG rendu dans la page porte
// width/height="100%" : parfait a l'ecran, inexploitable une fois telecharge, car
// le fichier n'a alors aucune dimension propre et s'ouvre vide dans l'Apercu, Photos
// ou Word. On regenere donc le QR depuis l'URL — et non depuis le DOM, pour ne pas
// dependre du fait que l'apercu soit rendu — et on exporte un PNG large, imprimable.
export async function downloadVenueQR() {
  const url = document.getElementById('venue-link')?.value || await loadVenueLink();
  if (!url) return;
  let cv;
  try { cv = qrCanvas(url, 1200); } catch (e) { return; }
  cv.toBlob((blob) => {
    if (!blob) return;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'qr-circuit.png';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }, 'image/png');
}

// Affichage plein ecran : sert a faire scanner le QR directement sur l'ecran, sans
// avoir a l'imprimer — utile a l'accueil comme en demonstration. image-rendering
// pixelated garde les modules nets a l'agrandissement, condition d'un scan rapide.
export async function enlargeVenueQR() {
  const url = document.getElementById('venue-link')?.value || await loadVenueLink();
  if (!url) return;
  document.getElementById('venue-qr-overlay')?.remove();
  let cv;
  try { cv = qrCanvas(url, 1400); } catch (e) { return; }

  const ov = document.createElement('div');
  ov.id = 'venue-qr-overlay';
  ov.setAttribute('role', 'dialog');
  ov.setAttribute('aria-label', 'QR code du circuit en grand');
  ov.style.cssText = 'position:fixed;inset:0;z-index:9999;background:rgba(5,6,10,.94);' +
    'display:flex;flex-direction:column;align-items:center;justify-content:center;' +
    'gap:20px;padding:24px;cursor:zoom-out';

  const title = document.createElement('div');
  title.textContent = 'Scannez ce QR code pour vous inscrire';
  title.style.cssText = 'color:#fff;font-size:19px;font-weight:800;text-align:center;letter-spacing:-.01em';

  cv.style.cssText = 'width:min(74vh,74vw);height:min(74vh,74vw);background:#fff;' +
    'border-radius:16px;padding:16px;box-sizing:border-box;image-rendering:pixelated';

  const hint = document.createElement('div');
  hint.textContent = 'Cliquez n\'importe ou, ou appuyez sur Echap, pour fermer';
  hint.style.cssText = 'color:rgba(255,255,255,.5);font-size:13px;text-align:center';

  ov.append(title, cv, hint);
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  function close() { ov.remove(); document.removeEventListener('keydown', onKey); }
  ov.addEventListener('click', close);
  document.addEventListener('keydown', onKey);
  document.body.appendChild(ov);
}

// QR genere localement (module qr.js) : aucun appel a un service tiers, donc l'URL du
// circuit ne fuite pas et les cartes restent generables hors ligne.
export function renderCardQR() {
const box = document.getElementById('card-qr-preview');
const note = document.getElementById('card-qr-note');
if (!box) return;
const url = (document.getElementById('pref-card-url')?.value || '').trim();
if (!url) {
box.innerHTML = '';
if (note) note.textContent = 'Sans URL, les cartes sont generees sans QR code.';
return;
}
try {
box.innerHTML = qrSVG(url);
if (note) note.textContent = 'QR valide — ' + url.length + '/179 caracteres.';
} catch (e) {
box.innerHTML = '';
if (note) note.textContent = 'URL trop longue pour un QR lisible (179 caracteres maximum).';
}
}

// =====================================================================================
// Sous-onglet Compte (onglet Parametres > Compte, refonte 30/07)
// =====================================================================================
// Reutilise la logique de plan existante (plan.js > getCurrentPlanCode()/hasFeature()) —
// aucun nouveau systeme de plan invente ici. La date de creation de compte n'est pas
// exposee par auth.getSession() (supabase-js v2 ne renvoie que l'access token dans la
// session cote client) ; on retombe donc sur "non disponible" plutot que de l'inventer.
export async function renderAccountTab() {
const badge = document.getElementById('account-plan-badge');
const upgradeRow = document.getElementById('account-upgrade-row');
const createdAt = document.getElementById('account-created-at');
if (badge) {
const plan = await getCurrentPlanCode();
const isPremium = plan === 'pro' || plan === 'business';
badge.textContent = isPremium ? 'Premium' : 'Free';
badge.className = 'plan-badge ' + (isPremium ? 'pro' : 'free');
if (upgradeRow) upgradeRow.style.display = isPremium ? 'none' : 'flex';
}
if (createdAt) {
try {
const { data } = await db.auth.getUser();
const raw = data?.user?.created_at;
createdAt.textContent = raw ? formatDate(raw) : 'Non disponible';
} catch (e) {
createdAt.textContent = 'Non disponible';
}
}
const emailDisplay = document.getElementById('account-email-display');
const sourceEmail = document.getElementById('login-user-email');
if (emailDisplay && sourceEmail && sourceEmail.textContent) emailDisplay.textContent = sourceEmail.textContent;
}

// Bouton "Changer le mot de passe" — appelle le module auth.js (aucune logique
// dupliquee), avec l'e-mail deja affiche par login-user-email (source unique).
export async function requestPasswordReset() {
const email = document.getElementById('login-user-email')?.textContent?.trim();
if (!email) {
showMsg('msg-account-security', 'Aucun e-mail de compte detecte.', 'err');
return;
}
try {
await authRequestPasswordReset(email);
showMsg('msg-account-security', 'E-mail de reinitialisation envoye a ' + email + '.', 'ok');
} catch (e) {
showMsg('msg-account-security', 'Erreur: ' + e.message, 'err');
}
}

// =====================================================================================
// Sous-onglet PDF & export (onglet Parametres > PDF & export, refonte 30/07 corrigee)
// =====================================================================================
// L'apercu precedent reconstruisait un tableau HTML approximatif (puis, dans une version
// intermediaire, appelait a tort buildSessionPDF() de results.js — un generateur de repli
// non utilise par le vrai flux de publication). Le vrai PDF que recoit un pilote est produit
// par buildFullPDF()/buildPilotPDF() dans public-results.js, exploite uniquement via le pont
// iframe cache decrit dans pdf-bridge.js/publish-pdfs.js (podium, avatars, theme circuit...).
// On reutilise ici EXACTEMENT le meme pont, pointe sur la session archivee choisie, pour que
// cet apercu soit le vrai fichier — octet pour octet — et pas une maquette qui pourrait un
// jour diverger du rendu reel.
let pdfPreviewSessions = [];
let pdfPreviewPilots = []; // liste des pilotes de la session choisie (regId/name), via le pont

async function fetchPdfPreviewSessions() {
  const { data } = await db
    .from('sessions')
    .select('id,title,session_date,session_type,public_results_token')
    .not('archived_at', 'is', null)
    .order('archived_at', { ascending: false })
    .limit(20);
  return data || [];
}

// URL blob des deux derniers PDF d'apercu generes : revoquees avant chaque nouveau rendu
// pour ne pas accumuler de blobs en memoire au fil des changements de session/onglet.
let pdfPreviewFullBlobUrl = null;
let pdfPreviewPilotBlobUrl = null;

function revokePdfPreviewUrls() {
  if (pdfPreviewFullBlobUrl) { URL.revokeObjectURL(pdfPreviewFullBlobUrl); pdfPreviewFullBlobUrl = null; }
  if (pdfPreviewPilotBlobUrl) { URL.revokeObjectURL(pdfPreviewPilotBlobUrl); pdfPreviewPilotBlobUrl = null; }
}

export async function refreshPdfPreview() {
  const root = document.getElementById('pdf-preview-root');
  const sel = document.getElementById('pdf-preview-session-select');
  const pilotSel = document.getElementById('pdf-preview-pilot-select');
  if (!root) return;
  // Le rendu reel (iframe + RPC + rasterisation html2canvas) prend plusieurs secondes :
  // etat de chargement explicite plutot qu'un apercu HTML instantane mais infidele.
  root.innerHTML = '<div class="msg"><span class="spin"></span> Generation de l\'apercu PDF reel (peut prendre quelques secondes)...</div>';

  try {
    if (!pdfPreviewSessions.length) pdfPreviewSessions = await fetchPdfPreviewSessions();
    if (sel && !sel.options.length) {
      sel.innerHTML = pdfPreviewSessions.length
        ? pdfPreviewSessions.map((s) => '<option value="' + s.id + '">' + (s.title || 'Session') + (s.session_date ? ' — ' + formatDate(s.session_date) : '') + '</option>').join('')
        : '<option value="">Aucune session publiee</option>';
    }
    const chosenId = sel?.value || (pdfPreviewSessions[0] && pdfPreviewSessions[0].id);
    const sess = pdfPreviewSessions.find((s) => s.id === chosenId);

    if (!sess || !sess.public_results_token) {
      pdfPreviewPilots = [];
      if (pilotSel) pilotSel.innerHTML = '';
      root.innerHTML = '<div class="msg">Aucune session publiée pour l\'instant — publie une session pour voir un aperçu réel des PDF.</div>';
      return;
    }

    const { iframe, loaded } = openHiddenFrame(exportUrl(sess.public_results_token));
    let api;
    try {
      await withTimeout(loaded, IFRAME_LOAD_TIMEOUT, 'chargement de la page de resultats');
      api = await waitForBridge(iframe);
      await withTimeout(Promise.resolve(api.ready), BRIDGE_TIMEOUT, 'chargement des donnees de la session');

      pdfPreviewPilots = api.listPilots() || [];
      if (pilotSel) {
        const prevPilot = pilotSel.value;
        pilotSel.innerHTML = pdfPreviewPilots.length
          ? pdfPreviewPilots.map((p) => '<option value="' + p.regId + '">' + (p.name || 'Pilote') + '</option>').join('')
          : '<option value="">Aucun pilote</option>';
        if (prevPilot && pdfPreviewPilots.some((p) => p.regId === prevPilot)) pilotSel.value = prevPilot;
      }
      const chosenPilotId = pilotSel?.value || (pdfPreviewPilots[0] && pdfPreviewPilots[0].regId);

      const fullBuf = await withTimeout(api.fullPDFBytes(), PDF_TIMEOUT, 'rendu du classement');
      let pilotBuf = null;
      if (chosenPilotId) {
        pilotBuf = await withTimeout(api.pilotPDFBytes(chosenPilotId), PDF_TIMEOUT, 'rendu de la fiche pilote');
      }

      revokePdfPreviewUrls();
      pdfPreviewFullBlobUrl = URL.createObjectURL(new Blob([fullBuf], { type: 'application/pdf' }));
      if (pilotBuf) pdfPreviewPilotBlobUrl = URL.createObjectURL(new Blob([pilotBuf], { type: 'application/pdf' }));

      root.innerHTML =
        '<div style="font-size:12px;font-weight:700;margin-bottom:6px">Classement complet</div>' +
        '<iframe src="' + pdfPreviewFullBlobUrl + '" title="Apercu classement PDF" style="width:100%;height:520px;border:1px solid var(--border,#333);border-radius:8px;background:#fff;margin-bottom:16px"></iframe>' +
        (pdfPreviewPilotBlobUrl
          ? '<div style="font-size:12px;font-weight:700;margin-bottom:6px">Fiche pilote</div>' +
            '<iframe src="' + pdfPreviewPilotBlobUrl + '" title="Apercu fiche pilote PDF" style="width:100%;height:520px;border:1px solid var(--border,#333);border-radius:8px;background:#fff"></iframe>'
          : '<div class="msg">Aucun pilote pour la fiche.</div>');
    } finally {
      // Toujours nettoyer l'iframe cachee : sinon chaque ouverture de l'onglet
      // Parametres en accumule une, avec sa page publique et ses timers actifs.
      if (iframe.parentNode) iframe.parentNode.removeChild(iframe);
    }
  } catch (e) {
    root.innerHTML = '<div class="msg err">Erreur apercu PDF: ' + e.message + '</div>';
  }
}
