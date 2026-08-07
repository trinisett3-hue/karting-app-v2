// Point d'entrée de l'admin Karting V2 — orchestrateur.
//
// Rôle : (1) initialiser l'app au chargement de la page (identique au
// window.addEventListener('DOMContentLoaded', ...) de l'original), (2) attacher toutes
// les fonctions utilisées en onclick="..." dans le HTML sur `window`, puisque les modules
// ES ne sont pas globaux par défaut, (3) gérer switchTab() qui orchestre plusieurs
// modules (sessions, archives, paramètres) sans que ceux-ci aient besoin de se connaître
// entre eux.
//
// Charger ce fichier dans admin.html avec : <script type="module" src="src/app.js"></script>
// (après le <script src=".../supabase-js@2"> et le <script src=".../xlsx...">).

import { state } from './state.js';
import * as sessions from './modules/sessions.js';
import * as results from './modules/results.js';
import * as settings from './modules/settings.js';
import * as auth from './modules/auth.js';
import * as stats from './modules/stats.js';
import * as registry from './modules/registry.js';
import * as manualAdd from './modules/manual-add.js';
import * as sessionTypes from './state.js';
import * as archivesExport from './modules/archives-export.js';
import { hasFeature } from './modules/plan.js';
// Auth branchée (24/07) : l'admin nécessite désormais une session Supabase Auth valide.
// Voir doLogin()/doLogout() et l'overlay #login-overlay dans admin.html.

// --- Navigation entre onglets (Créer / Actives / Archives / Paramètres) ------------------
// Reprend exactement la logique originale : avertit avant de quitter Paramètres si des
// changements ne sont pas enregistrés.

// Pastille de type de session. 02/08 (client) : la liste n'est plus ecrite en dur ici,
// elle vient de Parametres > Sessions (state.prefs.session_types) via state.js.
const sessionTypeBadge = sessionTypes.sessionTypeBadgeHTML;

let archivesCache = [];

async function renderArchivesList() {
const el = document.getElementById('arch-list');
if (!el) return;
archivesCache = await sessions.loadArchives();
archivesExport.invalidateArchivesExportCache();
fillArchiveDayFilter();
renderFilteredArchives();
}

// Le filtre jour est construit a partir des sessions reellement archivees :
// proposer un calendrier complet ferait choisir des jours vides.
function fillArchiveDayFilter() {
const sel = document.getElementById('arch-day-filter');
if (!sel) return;
const previous = sel.value;
const days = [];
archivesCache.forEach((s) => {
const d = s.session_date || (s.created_at || '').slice(0, 10);
if (d && !days.includes(d)) days.push(d);
});
importUiHelpers().then(({ formatDate }) => {
sel.innerHTML =
'<option value="">Tous les jours</option>' +
days.map((d) => '<option value="' + d + '">' + formatDate(d) + '</option>').join('');
// On restaure la selection si le jour existe toujours (rechargement
// apres suppression d'une session, par exemple).
if (previous && days.includes(previous)) sel.value = previous;
});
}

function renderFilteredArchives() {
const el = document.getElementById('arch-list');
if (!el) return;
const filterEl = document.getElementById('arch-type-filter');
const filterType = filterEl ? filterEl.value : '';
const dayEl = document.getElementById('arch-day-filter');
const filterDay = dayEl ? dayEl.value : '';
const list = archivesCache.filter(
(s) =>
(!filterType || s.session_type === filterType) &&
(!filterDay || (s.session_date || (s.created_at || '').slice(0, 10)) === filterDay)
);
if (!list.length) {
el.innerHTML = '<div class="empty">Aucune session archivee pour ce filtre.</div>';
return;
}
const groups = {};
list.forEach((s) => {
const d = s.session_date || s.created_at.slice(0, 10);
if (!groups[d]) groups[d] = [];
groups[d].push(s);
});
importUiHelpers().then(({ formatDate }) => {
el.innerHTML = Object.entries(groups)
.map(
([date, dayList]) =>
'<div class="day-lbl">' + formatDate(date) + '</div>' +
dayList
.map(
(s) =>
'<div class="arch-item" onclick="openArchiveDetail(\'' + s.id + '\')">' +
'<div><div class="arch-title">' + s.title +
(s.internal_notes ? ' <span title="Note interne presente" style="display:inline-block;width:7px;height:7px;border-radius:50%;background:var(--yel);margin-left:4px"></span>' : '') +
'</div><div class="arch-meta flex" style="gap:6px;margin-top:2px">' + s.max_karts + ' karts' + (sessionTypeBadge(s.session_type) ? ' ' + sessionTypeBadge(s.session_type) : '') + '</div></div>' +
'<div class="flex">' +
'<button class="btn btn-ghost btn-sm icon-btn" title="Voir" onclick="event.stopPropagation();openArchiveDetail(\'' + s.id + '\')"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z"/><circle cx="12" cy="12" r="3"/></svg></button>' +
'<button class="btn btn-red btn-sm icon-btn" title="Supprimer" onclick="event.stopPropagation();deleteSession(\'' + s.id + '\').then(loadArchives)"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg></button>' +
'</div></div>'
)
.join('')
)
.join('');
});
}

