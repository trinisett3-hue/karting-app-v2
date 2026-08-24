// État partagé de l'admin — repris à l'identique des variables globales de l'ancien
// index.html monofichier (mêmes noms, mêmes valeurs par défaut) pour ne rien casser
// côté logique métier existante. Exporté comme objet mutable unique : les modules
// lisent/écrivent `state.xxx` au lieu de variables globales éparpillées.

export const state = {
  activeSessions: [],
  activeDetailSession: null,
  inscritsData: [],
  // Catalogue d'ecuries resolu du circuit, charge a la demande par loadInscrits()
  // uniquement quand la session ouverte est en mode Ecurie.
  teamCatalog: [],
  archiveSession: null,
  selectedPilotId: null,
  helmetColors: null, // anciennement _helmetColors
  prefsDirty: false,

  // Préférences (paramètres) — valeurs par défaut identiques à l'existant.
  prefs: {
    default_karts: 12,
    default_laps: 5,
    time_unit: 'seconds',
    laps_enabled: true,
    karts_locked: true,
    kart_numbers: [],
    sectors_enabled: false,
    sector_count: 3,
    // Format d'import des chronos personnalisable (24/08, Trinisette) — null = format
    // canonique historique (Nom;Kart;NumTour[;S1..Sn];Temps, separateur ';'), aucun
    // changement de comportement pour un circuit qui n'a jamais touche ce reglage.
    // Objet {customized:true, delimiter, has_header, col_name, col_kart, col_lap,
    // col_time, col_sectors} des qu'un circuit personnalise (voir results.js >
    // getChronoImportFormat / normalizeChronoText).
    chrono_import: null,
    results_theme: 'classic',
    helmet_choice: 1,
    helmet_colors: null,
    logo_url: null, // logo du circuit (bucket Storage "org-logos"), affiché sur results.html
    date_format: 'dmy', // 'dmy' (JJ/MM/AAAA) ou 'mdy' (MM-DD-AAAA) — voir ui.js > formatDate()
    circuit_name: '', // nom du circuit, source de verite affichee (voir public-results.js)
    // Types de session configurables par l'organisation (02/08 client) : 3 par defaut,
    // 5 au maximum. Les fonctions de gestion sont en bas de ce fichier.
    session_types: [
      { v: 'loisir', l: 'Loisir' },
      { v: 'competition', l: 'Competition' },
      { v: 'initiation', l: 'Initiation' },
    ],
  },
};

export function markPrefsDirty() {
  state.prefsDirty = true;
}

export function setPrefs(newPrefs) {
  state.prefs = { ...state.prefs, ...newPrefs };
}

// ===========================================================================
// Types de session configurables par l'organisation.
//
// 02/08 (client) : "Tu vois dans type de session, il faudrait que ca ne soit pas defini
// par toi mais des champs a remplir par l'organisation et on va commencer par 3 par
// defauts et la possibilite de rajouter 2 de plus en cliquant sur un bouton + qui
// rajoute des champs."
//
// Jusqu'ici les quatre types (loisir / competition / initiation / entrainement) etaient
// ecrits en dur a cinq endroits : trois <select> dans admin.html, le filtre des archives,
// et deux tables de libelles dupliquees (app.js et sessions.js). Tout passe desormais par
// ces fonctions, alimentees par state.prefs.session_types (persiste dans app_settings.value).
//
// Format stocke : [{ v: 'loisir', l: 'Loisir' }, ...]
//   - v est la valeur ecrite dans sessions.session_type. Elle est figee a la creation du
//     type : renommer le libelle ne casse donc AUCUNE session deja enregistree.
//   - l est le libelle affiche, librement modifiable par l'organisation.
// Une session enregistree avec un type ensuite supprime de la liste garde sa valeur en
// base ; sessionTypeLabel() retombe alors sur un libelle lisible derive de v et les
// <select> reinjectent l'option manquante pour ne jamais perdre l'information.

export const MAX_SESSION_TYPES = 5;
export const DEFAULT_SESSION_TYPES = [
  { v: 'loisir', l: 'Loisir' },
  { v: 'competition', l: 'Competition' },
  { v: 'initiation', l: 'Initiation' },
];

