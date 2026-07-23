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

// --- Navigation entre onglets (Créer / Actives / Archives / Paramètres) ------------------
// Reprend exactement la logique originale : avertit avant de quitter Paramètres si des
// changements ne sont pas enregistrés.

async function renderArchivesList() {
  const list = await sessions.loadArchives();
  const el = document.getElementById('arch-list');
  if (!el) return;
  if (!list.length) {
    el.innerHTML = '<div class="empty">Aucune session archivee.</div>';
    return;
  }
  const groups = {};
  list.forEach((s) => {
    const d = s.session_date || s.created_at.slice(0, 10);
    if (!groups[d]) groups[d] = [];
    groups[d].push(s);
  });
  const { formatDate } = await import('./modules/ui.js');
  el.innerHTML = Object.entries(groups)
    .map(
      ([date, dayList]) =>
        '<div class="day-lbl">' + formatDate(date) + '</div>' +
        dayList
          .map(
            (s) =>
              '<div class="arch-item" onclick="openArchiveDetail(\'' + s.id + '\')">' +
              '<div><div class="arch-title">' + s.title + '</div><div class="arch-meta">' + s.max_karts + ' karts</div></div>' +
              '<div class="flex">' +
              '<button class="btn btn-ghost btn-sm icon-btn" title="Voir" onclick="event.stopPropagation();openArchiveDetail(\'' + s.id + '\')"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z"/><circle cx="12" cy="12" r="3"/></svg></button>' +
              '<button class="btn btn-red btn-sm icon-btn" title="Supprimer" onclick="event.stopPropagation();deleteSession(\'' + s.id + '\').then(loadArchives)"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg></button>' +
              '</div></div>'
          )
          .join('')
    )
    .join('');
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
  const names = ['creer', 'actives', 'archives', 'parametres'];
  document.querySelectorAll('.sb-tab').forEach((t, i) => t.classList.toggle('active', names[i] === tab));
  document.querySelectorAll('.panel').forEach((p) => p.classList.remove('active'));
  document.getElementById('panel-' + tab).classList.add('active');
  if (tab === 'creer') settings.updateDefaultsInfo();
  if (tab === 'actives') {
    sessions.backToActivesList();
    sessions.loadActiveSessions();
  }
  if (tab === 'archives') loadArchivesTab();
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
    },
  });
}

async function deleteActiveSessionAndGoBack() {
  await sessions.deleteActiveSession({ afterDelete: () => switchTab('actives') });
}

async function terminerSessionAndGoBack() {
  await sessions.terminerSession({ afterEnd: () => switchTab('actives') });
}

async function loadArchives() {
  await renderArchivesList();
}

// --- Initialisation ------------------------------------------------------------------------

window.addEventListener('DOMContentLoaded', async () => {
  await settings.loadPrefs();
  settings.populateTimeSelect();
  settings.updateDefaultsInfo();
  await sessions.loadActiveSessions();
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
  // Inscriptions & karts
  addUnknownParticipant: sessions.addUnknownParticipant,
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
  archTogglePres: results.archTogglePres,
  deleteSession: results.deleteSession,
  loadArchives,
  // Résultats & import chronos
  exportCSV: results.exportCSV,
  showPilotHistory: results.showPilotHistory,
  closeHistory: results.closeHistory,
  handleChronoFile: results.handleChronoFile,
  importChrono: results.importChrono,
  publishResults: results.publishResults,
  copyLink: results.copyLink,
  zoomQR: results.zoomQR,
  closeZoom: results.closeZoom,
  togglePres: results.togglePres,
  toggleSectorsField: results.toggleSectorsField,
  updateChronoFormat: results.updateChronoFormat,
  // Paramètres
  markPrefsDirty: () => (state.prefsDirty = true),
  addKartNumber: settings.addKartNumber,
  removeKartNumber: settings.removeKartNumber,
  autoFillKartNumbers: settings.autoFillKartNumbers,
  toggleLapsField: settings.toggleLapsField,
  switchAppearanceSubtab: settings.switchAppearanceSubtab,
  selectResultsTheme: settings.selectResultsTheme,
  regenerateHelmetColors: settings.regenerateHelmetColors,
  chooseHelmet: settings.chooseHelmet,
  savePrefs: settings.savePrefs,
});