function filterArchives() {
renderFilteredArchives();
}

function resetArchiveFilters() {
const t = document.getElementById('arch-type-filter');
const d = document.getElementById('arch-day-filter');
if (t) t.value = '';
if (d) d.value = '';
renderFilteredArchives();
}

let _uiHelpersPromise = null;
function importUiHelpers() {
  if (!_uiHelpersPromise) _uiHelpersPromise = import('./modules/ui.js');
  return _uiHelpersPromise;
}

async function loadArchivesTab() {
await renderArchivesList();
}

function switchTab(tab) {
const isLeavingParams = document.getElementById('panel-parametres').classList.contains('active');
if (isLeavingParams && state.prefsDirty && tab !== 'parametres') {
const ok = confirm('Vous avez des modifications non enregistrees dans Parametres. Voulez-vous vraiment quitter sans enregistrer ?');
if (!ok) return;
state.prefsDirty = false;
settings.loadPrefs();
}
const names = ['creer', 'actives', 'archives', 'stats', 'registre', 'parametres'];
document.querySelectorAll('.sb-tab').forEach((t, i) => t.classList.toggle('active', names[i] === tab));
document.querySelectorAll('.panel').forEach((p) => p.classList.remove('active'));
document.getElementById('panel-' + tab).classList.add('active');
if (tab === 'creer') settings.updateDefaultsInfo();
if (tab === 'actives') {
sessions.backToActivesList();
sessions.loadActiveSessions();
}
if (tab === 'archives') loadArchivesTab();
if (tab === 'stats') stats.loadStatsTab();
if (tab === 'registre') registry.loadRegistryTab();
}

// --- Wrappers qui recollent les morceaux entre modules (remplacent les callbacks
// implicites que l'original obtenait en ayant tout dans un seul fichier) ------------------

async function createSessionAndOpen() {
await sessions.createSession({
onCreated: async (id) => {
switchTab('actives');
await openActiveDetailAndShowResults(id);
},
});
}

async function openActiveDetailAndShowResults(id) {
await sessions.openActiveDetail(id, {
onOpened: async () => {
await results.renderResultatsSection();
// Point 2.1 : rejouer la verification a l'ouverture, pas seulement juste apres
// avoir clique sur Publier — l'admin revient souvent sur la session plus tard.
results.refreshPublishVerify().catch(() => {});
},
});
}

async function deleteActiveSessionAndGoBack() {
await sessions.deleteActiveSession({ afterDelete: () => switchTab('actives') });
}

async function terminerSessionAndGoBack() {
const { formatTime } = await importUiHelpers();
await sessions.terminerSession({
afterEnd: () => switchTab('actives'),
loadRanking: results.loadRanking,
formatTime,
});
}

async function loadArchives() {
await renderArchivesList();
}

// Branchement de l'historique des chronos sur le bouton horloge de chaque inscrit.
// sessions.js ne connaît pas results.js : c'est app.js, qui connaît les deux, qui
// recolle les morceaux (correctif audit 30/07, le bouton ne faisait rien avant).
sessions.setInscritsRowActions({ onHistory: results.showPilotHistory });