// Slug stable a partir d'un libelle saisi : minuscules, sans accents, sans ponctuation.
export function slugifyType(label) {
  return String(label || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
}

// Libelle de repli quand la valeur en base ne figure plus dans la liste configuree.
function fallbackLabel(v) {
  const s = String(v || '').replace(/_/g, ' ').trim();
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : '';
}

// Liste normalisee, toujours exploitable meme si la preference est absente ou corrompue.
export function getSessionTypes() {
  const raw = state.prefs && state.prefs.session_types;
  if (!Array.isArray(raw)) return DEFAULT_SESSION_TYPES.slice();
  const seen = new Set();
  const out = [];
  for (const item of raw) {
    if (!item) continue;
    const l = String(typeof item === 'string' ? item : item.l || '').trim();
    if (!l) continue;
    let v = slugifyType(typeof item === 'string' ? item : item.v || l) || slugifyType(l);
    if (!v || seen.has(v)) continue;
    seen.add(v);
    out.push({ v, l });
    if (out.length >= MAX_SESSION_TYPES) break;
  }
  return out.length ? out : DEFAULT_SESSION_TYPES.slice();
}

// Valeur proposee par defaut a la creation d'une session.
export function defaultSessionType() {
  const list = getSessionTypes();
  return list.length ? list[0].v : '';
}

export function sessionTypeLabel(v) {
  if (!v) return '';
  const found = getSessionTypes().find((t) => t.v === v);
  return found ? found.l : fallbackLabel(v);
}

// Pastille utilisee dans les listes de sessions et d'archives.
//
// 20/08 (client) : une session Ecurie doit se reperer d'un coup d'oeil dans
// les listes, sinon rien ne distingue une session Loisir classique d'une
// session avec championnat constructeur — confusion vecue en direct. Le
// deuxieme parametre, quand true, REMPLACE le type (Loisir/Compet/...) par
// une pastille ECURIE plutot que de l'ajouter a cote : la session garde son
// session_type en base (utile pour les filtres/exports), mais l'admin n'a
// besoin de voir qu'une seule information ici.
export function sessionTypeBadgeHTML(v, teamMode) {
  if (teamMode) {
    return '<span class="sc-badge" style="background:rgba(255,122,42,.18);color:var(--org,#ff7a2a)">&Eacute;curie</span>';
  }
  const label = sessionTypeLabel(v);
  if (!label) return '';
  return '<span class="sc-badge" style="background:rgba(236,234,42,.15);color:var(--yel)">' + escapeTypeHTML(label) + '</span>';
}

function escapeTypeHTML(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// Remplit un <select> avec les types configures. La valeur courante est preservee : si elle
// n'est plus dans la liste (type supprime depuis), une option dediee est reinjectee pour que
// l'enregistrement du formulaire ne l'ecrase pas silencieusement.
export function fillSessionTypeSelect(id, opts) {
  const sel = document.getElementById(id);
  if (!sel) return;
  const options = opts || {};
  const previous = sel.value;
  const list = getSessionTypes();
  let html = '';
  if (options.allLabel) html += '<option value="">' + escapeTypeHTML(options.allLabel) + '</option>';
  for (const t of list) html += '<option value="' + escapeTypeHTML(t.v) + '">' + escapeTypeHTML(t.l) + '</option>';
  if (previous && !list.some((t) => t.v === previous)) {
    html += '<option value="' + escapeTypeHTML(previous) + '">' + escapeTypeHTML(fallbackLabel(previous)) + ' (retire)</option>';
  }
  sel.innerHTML = html;
  if (previous) sel.value = previous;
  if (!sel.value && !options.allLabel && list.length) sel.value = list[0].v;
}

const TYPE_SELECT_IDS = ['s-type', 'det-type-input', 'arch-type-input'];

// Rejoue le remplissage de tous les selecteurs de type de l'admin. Appelee au chargement des
// preferences et apres chaque enregistrement, pour que la liste soit a jour partout sans
// rechargement de page.
export function refreshSessionTypeSelects() {
  TYPE_SELECT_IDS.forEach((id) => fillSessionTypeSelect(id));
  fillSessionTypeSelect('arch-type-filter', { allLabel: 'Tous les types' });
}

// --- Editeur (Parametres > Sessions) -----------------------------------------------------

// Lignes actuellement affichees dans l'editeur (au moins 3, au plus 5).
let editorRows = [];

function renderEditorRows() {
  const wrap = document.getElementById('pref-session-types-rows');
  if (!wrap) return;
  wrap.innerHTML = editorRows
    .map((row, i) =>
      '<div class="stype-row">' +
      '<span class="stype-num">' + (i + 1) + '</span>' +
      '<input type="text" id="pref-stype-' + i + '" value="' + escapeTypeHTML(row.l) + '" maxlength="28" ' +
      'placeholder="' + (i < 3 ? 'Ex: Loisir' : 'Ex: Anniversaire, Team building') + '" ' +
      'oninput="onSessionTypeInput()" />' +
      '<button type="button" class="stype-del" title="Vider ce champ" onclick="clearSessionTypeRow(' + i + ')">&times;</button>' +
      '</div>')
    .join('');
  const addBtn = document.getElementById('pref-stype-add');
  if (addBtn) addBtn.disabled = editorRows.length >= MAX_SESSION_TYPES;
  updateSessionTypesCount();
}

function updateSessionTypesCount() {
  const el = document.getElementById('pref-session-types-count');
  if (!el) return;
  const filled = readSessionTypesFromEditor().length;
  el.textContent = filled + (filled > 1 ? ' types' : ' type') + ' sur ' + MAX_SESSION_TYPES +
    (editorRows.length >= MAX_SESSION_TYPES ? ' - maximum de champs atteint' : '');
}

// Construit l'editeur a partir des preferences chargees.
export function renderSessionTypesEditor() {
  const list = getSessionTypes();
  editorRows = list.map((t) => ({ v: t.v, l: t.l }));
  while (editorRows.length < 3) editorRows.push({ v: '', l: '' });
  renderEditorRows();
}

export function addSessionTypeRow() {
  syncEditorFromDOM();
  if (editorRows.length >= MAX_SESSION_TYPES) return;
  editorRows.push({ v: '', l: '' });
  renderEditorRows();
  const input = document.getElementById('pref-stype-' + (editorRows.length - 1));
  if (input) input.focus();
  markPrefsDirty();
}

export function clearSessionTypeRow(i) {
  syncEditorFromDOM();
  if (!editorRows[i]) return;
  // Au-dela des 3 champs de base la ligne disparait ; en deca elle est seulement videe,
  // pour garder la structure "3 par defaut" du formulaire.
  if (editorRows.length > 3) editorRows.splice(i, 1);
  else editorRows[i] = { v: '', l: '' };
  renderEditorRows();
  markPrefsDirty();
}

function syncEditorFromDOM() {
  editorRows = editorRows.map((row, i) => {
    const input = document.getElementById('pref-stype-' + i);
    return { v: row.v, l: input ? input.value : row.l };
  });
}

export function onSessionTypeInput() {
  syncEditorFromDOM();
  updateSessionTypesCount();
  markPrefsDirty();
}

// Valeur a enregistrer. Un champ vide = type retire. Les valeurs v deja attribuees sont
// conservees telles quelles pour ne pas orphaliner les sessions existantes ; une ligne
// nouvellement remplie recoit un slug derive de son libelle (suffixe en cas de collision).
export function readSessionTypesFromEditor() {
  const wrap = document.getElementById('pref-session-types-rows');
  if (!wrap) return getSessionTypes();
  const used = new Set();
  const out = [];
  editorRows.forEach((row, i) => {
    const input = document.getElementById('pref-stype-' + i);
    const l = String(input ? input.value : row.l || '').trim();
    if (!l) return;
    let v = row.v || slugifyType(l) || 'type';
    if (used.has(v)) {
      let n = 2;
      while (used.has(v + '_' + n)) n++;
      v = v + '_' + n;
    }
    used.add(v);
    out.push({ v, l });
  });
  return out.slice(0, MAX_SESSION_TYPES);
}