// --- Exports de session : lecture de l'état ICI, pas dans l'attribut onclick ---------------
// Correctif audit 30/07 : le HTML appelait `exportCSV(activeDetailSession)`. Or un
// attribut onclick ne résout ses identifiants que dans la portée GLOBALE, et la session
// courante n'existe que comme propriété `state.activeDetailSession` — jamais sur window.
// Le handler levait donc un ReferenceError AVANT même d'appeler la fonction : les quatre
// boutons « Exporter CSV » / « Exporter PDF » (session active ET archive) étaient inertes.
// On expose désormais des wrappers sans argument qui vont chercher l'état eux-mêmes.

function exportActiveCSV() {
return results.exportCSV(state.activeDetailSession);
}

function exportActivePDF(btn) {
return results.exportSessionPDF(state.activeDetailSession, btn, 'res');
}

// Flag 'archive_export' (voir plan.js) : export CSV/PDF d'une archive INDIVIDUELLE. Les
// boutons sont deja desactives cote UI pour un compte Basique (voir
// results.js > refreshArchiveExportButtons()), on revalide ici aussi. Ne concerne pas
// l'export GLOBAL CSV/XLSX de la liste des archives (archivesExport, reste Basique).
async function exportArchiveCSV() {
if (!(await hasFeature('archive_export'))) return;
return results.exportCSV(state.archiveSession);
}

async function exportArchivePDF(btn) {
if (!(await hasFeature('archive_export'))) return;
return results.exportSessionPDF(state.archiveSession, btn, 'arch');
}

// --- Authentification -----------------------------------------------------------------------
// L'admin est désormais protégé : rien n'est initialisé (sessions/results/settings) tant
// qu'une session Supabase Auth valide n'est pas confirmée. L'overlay #login-overlay est
// visible par défaut dans le HTML (fail-closed) et n'est masqué qu'après connexion réussie.

let appInitialized = false;

function showLoginOverlay(message) {
const overlay = document.getElementById('login-overlay');
if (overlay) overlay.classList.add('show');
const msgEl = document.getElementById('login-msg');
if (msgEl) {
msgEl.textContent = message || '';
msgEl.className = message ? 'msg err' : 'msg';
}
}

function hideLoginOverlay() {
const overlay = document.getElementById('login-overlay');
if (overlay) overlay.classList.remove('show');
}

async function initAppOnce(session) {
if (appInitialized) return;
appInitialized = true;
const emailEl = document.getElementById('login-user-email');
if (emailEl && session?.user?.email) emailEl.textContent = session.user.email;
await settings.loadPrefs();
settings.populateTimeSelect();
settings.updateDefaultsInfo();
await sessions.loadActiveSessions();
}

async function doLogin() {
const emailInput = document.getElementById('login-email');
const passwordInput = document.getElementById('login-password');
const email = (emailInput?.value || '').trim();
const password = passwordInput?.value || '';
const msgEl = document.getElementById('login-msg');
if (!email || !password) {
if (msgEl) { msgEl.textContent = 'Email et mot de passe requis.'; msgEl.className = 'msg err'; }
return;
}
if (msgEl) { msgEl.textContent = 'Connexion...'; msgEl.className = 'msg ok'; }
try {
const session = await auth.signIn(email, password);
hideLoginOverlay();
await initAppOnce(session);
} catch (err) {
if (msgEl) { msgEl.textContent = err?.message || 'Identifiants invalides.'; msgEl.className = 'msg err'; }
}
}

async function doLogout() {
await auth.signOut();
appInitialized = false;
location.reload();
}

// --- Mot de passe oublie : ecran de choix d'un nouveau mot de passe -------------------------
// Le lien recu par e-mail ouvre l'admin avec un jeton de recuperation. Deux voies mènent
// ici, volontairement redondantes : le drapeau window.__kartexRecovery pose par le script
// inline d'admin.html (le SDK efface le fragment avant que ce module ne s'execute) et
// l'evenement PASSWORD_RECOVERY. Tant que le mot de passe n'est pas change, on n'initialise
// PAS l'application : le client ne doit voir que ce formulaire.

let recoveryMode = false;

function showRecoveryOverlay() {
recoveryMode = true;
hideLoginOverlay();
const overlay = document.getElementById('recovery-overlay');
if (overlay) overlay.classList.add('show');
}

function hideRecoveryOverlay() {
recoveryMode = false;
const overlay = document.getElementById('recovery-overlay');
if (overlay) overlay.classList.remove('show');
}

function setRecoveryMsg(text, kind) {
const el = document.getElementById('recovery-msg');
if (!el) return;
el.textContent = text || '';
el.className = text ? 'msg ' + (kind || 'err') : 'msg';
}

async function submitNewPassword() {
const pass = document.getElementById('recovery-password')?.value || '';
const pass2 = document.getElementById('recovery-password2')?.value || '';
if (pass.length < 8) {
setRecoveryMsg('Le mot de passe doit contenir au moins 8 caracteres.', 'err');
return;
}
if (pass !== pass2) {
setRecoveryMsg('Les deux mots de passe ne sont pas identiques.', 'err');
return;
}
const btn = document.getElementById('recovery-btn');
if (btn) btn.disabled = true;
setRecoveryMsg('Enregistrement...', 'ok');
try {
await auth.updatePassword(pass);
setRecoveryMsg('Mot de passe modifie. Ouverture de votre espace...', 'ok');
// On efface le jeton de recuperation de l'URL : un rechargement ne doit pas rouvrir
// cet ecran, et le lien ne doit pas rester dans l'historique du navigateur.
try { history.replaceState(null, '', window.location.pathname); } catch (e) {}
hideRecoveryOverlay();
const session = await auth.getSession();
if (session) {
await initAppOnce(session);
} else {
showLoginOverlay('Mot de passe modifie. Connecte-toi avec ton nouveau mot de passe.');
}
} catch (err) {
setRecoveryMsg(err?.message || 'Impossible de modifier le mot de passe.', 'err');
} finally {
if (btn) btn.disabled = false;
}
}

auth.onAuthStateChange((session, event) => {
if (event === 'PASSWORD_RECOVERY') showRecoveryOverlay();
});

// --- Initialisation ------------------------------------------------------------------------

window.addEventListener('DOMContentLoaded', async () => {
if (window.__kartexRecovery || recoveryMode) {
showRecoveryOverlay();
return;
}
const session = await auth.getSession();
if (session) {
hideLoginOverlay();
await initAppOnce(session);
} else {
showLoginOverlay();
}
});

window.addEventListener('beforeunload', (e) => {
if (state.prefsDirty) {
e.preventDefault();
e.returnValue = '';
}
});

// --- Exposition sur window pour les onclick="..." du HTML ---------------------------------
// Le HTML (index.html) n'a pas été réécrit avec des addEventListener : il utilise encore
// onclick="nomFonction(...)" partout, comme l'original. On expose donc chaque fonction
// utilisée par le HTML.

Object.assign(window, {
// Types de session configurables (Parametres > Sessions)
addSessionTypeRow: sessionTypes.addSessionTypeRow,
clearSessionTypeRow: sessionTypes.clearSessionTypeRow,
onSessionTypeInput: sessionTypes.onSessionTypeInput,
// Authentification
doLogin,
doLogout,
submitNewPassword,
// Navigation
switchTab,
// Sessions
createSession: createSessionAndOpen,
openActiveDetail: openActiveDetailAndShowResults,
backToActivesList: sessions.backToActivesList,
markDetailDirty: sessions.markDetailDirty,
saveDetailMeta: sessions.saveDetailMeta,
deleteActiveSession: deleteActiveSessionAndGoBack,
terminerSession: terminerSessionAndGoBack,
closeRecapModal: sessions.closeRecapModal,
confirmTerminerSession: sessions.confirmTerminerSession,
// Inscriptions & karts
// addUnknownParticipant reste expose : la modale s'appuie sur le meme
// garde-fou de capacite, et d'anciens raccourcis peuvent encore l'appeler.
addUnknownParticipant: sessions.addUnknownParticipant,
openManualAdd: manualAdd.openManualAdd,
closeManualAdd: manualAdd.closeManualAdd,
manualAddSetMode: manualAdd.manualAddSetMode,
manualAddSearch: manualAdd.manualAddSearch,
manualAddCreate: manualAdd.manualAddCreate,
manualAddAnonymous: manualAdd.manualAddAnonymous,
loadInscrits: sessions.loadInscrits,
saveNameInline: sessions.saveNameInline,
assignKartToPilot: sessions.assignKartToPilot,
reassignKart: sessions.reassignKart,
assignMissingKarts: sessions.assignMissingKarts,
autoKarts: sessions.autoKarts,
// Archives
openArchiveDetail: results.openArchiveDetail,
backToArchives: results.backToArchives,
archPublish: results.archPublish,
archCopyLink: results.archCopyLink,
deleteSession: results.deleteSession,
loadArchives,
filterArchives,
resetArchiveFilters,
exportArchivesCSV: archivesExport.exportArchivesCSV,
exportArchivesXLSX: archivesExport.exportArchivesXLSX,
saveArchiveMeta: results.saveArchiveMeta,
// Résultats & import chronos
exportCSV: results.exportCSV,
exportActiveCSV,
exportActivePDF,
exportArchiveCSV,
exportArchivePDF,
showPilotHistory: results.showPilotHistory,
closeHistory: results.closeHistory,
handleChronoFile: results.handleChronoFile,
importChrono: results.importChrono,
publishResults: results.publishResults,
copyLink: results.copyLink,
toggleSectorsField: results.toggleSectorsField,
updateChronoFormat: results.updateChronoFormat,
exportSessionPDF: results.exportSessionPDF,
verifyPublication: results.verifyPublication,
resendPilot: results.resendPilot,
downloadChronoImport: results.downloadChronoImport,
// Paramètres
markPrefsDirty: () => (state.prefsDirty = true),
addKartNumber: settings.addKartNumber,
removeKartNumber: settings.removeKartNumber,
autoFillKartNumbers: settings.autoFillKartNumbers,
toggleLapsField: settings.toggleLapsField,
switchParamsSubtab: settings.switchParamsSubtab,
selectResultsTheme: settings.selectResultsTheme,
renderCardsTab: settings.renderCardsTab,
renderCardQR: settings.renderCardQR,
copyVenueLink: settings.copyVenueLink,
downloadVenueQR: settings.downloadVenueQR,
enlargeVenueQR: settings.enlargeVenueQR,
updateTaglineCount: settings.updateTaglineCount,
updateCircuitCounts: settings.updateCircuitCounts,
selectAvatarMode: settings.selectAvatarMode,
selectAvatarPack: settings.selectAvatarPack,
renderSignatureControls: settings.renderSignatureControls,
refreshAppearancePreviews: settings.refreshAppearancePreviews,
uploadLogo: settings.uploadLogo,
removeLogo: settings.removeLogo,
savePrefs: settings.savePrefs,
refreshPdfPreview: settings.refreshPdfPreview,
requestPasswordReset: settings.requestPasswordReset,
// Statistiques
selectStatsRange: stats.selectStatsRange,
switchStatsSubtab: stats.switchStatsSubtab,
statsShiftYear: stats.statsShiftYear,
statsPickMonth: stats.statsPickMonth,
statsPickYear: stats.statsPickYear,
onStatsCustomChange: stats.onStatsCustomChange,
exportStatsXLSX: stats.exportStatsXLSX,
// Registre
loadRegistryTab: registry.loadRegistryTab,
filterRegistry: registry.filterRegistry,
gotoRegistryPage: registry.gotoRegistryPage,
confirmDeletePilot: registry.confirmDeletePilot,
confirmDeleteLegacy: registry.confirmDeleteLegacy,
exportRegistryCSV: registry.exportRegistryCSV,
exportRegistryXLSX: registry.exportRegistryXLSX,
togglePromoFilter: registry.togglePromoFilter,
withdrawPromoConsent: registry.withdrawPromoConsent,
startEditRegistry: registry.startEditRegistry,
cancelRegistryEdit: registry.cancelRegistryEdit,
saveRegistryEdit: registry.saveRegistryEdit,
});
