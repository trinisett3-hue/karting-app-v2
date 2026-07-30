// Module Statistiques — Point 7 (onglet "Statistiques" : KPIs globaux, fréquentation,
// top 10 meilleurs temps absolus, top 5 pilotes par nb de sessions) et Point 9
// (Hall of Fame : meilleur temps par kart + classement permanent top 10 pilotes).
//
// Toutes les requêtes sont volontairement dépourvues de filtre explicite sur
// tenant_id : une fois l'authentification admin branchée (Point 1, fait le 24/07),
// les policies RLS "*_auth" (voir migration-v2.sql) filtrent déjà automatiquement
// sur le tenant de l'admin connecté — un filtre client-side serait redondant et,
// pire, pourrait laisser croire à tort qu'il protège quelque chose côté navigateur.
import { db, fetchAll, fetchAllIn } from '../lib/supabase.js';
import { formatTime, formatDate } from './ui.js';
import { PREMIUM_THEMES } from './settings.js';
import { hasFeature, renderPremiumLock } from './plan.js';

let chartInstance = null;
// 🆕 v20 : Basique — l'onglet Statistiques reste un pack leger (KPIs globaux,
// exploitation piste, Hall of Fame chronos compact). Les blocs "Top 5 pilotes
// (nb sessions jouees)" et "Classement permanent (meilleur temps unique par
// pilote)" ont ete retires : ce sont des analyses de frequentation/sportives
// qui relevent de le pack Premium, pas du pack de base. Le code ci-dessous ne les
// calcule donc plus (voir git history si besoin de les reprendre).
//
// Les blocs de l'onglet Statistiques sont conserves en memoire au fil de
// loadStatsTab() pour que l'export (XLSX multi-onglets, voir
// exportStatsXLSX()) reprenne exactement ce qui est affiche a l'ecran, pour
// le filtre en cours, sans requete DB supplementaire.
let lastKpis = { sessions: 0, pilotsUniques: 0, chronos: 0 };
let lastHofKarts = [];
let lastExploitation = { avgFill: null, minFill: null, maxFill: null, utilizationRate: null, sessionsPerDay: null, sessionsPerWeek: null, days: 0 };

// --- Exploitation piste (Basique, MVP) --------------------------------------------------
// Ni la table `sessions` ni les Parametres n'ont aujourd'hui de champ "duree
// de session" ou "horaires d'ouverture" — ajouter un vrai reglage sort du
// perimetre de cette tache (Basique = pack leger, pas de nouvelle UI de
// configuration). En attendant, on utilise deux constantes simples et
// documentees : une duree moyenne de session estimee, et un nombre d'heures
// d'ouverture par jour par defaut. Le "taux d'utilisation piste" qui en
// decoule est donc une ESTIMATION volontairement simple (demandee telle
// quelle dans le cahier des charges), pas une mesure exacte — a affiner plus
// tard avec un vrai reglage d'horaires cote Parametres si besoin.
const DEFAULT_AVG_SESSION_MINUTES = 15;
const DEFAULT_OPENING_HOURS_PER_DAY = 8;

function pct(v) {
  return v == null ? '--' : Math.round(v * 100) + '%';
}

// Nombre de jours couverts par la plage filtree — utilise pour "sessions par
// jour/semaine" et le taux d'utilisation piste. Sur les plages bornees
// (jour/semaine/mois/annee/personnalise) c'est simplement (to - from). Sur
// "Depuis le debut" (pas de bornes), seule reference disponible : l'etendue
// reelle entre la premiere et la derniere session existante.
function daysInRangeCount(range, allSessions) {
  if (range && range.from && range.to) {
    const from = new Date(range.from + 'T12:00:00');
    const to = new Date(range.to + 'T12:00:00');
    return Math.max(1, Math.round((to - from) / 86400000) + 1);
  }
  const dates = allSessions.map((s) => s.session_date).filter(Boolean).sort();
  if (!dates.length) return 0;
  const from = new Date(dates[0] + 'T12:00:00');
  const to = new Date(dates[dates.length - 1] + 'T12:00:00');
  return Math.max(1, Math.round((to - from) / 86400000) + 1);
}

// KPIs "Exploitation piste" (Basique) : taux de remplissage moyen des
// sessions (pilotes inscrits / capacite max), taux d'utilisation piste
// (estimation simple, voir constantes ci-dessus) et sessions par jour/semaine.
// `regsCountBySession` : Map(session_id -> nb d'inscrits), deja disponible
// dans loadStatsTab() a partir de `allRegs` — aucune requete DB de plus.
function computeExploitationKpis(allSessions, regsCountBySession, range) {
  const fillRates = [];
  allSessions.forEach((s) => {
    const cap = Number(s.max_karts) || 0;
    if (!cap) return; // pas de capacite connue pour cette session : exclue du taux
    const count = regsCountBySession.get(s.id) || 0;
    fillRates.push(Math.min(1, count / cap));
  });
  const avgFill = fillRates.length ? fillRates.reduce((a, b) => a + b, 0) / fillRates.length : null;
  const minFill = fillRates.length ? Math.min(...fillRates) : null;
  const maxFill = fillRates.length ? Math.max(...fillRates) : null;

  const days = daysInRangeCount(range, allSessions);
  const totalSessionMinutes = allSessions.length * DEFAULT_AVG_SESSION_MINUTES;
  const theoreticalMinutes = days > 0 ? days * DEFAULT_OPENING_HOURS_PER_DAY * 60 : 0;
  const utilizationRate = theoreticalMinutes > 0 ? Math.min(1, totalSessionMinutes / theoreticalMinutes) : null;

  const sessionsPerDay = days > 0 ? allSessions.length / days : null;
  const sessionsPerWeek = sessionsPerDay != null ? sessionsPerDay * 7 : null;

  return { avgFill, minFill, maxFill, utilizationRate, sessionsPerDay, sessionsPerWeek, days };
}

// Filtre de plage de dates courant — { key, from, to } ; from/to sont des
// chaines 'YYYY-MM-DD' ou null pour "Depuis le debut". Conserve entre deux
// rendus pour que exportStatsXLSX() sache quel libelle mettre dans le nom
// de fichier sans devoir re-parser le DOM.
let currentRange = { key: 'all', from: null, to: null };
let lastTimeRows = [];
// 🆕 v17 : valeurs "brutes" saisies pour mois/annee/personnalise (distinctes de
// currentRange.from/to qui sont les bornes RESOLUES) — permet de repeupler les
// champs de saisie correspondants quand on revient sur un filtre déjà utilisé,
// et de recalculer sans redemander la valeur à chaque fois.
let rangeExtra = { month: null, year: null, from: null, to: null };

const RANGE_LABELS = {
  jour: 'Jour',
  semaine: 'Semaine',
  mois: 'Mois',
  annee: 'Annee',
  personnalise: 'Personnalise',
  all: 'Depuis le debut',
};

function toDateStr(d) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function fmtRangeDate(dateStr) {
  return new Date(dateStr + 'T12:00:00').toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

// Calcule les bornes { from, to } pour une clef de filtre donnee. `opts`
// permet de préciser un mois/annee/plage personnalisée autre que celle par
// défaut (courante) — voir rangeExtra plus haut. Reutilise mondayOf()
// (extrait de l'ancien isoWeekLabel()) pour que le debut de semaine reste
// coherent avec le graphique de frequentation.
export function computeRangeBounds(key, opts) {
  opts = opts || {};
  const today = new Date();
  today.setHours(12, 0, 0, 0);
  if (key === 'jour') {
    const s = toDateStr(today);
    return { key, from: s, to: s };
  }
  if (key === 'semaine') {
    const monday = mondayOf(today);
    const sunday = new Date(monday);
    sunday.setDate(sunday.getDate() + 6);
    return { key, from: toDateStr(monday), to: toDateStr(sunday) };
  }
  if (key === 'mois') {
    const year = opts.year != null ? Number(opts.year) : today.getFullYear();
    const month = opts.month != null ? Number(opts.month) : today.getMonth(); // 0-based
    const first = new Date(year, month, 1);
    const last = new Date(year, month + 1, 0);
    return { key, from: toDateStr(first), to: toDateStr(last) };
  }
  if (key === 'annee') {
    const year = opts.year != null ? Number(opts.year) : today.getFullYear();
    const first = new Date(year, 0, 1);
    const last = new Date(year, 11, 31);
    return { key, from: toDateStr(first), to: toDateStr(last) };
  }
  if (key === 'personnalise') {
    const from = opts.from || toDateStr(today);
    const to = opts.to || from;
    return { key, from, to: to < from ? from : to };
  }
  return { key: 'all', from: null, to: null };
}

// Bouton de filtre cliqué depuis admin.html (rangée pill/segmentée) : recalcule
// les bornes et relance le chargement de l'onglet, puis met à jour l'état visuel.
export function selectStatsRange(key) {
  const today = new Date();
  if (key === 'mois' && rangeExtra.month == null) {
    rangeExtra.month = today.getMonth();
    rangeExtra.year = today.getFullYear();
  }
  if (key === 'annee' && rangeExtra.year == null) {
    rangeExtra.year = today.getFullYear();
  }
  if (key === 'personnalise' && !rangeExtra.from) {
    rangeExtra.from = toDateStr(today);
    rangeExtra.to = toDateStr(today);
  }
  currentRange = computeRangeBounds(key, rangeExtra);
  document.querySelectorAll('.stats-range-btn').forEach((b) => {
    b.classList.toggle('selected', b.dataset.rangeVal === currentRange.key);
  });
  syncRangeControls();
  loadStatsTab(currentRange);
}

// Sous-onglets de l'onglet Statistiques (voir admin.html > panel-statistiques) : un
// seul bloc de contenu visible a la fois pour reduire la quantite d'info affichee.
// Les filtres de plage (selectStatsRange ci-dessus) restent partages entre tous les
// sous-onglets — seule la visibilite change ici, aucune donnee n'est rechargee.
const STATS_SUBTABS = ['overview', 'hof', 'fid', 'perf', 'qualite'];
export function switchStatsSubtab(tab) {
  if (!STATS_SUBTABS.includes(tab)) return;
  STATS_SUBTABS.forEach((key) => {
    const panel = document.getElementById('stats-subtab-' + key);
    if (panel) panel.classList.toggle('active', key === tab);
  });
  document.querySelectorAll('.subtab-btn[data-stab-val]').forEach((b) => {
    b.classList.toggle('selected', b.dataset.stabVal === tab);
  });
}

// Changement du mois choisi (input type="month", value "YYYY-MM").
export function onStatsMonthPick(value) {
  if (!value) return;
  const [y, m] = value.split('-').map(Number);
  rangeExtra.year = y;
  rangeExtra.month = m - 1;
  currentRange = computeRangeBounds('mois', rangeExtra);
  updateRangeDisplay();
  loadStatsTab(currentRange);
}

// Changement de l'année choisie (input type="number").
export function onStatsYearPick(value) {
  const y = Number(value);
  if (!y || y < 1900) return;
  rangeExtra.year = y;
  currentRange = computeRangeBounds('annee', rangeExtra);
  updateRangeDisplay();
  loadStatsTab(currentRange);
}

// Changement d'une des deux dates de la période personnalisée.
export function onStatsCustomChange() {
  const fromEl = document.getElementById('stats-custom-from');
  const toEl = document.getElementById('stats-custom-to');
  if (!fromEl || !toEl) return;
  const from = fromEl.value || rangeExtra.from;
  let to = toEl.value || rangeExtra.to;
  if (from && to && to < from) {
    to = from;
    toEl.value = to;
  }
  rangeExtra.from = from;
  rangeExtra.to = to;
  currentRange = computeRangeBounds('personnalise', rangeExtra);
  updateRangeDisplay();
  loadStatsTab(currentRange);
}

// Affiche/masque les champs de saisie complémentaires (mois, annee, plage
// personnalisée) selon le filtre actif, et les pré-remplit avec la valeur en
// cours — évite de perdre la sélection quand on revient sur "Mois" par ex.
function syncRangeControls() {
  const monthInput = document.getElementById('stats-month-input');
  const yearInput = document.getElementById('stats-year-input');
  const fromInput = document.getElementById('stats-custom-from');
  const toInput = document.getElementById('stats-custom-to');
  const sep = document.getElementById('stats-custom-sep');
  [monthInput, yearInput, fromInput, toInput, sep].forEach((el) => {
    if (el) el.style.display = 'none';
  });
  if (currentRange.key === 'mois' && monthInput) {
    monthInput.style.display = 'inline-block';
    monthInput.value = rangeExtra.year + '-' + String(rangeExtra.month + 1).padStart(2, '0');
  }
  if (currentRange.key === 'annee' && yearInput) {
    yearInput.style.display = 'inline-block';
    yearInput.value = rangeExtra.year;
  }
  if (currentRange.key === 'personnalise') {
    if (fromInput) { fromInput.style.display = 'inline-block'; fromInput.value = rangeExtra.from || ''; }
    if (sep) sep.style.display = 'inline-block';
    if (toInput) { toInput.style.display = 'inline-block'; toInput.value = rangeExtra.to || ''; }
  }
  updateRangeDisplay();
}

// Affiche la date de début (et de fin si différente) de la période
// actuellement filtrée — demandé explicitement pour la période personnalisée,
// mais utile aussi pour Jour/Semaine/Mois/Annee.
function updateRangeDisplay() {
  const el = document.getElementById('stats-range-display');
  if (!el) return;
  if (!currentRange.from) {
    el.textContent = '';
    return;
  }
  const fromTxt = fmtRangeDate(currentRange.from);
  const toTxt = currentRange.to && currentRange.to !== currentRange.from ? fmtRangeDate(currentRange.to) : null;
  el.textContent = toTxt ? ('Periode affichee : du ' + fromTxt + ' au ' + toTxt) : ('Date affichee : ' + fromTxt);
}

// `icon` : simple emoji, optionnel — demande explicitement ("icones simples")
// pour les 3 tuiles de KPIs globaux, reutilise aussi pour Exploitation piste.
// `info` : texte d'aide optionnel (picto (i), hover ou clic/tap) expliquant la
// metrique et son calcul — ajoute le 29/07 suite a une demande de clarification
// sur les onglets Vue d'ensemble / Fidelisation (voir .info-ico/.info-tip dans
// admin.html pour le style, et le listener global juste en-dessous pour la
// fermeture au clic exterieur sur mobile/tactile).
function kpiBox(lbl, val, sub, icon, info) {
ensureInfoTipListener();
const infoHtml = info
? ' <span class="info-ico" tabindex="0" onclick="event.stopPropagation();this.classList.toggle(\'open\')" aria-label="Explication">i<span class="info-tip">' + info + '</span></span>'
: '';
return (
'<div class="card" style="text-align:center;padding:16px">' +
(icon ? '<div style="font-size:20px;margin-bottom:4px" aria-hidden="true">' + icon + '</div>' : '') +
'<div style="font-size:11px;color:var(--mut);text-transform:uppercase;font-weight:700;margin-bottom:6px">' + lbl + infoHtml + '</div>' +
'<div style="font-size:22px;font-weight:900">' + val + '</div>' +
(sub ? '<div style="font-size:11px;color:var(--mut);margin-top:4px">' + sub + '</div>' : '') +
'</div>'
);
}

// Ferme tous les tooltips (.info-ico.open) au clic en dehors — necessaire pour
// le mode tactile (pas de hover sur mobile/tablette), n'ajoute le listener
// qu'une seule fois meme si kpiBox() est appelee des dizaines de fois.
let _infoTipListenerAdded = false;
function ensureInfoTipListener() {
if (_infoTipListenerAdded) return;
_infoTipListenerAdded = true;
document.addEventListener('click', (e) => {
if (!e.target.closest('.info-ico')) {
document.querySelectorAll('.info-ico.open').forEach((el) => el.classList.remove('open'));
}
});
}

export async function loadStatsTab(range) {
  currentRange = range || currentRange || { key: 'all', from: null, to: null };
  const kpiGrid = document.getElementById('stats-kpi-grid');
  const exploitationGrid = document.getElementById('stats-exploitation-grid');
  const topTimesEl = document.getElementById('stats-top-times');
  const hofKartsEl = document.getElementById('stats-hof-karts');
  if (kpiGrid) kpiGrid.innerHTML = '<div class="empty">Chargement...</div>';

  // P0-5 (audit 30/07) : toutes les lectures de masse passent par fetchAll/fetchAllIn.
  // Sans .range(), PostgREST plafonnait chaque réponse à 1000 lignes SANS erreur :
  // au-delà d'une cinquantaine de sessions, les statistiques devenaient fausses en
  // silence (chronos manquants, pilotes uniques sous-comptés).
  const sessRes = await fetchAll(() => {
    let q = db.from('sessions').select('id,session_date,created_at,max_karts,starts_at,incident_count,interruption_minutes');
    if (currentRange.from) q = q.gte('session_date', currentRange.from);
    if (currentRange.to) q = q.lte('session_date', currentRange.to);
    return q;
  });
  const allSessions = sessRes.data || [];
  const sessionIds = allSessions.map((s) => s.id);

  // Sur "Depuis le debut" (pas de filtre), on garde les requetes globales
  // telles quelles pour ne rien changer au comportement existant. Sur un
  // filtre actif, on restreint regs/laps aux sessions déjà filtrées via
  // .in('session_id', ...) plutôt que de filtrer côté client — plus proche
  // du style existant (filtres appliqués côté requête) et ça évite de
  // retélécharger des lignes qui seront de toute façon jetées.
  const regsSelect = () => db.from('session_registrations').select('id,session_id,display_name,kart_number,nationality,is_unknown,created_at');
  const lapsSelect = () => db.from('laps').select('registration_id,lap_time_seconds,session_id');
  const filtered = !!(currentRange.from || currentRange.to);
  const [regsRes, lapsRes] = await Promise.all([
    filtered ? fetchAllIn(regsSelect, 'session_id', sessionIds) : fetchAll(regsSelect),
    filtered ? fetchAllIn(lapsSelect, 'session_id', sessionIds) : fetchAll(lapsSelect),
  ]);
  const allRegs = regsRes.data || [];
  const allLaps = lapsRes.data || [];

  // --- KPIs globaux -----------------------------------------------------------------------
  const uniquePilots = new Set(allRegs.map((r) => (r.display_name || '').trim().toLowerCase()).filter(Boolean));
  lastKpis = { sessions: allSessions.length, pilotsUniques: uniquePilots.size, chronos: allLaps.length };
  if (kpiGrid) {
    kpiGrid.innerHTML =
      kpiBox('Sessions', allSessions.length, null, '🏁', 'Nombre de sessions sur la periode selectionnee (filtre en haut de page).') +
      kpiBox('Pilotes uniques', uniquePilots.size, null, '👤', 'Nombre de pseudos differents (normalises) ayant participe au moins une fois sur la periode. Deux orthographes differentes du meme pilote comptent comme 2 pilotes.') +
      kpiBox('Chronos enregistres', allLaps.length, null, '⏱️', 'Nombre total de tours chronometres enregistres sur la periode.');
  }

  // --- Exploitation piste + Frequentation (Premium — flag 'session_occupancy') -----------
  // 30/07 : ces deux blocs de la Vue d'ensemble passent en Premium (KPIs globaux et
  // Hall of Fame restent Basique). IMPORTANT, meme principe que loadPremiumStatsBlocks() :
  // le verrou est verifie AVANT tout calcul — computeExploitationKpis() et
  // renderFrequencyChart() ne tournent pas du tout si le plan ne l'autorise pas, pas de
  // fuite de donnees dans le DOM.
  const occupancyAllowed = await hasFeature('session_occupancy');
  if (!occupancyAllowed) {
    lastExploitation = { avgFill: null, minFill: null, maxFill: null, utilizationRate: null, sessionsPerDay: null, sessionsPerWeek: null, days: 0 };
    renderPremiumLock('stats-exploitation-grid');
    renderPremiumLock('stats-freq-card');
    if (chartInstance) { chartInstance.destroy(); chartInstance = null; }
  } else {
    const regsCountBySession = new Map();
    allRegs.forEach((r) => {
      regsCountBySession.set(r.session_id, (regsCountBySession.get(r.session_id) || 0) + 1);
    });
    const exploitation = computeExploitationKpis(allSessions, regsCountBySession, currentRange);
    lastExploitation = exploitation;
    if (exploitationGrid) {
      exploitationGrid.innerHTML =
        kpiBox(
          'Remplissage moyen',
          pct(exploitation.avgFill),
          exploitation.avgFill != null ? 'min ' + pct(exploitation.minFill) + ' · max ' + pct(exploitation.maxFill) : 'Aucune session avec capacite connue',
          '🪑', 'Moyenne du taux de remplissage (inscrits / places max) des sessions ayant une capacite renseignee. Les sessions sans capacite definie sont ignorees dans ce calcul.'
        ) +
        kpiBox(
          'Utilisation piste (estimee)',
          pct(exploitation.utilizationRate),
          'Base : ' + DEFAULT_OPENING_HOURS_PER_DAY + 'h/jour, session ≈' + DEFAULT_AVG_SESSION_MINUTES + 'min',
          '📈', 'Estimation simple : (nb sessions x 15 min) / (nb jours de la periode x 8h d\'ouverture). Basee sur des valeurs par defaut, pas sur de vrais horaires configures -- a affiner si besoin.'
        ) +
        kpiBox(
          'Sessions / jour',
          exploitation.sessionsPerDay != null ? exploitation.sessionsPerDay.toFixed(1) : '--',
          exploitation.days ? 'sur ' + exploitation.days + ' jour(s)' : null,
          '📅', 'Nombre de sessions divise par le nombre de jours couverts par la periode selectionnee.'
        ) +
        kpiBox(
          'Sessions / semaine',
          exploitation.sessionsPerWeek != null ? exploitation.sessionsPerWeek.toFixed(1) : '--',
          null,
          '🗓️', 'Sessions / jour x 7.'
        );
    }
  }

  // --- Totaux par inscription (pour le top temps) -----------------------------------------
  const regsById = new Map(allRegs.map((r) => [r.id, r]));
  const totalsByReg = new Map();
  allLaps.forEach((l) => {
    if (!l.registration_id) return;
    totalsByReg.set(l.registration_id, (totalsByReg.get(l.registration_id) || 0) + Number(l.lap_time_seconds || 0));
  });
  const sessionsById = new Map(allSessions.map((s) => [s.id, s]));

  // --- Top 10 meilleurs temps absolus (tous pilotes, toutes sessions) --------------------
  const timeRows = [];
  totalsByReg.forEach((total, regId) => {
    const reg = regsById.get(regId);
    if (!reg) return;
    const sess = sessionsById.get(reg.session_id);
    timeRows.push({ name: reg.display_name || '--', kart: reg.kart_number, total, date: sess ? sess.session_date : null });
  });
  timeRows.sort((a, b) => a.total - b.total);
  lastTimeRows = timeRows;
  if (topTimesEl) {
    const top = timeRows.slice(0, 10);
    topTimesEl.innerHTML = top.length
      ? '<table class="rank-tbl"><thead><tr><th>#</th><th>Nom</th><th>Kart</th><th>Temps</th><th>Date</th></tr></thead><tbody>' +
        top.map((r, i) => '<tr><td>' + (i + 1) + '</td><td>' + r.name + '</td><td>' + (r.kart || '--') + '</td><td>' + formatTime(r.total) + '</td><td>' + (r.date ? formatDate(r.date) : '--') + '</td></tr>').join('') +
        '</tbody></table>'
      : '<div class="empty">Aucun chrono enregistre.</div>';
  }

  // --- Hall of Fame : meilleur temps (au tour) par numero de kart ------------------------
  const bestLapByKart = new Map();
  allLaps.forEach((l) => {
    if (!l.registration_id) return;
    const reg = regsById.get(l.registration_id);
    if (!reg || reg.kart_number == null) return;
    const kart = Number(reg.kart_number);
    const t = Number(l.lap_time_seconds);
    const cur = bestLapByKart.get(kart);
    if (!cur || t < cur.time) bestLapByKart.set(kart, { time: t, name: reg.display_name, sessionId: reg.session_id });
  });
  lastHofKarts = Array.from(bestLapByKart.entries()).map(([kart, v]) => ({ kart, ...v })).sort((a, b) => a.kart - b.kart);
  if (hofKartsEl) {
    const kartRows = lastHofKarts;
    hofKartsEl.innerHTML = kartRows.length
      ? '<table class="rank-tbl"><thead><tr><th>Kart</th><th>Meilleur tour</th><th>Pilote</th></tr></thead><tbody>' +
        kartRows.map((r) => '<tr><td>' + r.kart + '</td><td>' + formatTime(r.time) + '</td><td>' + (r.name || '--') + '</td></tr>').join('') +
        '</tbody></table>'
      : '<div class="empty">Aucun tour enregistre.</div>';
  }

  // --- Fréquentation : adaptée à la période filtrée (voir renderFrequencyChart) -----------
  // Fait partie du meme verrou 'session_occupancy' que l'exploitation piste ci-dessus.
  if (occupancyAllowed) renderFrequencyChart(allSessions, currentRange);

  // --- Premium : fidelisation, performance avancee, qualite, utilisation avancee ---------
  // Section entierement separee (voir plus bas dans ce fichier) — ne modifie rien de ce
  // qui precede, se contente de lire allSessions/allRegs/allLaps/timeRows deja charges
  // pour le filtre en cours. Enveloppee dans un try/catch : un souci sur un bloc Premium
  // (ex. table session_ratings pas encore migree chez un tenant) ne doit jamais casser
  // l'affichage Basique ci-dessus, deja rendu a ce stade.
  try {
    await loadPremiumStatsBlocks(allSessions, allRegs, allLaps, timeRows, currentRange);
  } catch (e) {
    console.warn('[stats] blocs Premium indisponibles.', e);
  }
}

// Lundi de la semaine contenant `date`. Extrait de l'ancien isoWeekLabel()
// pour être partagé avec computeRangeBounds('semaine') — même math, un
// seul endroit qui décide de "quand commence la semaine".
function mondayOf(date) {
  const d = new Date(date);
  const day = (d.getDay() + 6) % 7; // 0 = lundi
  d.setDate(d.getDate() - day);
  d.setHours(0, 0, 0, 0);
  return d;
}

function isoWeekLabel(date) {
  // Lundi de la semaine contenant `date`, affiché "DD/MM".
  return mondayOf(date);
}

// 🆕 v17 : le graphique s'adapte désormais à la période filtrée au lieu de
// toujours afficher les 8 dernières semaines glissantes depuis aujourd'hui
// (c'était le bug remonté — "reste fixe a 8 semaines"). Comportement :
//  - "Depuis le debut" (pas de bornes) : on garde l'ancien affichage par
//    défaut (8 dernières semaines glissantes), c'est le seul cas où il n'y a
//    aucune borne naturelle à représenter.
//  - "Jour" : une seule barre pour ce jour-là.
//  - Autres (semaine/mois/annee/personnalise) : découpage par semaine si la
//    période fait moins de ~130 jours, sinon par mois (évite un graphique à
//    des dizaines de barres illisibles sur une longue période personnalisée).
function renderFrequencyChart(allSessions, range) {
  const canvas = document.getElementById('stats-freq-chart');
  if (!canvas || typeof Chart === 'undefined') return;
  const titleEl = document.getElementById('stats-freq-title');
  const useRange = range && range.from && range.to && range.key !== 'all';
  let labels, counts;

  if (!useRange) {
    const weeks = [];
    const today = new Date();
    today.setHours(12, 0, 0, 0);
    for (let i = 7; i >= 0; i--) {
      const d = new Date(today);
      d.setDate(d.getDate() - i * 7);
      weeks.push(isoWeekLabel(d));
    }
    counts = weeks.map(() => 0);
    allSessions.forEach((s) => {
      const dRaw = s.session_date || (s.created_at ? s.created_at.slice(0, 10) : null);
      if (!dRaw) return;
      const monday = isoWeekLabel(dRaw + 'T12:00:00');
      const idx = weeks.findIndex((w) => w.getTime() === monday.getTime());
      if (idx >= 0) counts[idx]++;
    });
    labels = weeks.map((w) => w.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit' }));
    if (titleEl) titleEl.textContent = 'Frequentation (8 dernieres semaines)';
  } else if (range.key === 'jour') {
    const d = new Date(range.from + 'T12:00:00');
    labels = [d.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit' })];
    counts = [allSessions.length];
    if (titleEl) titleEl.textContent = 'Frequentation (jour selectionne)';
  } else {
    const from = new Date(range.from + 'T12:00:00');
    const to = new Date(range.to + 'T12:00:00');
    const spanDays = Math.max(1, Math.round((to - from) / 86400000));
    if (spanDays > 130) {
      const buckets = [];
      let cur = new Date(from.getFullYear(), from.getMonth(), 1);
      const end = new Date(to.getFullYear(), to.getMonth(), 1);
      while (cur <= end) {
        buckets.push(new Date(cur));
        cur = new Date(cur.getFullYear(), cur.getMonth() + 1, 1);
      }
      counts = buckets.map(() => 0);
      allSessions.forEach((s) => {
        const dRaw = s.session_date || (s.created_at ? s.created_at.slice(0, 10) : null);
        if (!dRaw) return;
        const d = new Date(dRaw + 'T12:00:00');
        const idx = buckets.findIndex((b) => b.getFullYear() === d.getFullYear() && b.getMonth() === d.getMonth());
        if (idx >= 0) counts[idx]++;
      });
      labels = buckets.map((b) => b.toLocaleDateString('fr-FR', { month: 'short', year: '2-digit' }));
      if (titleEl) titleEl.textContent = 'Frequentation (par mois)';
    } else {
      const buckets = [];
      let cur = mondayOf(from);
      const endMonday = mondayOf(to);
      while (cur <= endMonday) {
        buckets.push(new Date(cur));
        cur = new Date(cur);
        cur.setDate(cur.getDate() + 7);
      }
      counts = buckets.map(() => 0);
      allSessions.forEach((s) => {
        const dRaw = s.session_date || (s.created_at ? s.created_at.slice(0, 10) : null);
        if (!dRaw) return;
        const monday = isoWeekLabel(dRaw + 'T12:00:00');
        const idx = buckets.findIndex((b) => b.getTime() === monday.getTime());
        if (idx >= 0) counts[idx]++;
      });
      labels = buckets.map((b) => b.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit' }));
      if (titleEl) titleEl.textContent = 'Frequentation (par semaine)';
    }
  }

  if (chartInstance) {
    chartInstance.data.labels = labels;
    chartInstance.data.datasets[0].data = counts;
    chartInstance.update();
    return;
  }
  chartInstance = new Chart(canvas.getContext('2d'), {
    type: 'bar',
    data: {
      labels,
      datasets: [{ label: 'Sessions', data: counts, backgroundColor: '#7c74ff', borderRadius: 6 }],
    },
    options: {
      responsive: true,
      plugins: { legend: { display: false } },
      scales: {
        x: { grid: { display: false }, ticks: { color: '#8b90b0' } },
        y: { beginAtZero: true, ticks: { precision: 0, color: '#8b90b0' }, grid: { color: 'rgba(255,255,255,.06)' } },
      },
    },
  });
}

// =========================================================================================
// OFFRE 2 — Statistiques avancees (fidelisation, performance sportive, qualite, usage)
// =========================================================================================
// Section volontairement separee du reste du fichier (Basique ci-dessus) : fidelisation,
// performance sportive avancee, experience/qualite et usage avance/saisonnalite sont des
// analyses qui NE FONT PAS partie du pack de base. Aucun KPI de chiffre d'affaires ici
// (revenu, panier moyen, CA par type de session) — explicitement hors perimetre.
//
// Comme le reste du fichier, ces fonctions restent volontairement simples : elles
// reçoivent les tableaux deja charges par loadStatsTab() (allSessions/allRegs/allLaps/
// timeRows) et ne font de requete DB additionnelle QUE pour des donnees pas deja
// chargees (session_ratings, sessions "avant la periode" pour le taux de retour, presets
// de visites 30/90/365j, saisonnalite 12 mois, reglages du tenant). Chacune de ces
// requetes est non-bloquante : en cas d'echec (RLS, table pas encore migree chez ce
// tenant...) le bloc concerne affiche "--" plutot que de faire planter tout l'onglet —
// voir le try/catch autour de loadPremiumStatsBlocks() dans loadStatsTab().

let lastFidelisation = { tauxRetour: null, visites30: null, visites90: null, visites365: null, segmentation: { nouveaux: 0, reguliers: 0, fans: 0 }, top10: [] };
let lastPerformance = { pctProgression: null, progressionMoyenne: null, niveaux: { debutant: 0, intermediaire: 0, expert: 0 }, hofEnrichi: [] };
let lastUsageAvance = { pctEnLigne: null, pctSurPlace: null, planPisteActif: false, themeActuel: null, themePremium: false, saisonnalite: { months: [], topHours: [] } };

// Identite d'un pilote a travers plusieurs sessions : meme convention que l'ancien
// regroupement par pseudo de le pack Basique — pas d'identifiant stable pour les pilotes
// "Unknown"/sur-place, donc le pseudo normalise reste la seule cle disponible cote client.
function pilotKey(reg) {
  return (reg.display_name || '').trim().toLowerCase();
}

// Segmentation simple par nombre de sessions sur la periode — seuils demandes tels
// quels dans le cahier des charges (1 = nouveau, 2-4 = regulier, 5+ = fan).
function segmentLabel(count) {
  if (count >= 5) return 'fans';
  if (count >= 2) return 'reguliers';
  return 'nouveaux';
}

// Seuils de niveau (temps au tour, en secondes) — desormais configurables par
// tenant (Parametres > Seuils de niveau, voir refreshLevelThresholds() ci-dessous) :
// un circuit indoor court n'a pas les memes temps qu'un circuit outdoor long, ces
// valeurs par defaut generiques (45s / 55s) ne conviennent pas a tout le monde.
let LEVEL_THRESHOLDS_SECONDS = { expertMax: 45, intermediaireMax: 55 };
// Rendus configurables le 29/07 (Parametres > Seuils de niveau, voir settings.js
// savePrefs()/loadPrefs()) -- reste en 'let' avec ces valeurs par defaut generiques
// tant qu'aucun reglage tenant n'est charge. refreshLevelThresholds() est appelee
// au debut de la section Performance dans loadPremiumStatsBlocks(), avant le calcul
// des niveaux, pour que la classification utilise les seuils du tenant.
async function refreshLevelThresholds() {
try {
const { data: cfg } = await db.from('app_settings').select('value').eq('key', 'global').maybeSingle();
if (cfg && cfg.value) {
LEVEL_THRESHOLDS_SECONDS = {
expertMax: Number(cfg.value.level_expert_max_seconds) || 45,
intermediaireMax: Number(cfg.value.level_intermediaire_max_seconds) || 55,
};
}
} catch (e) {
// pas bloquant : on garde les valeurs par defaut
}
}
function levelForBestLap(bestLapSeconds) {
  if (bestLapSeconds == null) return null;
  if (bestLapSeconds <= LEVEL_THRESHOLDS_SECONDS.expertMax) return 'expert';
  if (bestLapSeconds <= LEVEL_THRESHOLDS_SECONDS.intermediaireMax) return 'intermediaire';
  return 'debutant';
}

// Coefficient de variation (ecart-type / moyenne) en-dessous duquel un pilote est
// considere "regulier" (badge "Metronome") — seuil simple et documente, pas un calcul
// scientifique de constance.
const REGULARITY_CV_THRESHOLD = 0.03;

function stddev(values) {
  if (!values.length) return null;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((a, b) => a + (b - mean) * (b - mean), 0) / values.length;
  return { mean, sd: Math.sqrt(variance) };
}

// Themes "Premium" — copie volontairement locale de la liste de PREMIUM_THEMES dans
// settings.js (pas d'import croise entre les deux modules pour ce simple usage en
// lecture) : settings.js reste la source de verite si la liste doit evoluer.
// Ex-doublon corrigé (audit 28/07, section 4.1) : importé depuis settings.js, seule
// source de vérité désormais.
const PREMIUM_THEME_SLUGS = PREMIUM_THEMES;

function formatMinutes(min) {
  if (!min) return '0 min';
  if (min < 60) return min + ' min';
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h + 'h' + (m ? String(m).padStart(2, '0') : '');
}

// Message de verrouillage affiche a la place d'un bloc Offre 2 quand le plan ne
// l'autorise pas -- meme esprit visuel que #trackmap-upsell / #themes-upsell dans
// admin.html (encart discret, pas de blocage brutal de la navigation : le sous-onglet
// reste cliquable, seul son contenu est remplace). IMPORTANT : cette fonction est
// appelee AVANT tout calcul du bloc concerne -- aucune donnee n'est donc jamais
// deposee dans le DOM (meme cache) si le plan ne l'autorise pas.
function renderLockedStatsPanel(panelId) {
  const panel = document.getElementById(panelId);
  if (!panel) return;
  panel.innerHTML =
    '<div style="font-size:13px;color:var(--mut);background:var(--surf2);border:1px solid var(--bord);border-radius:8px;padding:16px;text-align:center">' +
    '<div style="font-size:22px;margin-bottom:6px">🔒</div>' +
    '<div>Reserve au plan <strong>Premium</strong>. Passe au plan superieur pour debloquer ces statistiques avancees.</div>' +
    '</div>';
}

async function loadPremiumStatsBlocks(allSessions, allRegs, allLaps, timeRows, range) {
  // 30/07 : repartition plus fine — Fidelisation (stats-subtab-fid) est desormais Basique
  // et se calcule toujours, sans verrou. Seuls Performance sportive (stats-subtab-perf) et
  // Usage avance & saisonnalite (stats-subtab-qualite) restent derriere le flag
  // 'advanced_stats' (voir plan.js > hasFeature()) — verifie plus bas, juste avant leurs
  // calculs respectifs, pas ici : AUCUN des calculs Premium ne doit tourner si le plan ne
  // l'autorise pas (pas de fuite d'info dans le DOM, meme cache par un panel inactif).

  const regsById = new Map(allRegs.map((r) => [r.id, r]));
  const sessionsById = new Map(allSessions.map((s) => [s.id, s]));

  // ---------------------------------------------------------------------------------------
  // 1) FIDELISATION & COMPORTEMENT PILOTES
  // ---------------------------------------------------------------------------------------
  const byPilot = new Map();
  allRegs.forEach((r) => {
    const key = pilotKey(r);
    if (!key) return;
    if (!byPilot.has(key)) byPilot.set(key, { name: r.display_name, nationalities: new Map(), sessions: new Set() });
    const p = byPilot.get(key);
    p.sessions.add(r.session_id);
    if (r.nationality) p.nationalities.set(r.nationality, (p.nationalities.get(r.nationality) || 0) + 1);
  });

  const segmentation = { nouveaux: 0, reguliers: 0, fans: 0 };
  byPilot.forEach((p) => { segmentation[segmentLabel(p.sessions.size)]++; });

  const top10Engagement = Array.from(byPilot.values())
    .map((p) => ({
      name: p.name,
      nationality: (Array.from(p.nationalities.entries()).sort((a, b) => b[1] - a[1])[0] || [])[0] || '--',
      sessions: p.sessions.size,
    }))
    .sort((a, b) => b.sessions - a.sessions)
    .slice(0, 10);

  // Taux de retour : % de pilotes de la periode deja vus AVANT le debut de la periode.
  // N'a de sens que sur une plage bornee (sinon "avant la periode" n'existe pas, d'où
  // le '--' sur "Depuis le debut") — requete additionnelle legere, non bloquante.
  let tauxRetour = null;
  if (range && range.from) {
    try {
      const { data: priorSessions } = await fetchAll(() => db.from('sessions').select('id').lt('session_date', range.from));
      const priorIds = (priorSessions || []).map((s) => s.id);
      if (priorIds.length) {
        const { data: priorRegs } = await fetchAllIn(() => db.from('session_registrations').select('display_name'), 'session_id', priorIds);
        const priorKeys = new Set((priorRegs || []).map((r) => (r.display_name || '').trim().toLowerCase()).filter(Boolean));
        const pilotsInRange = Array.from(byPilot.keys());
        const returning = pilotsInRange.filter((k) => priorKeys.has(k)).length;
        tauxRetour = pilotsInRange.length ? returning / pilotsInRange.length : null;
      } else {
        tauxRetour = 0; // aucune session avant la periode : personne ne peut etre "de retour"
      }
    } catch (e) {
      tauxRetour = null;
    }
  }

  // Visites moyennes/pilote sur des presets fixes (30/90/365j), independants du filtre
  // en cours — demande explicitement telle quelle ("basé sur ... des presets").
  const visites = await computeVisitesPresets();

  lastFidelisation = { tauxRetour, visites30: visites.j30, visites90: visites.j90, visites365: visites.j365, segmentation, top10: top10Engagement };
  renderFidelisationBlock(lastFidelisation);
await refreshLevelThresholds();

  // Gating Offre 2 (voir plan.js > hasFeature('advanced_stats')) : Performance sportive et
  // Usage avance restent visibles dans la navigation (switchStatsSubtab ne change pas) mais
  // leur contenu est remplace par un encart verrouille -- et surtout, AUCUN des calculs
  // ci-dessous ne tourne si le plan ne l'autorise pas.
  const advancedAllowed = await hasFeature('advanced_stats');
  if (!advancedAllowed) {
    renderLockedStatsPanel('stats-subtab-perf');
    renderLockedStatsPanel('stats-subtab-qualite');
    return;
  }

  // ---------------------------------------------------------------------------------------
  // 2) PERFORMANCE SPORTIVE AVANCEE
  // ---------------------------------------------------------------------------------------
  // Meilleur tour par (pilote, session) — pour la progression — et tous les tours par
  // pilote — pour la regularite.
  const bestLapByRegistration = new Map();
  const lapsByPilot = new Map();
  allLaps.forEach((l) => {
    if (!l.registration_id) return;
    const reg = regsById.get(l.registration_id);
    if (!reg) return;
    const key = pilotKey(reg);
    if (!key) return;
    const t = Number(l.lap_time_seconds);
    if (!Number.isFinite(t)) return;
    const curBest = bestLapByRegistration.get(l.registration_id);
    if (curBest == null || t < curBest) bestLapByRegistration.set(l.registration_id, t);
    if (!lapsByPilot.has(key)) lapsByPilot.set(key, []);
    lapsByPilot.get(key).push(t);
  });

  const sessionsByPilotChrono = new Map(); // key -> [{ date, best }] trie par date
  allRegs.forEach((r) => {
    const key = pilotKey(r);
    if (!key) return;
    const best = bestLapByRegistration.get(r.id);
    if (best == null) return;
    const sess = sessionsById.get(r.session_id);
    if (!sess || !sess.session_date) return;
    if (!sessionsByPilotChrono.has(key)) sessionsByPilotChrono.set(key, []);
    sessionsByPilotChrono.get(key).push({ date: sess.session_date, best });
  });

  let progressCount = 0, eligibleCount = 0, progressionSum = 0;
  const niveaux = { debutant: 0, intermediaire: 0, expert: 0 };
  const regularityByPilot = new Map(); // key -> { cv, isRegular }
  sessionsByPilotChrono.forEach((rows) => {
    rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    const overallBest = Math.min(...rows.map((r) => r.best));
    const lvl = levelForBestLap(overallBest);
    if (lvl) niveaux[lvl]++;
    if (rows.length >= 2) {
      eligibleCount++;
      const delta = rows[0].best - rows[rows.length - 1].best; // positif = plus rapide qu'au debut
      if (delta > 0) { progressCount++; progressionSum += delta; }
    }
  });
  lapsByPilot.forEach((times, key) => {
    if (times.length < 5) return; // pas assez de tours pour juger de la regularite
    const s = stddev(times);
    if (!s || !s.mean) return;
    const cv = s.sd / s.mean;
    regularityByPilot.set(key, { cv, isRegular: cv < REGULARITY_CV_THRESHOLD });
  });

  const pctProgression = eligibleCount ? progressCount / eligibleCount : null;
  const progressionMoyenne = progressCount ? progressionSum / progressCount : null;

  // Hall of Fame enrichi : reprend le classement "top temps absolus" deja calcule par
  // le pack Basique (timeRows, trie par temps total croissant) et lui ajoute nb sessions,
  // niveau et badge de regularite — sans recalculer le classement lui-meme.
  const hofEnrichi = timeRows.slice(0, 10).map((r) => {
    const key = r.name.trim().toLowerCase();
    const sessions = (byPilot.get(key) && byPilot.get(key).sessions.size) || 1;
    const rows = sessionsByPilotChrono.get(key) || [];
    const overallBest = rows.length ? Math.min(...rows.map((x) => x.best)) : null;
    const reg = regularityByPilot.get(key);
    return { name: r.name, total: r.total, sessions, niveau: levelForBestLap(overallBest), regulier: !!(reg && reg.isRegular) };
  });

  lastPerformance = { pctProgression, progressionMoyenne, niveaux, hofEnrichi };
  renderPerformanceBlock(lastPerformance);


  // ---------------------------------------------------------------------------------------
  // 4) UTILISATION AVANCEE & SAISONNALITE
  // ---------------------------------------------------------------------------------------
  const enLigne = allRegs.filter((r) => r.is_unknown === false).length;
  const surPlace = allRegs.filter((r) => r.is_unknown === true).length;
  const totalRegs = enLigne + surPlace;
  const pctEnLigne = totalRegs ? enLigne / totalRegs : null;
  const pctSurPlace = totalRegs ? surPlace / totalRegs : null;

  let planPisteActif = false, themeActuel = null, themePremium = false;
  try {
    const { data: cfg } = await db.from('app_settings').select('value').eq('key', 'global').maybeSingle();
    if (cfg && cfg.value) {
      planPisteActif = !!cfg.value.track_map_url;
      themeActuel = cfg.value.results_theme || 'classic';
      themePremium = PREMIUM_THEME_SLUGS.has(themeActuel);
    }
  } catch (e) {
    // pas bloquant
  }

  const saisonnalite = await computeSaisonnalite12Mois();

  lastUsageAvance = { pctEnLigne, pctSurPlace, planPisteActif, themeActuel, themePremium, saisonnalite };
  renderUsageAvanceBlock(lastUsageAvance);
}

// Visites moyennes/pilote sur 3 fenetres glissantes fixes (30/90/365 jours), independantes
// du filtre de plage courant — 3 requetes legeres, chacune non-bloquante individuellement.
async function computeVisitesPresets() {
  const presets = { j30: 30, j90: 90, j365: 365 };
  const today = new Date();
  const out = {};
  for (const key of Object.keys(presets)) {
    try {
      const from = new Date(today);
      from.setDate(from.getDate() - presets[key]);
      const fromStr = from.getFullYear() + '-' + String(from.getMonth() + 1).padStart(2, '0') + '-' + String(from.getDate()).padStart(2, '0');
      const { data: sess } = await fetchAll(() => db.from('sessions').select('id').gte('session_date', fromStr));
      const ids = (sess || []).map((s) => s.id);
      if (!ids.length) { out[key] = null; continue; }
      const { data: regs } = await fetchAllIn(() => db.from('session_registrations').select('display_name'), 'session_id', ids);
      const uniq = new Set((regs || []).map((r) => (r.display_name || '').trim().toLowerCase()).filter(Boolean));
      out[key] = uniq.size ? (regs || []).length / uniq.size : null;
    } catch (e) {
      out[key] = null;
    }
  }
  return out;
}

// Saisonnalite sur les 12 derniers mois glissants — vue globale, independante du filtre
// de plage courant (demande explicitement telle quelle) : nb de sessions par mois, et
// les creneaux horaires (heure de depart) les plus demandes.
async function computeSaisonnalite12Mois() {
  try {
    const today = new Date();
    const from = new Date(today);
    from.setDate(from.getDate() - 365);
    const fromStr = from.getFullYear() + '-' + String(from.getMonth() + 1).padStart(2, '0') + '-' + String(from.getDate()).padStart(2, '0');
    const { data: sess } = await fetchAll(() => db.from('sessions').select('session_date,starts_at').gte('session_date', fromStr));
    const list = sess || [];
    const byMonth = new Map();
    const byHour = new Map();
    list.forEach((s) => {
      if (s.session_date) {
        const mKey = s.session_date.slice(0, 7);
        byMonth.set(mKey, (byMonth.get(mKey) || 0) + 1);
      }
      if (s.starts_at) {
        const h = new Date(s.starts_at).getHours();
        byHour.set(h, (byHour.get(h) || 0) + 1);
      }
    });
    const months = Array.from(byMonth.entries()).sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([m, c]) => ({ month: m, count: c }));
    const topHours = Array.from(byHour.entries()).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([h, c]) => ({ hour: h, count: c }));
    return { months, topHours };
  } catch (e) {
    return { months: [], topHours: [] };
  }
}

function renderFidelisationBlock(f) {
  const kpiGrid = document.getElementById('stats-fid-kpi-grid');
  if (kpiGrid) {
    kpiGrid.innerHTML =
      kpiBox('Taux de retour', pct(f.tauxRetour), f.tauxRetour == null ? 'Non calculable sur "Depuis le debut"' : null, '🔁', 'Part des pilotes de la periode deja vus AVANT le debut de cette periode. Non calculable sur "Depuis le debut" car il n\'y a pas de "avant" a comparer.') +
      kpiBox('Visites / pilote (30j)', f.visites30 != null ? f.visites30.toFixed(1) : '--', null, '📆', 'Nombre moyen de sessions par pilote unique sur les 30 derniers jours glissants (aujourd\'hui inclus) -- independant du filtre de periode choisi en haut de page.') +
      kpiBox('Visites / pilote (90j)', f.visites90 != null ? f.visites90.toFixed(1) : '--', null, '📆', 'Nombre moyen de sessions par pilote unique sur les 90 derniers jours glissants -- independant du filtre de periode choisi en haut de page.') +
      kpiBox('Visites / pilote (1 an)', f.visites365 != null ? f.visites365.toFixed(1) : '--', null, '📆', 'Nombre moyen de sessions par pilote unique sur les 365 derniers jours glissants -- independant du filtre de periode choisi en haut de page.');
  }
  const segEl = document.getElementById('stats-fid-segmentation');
  if (segEl) {
    const total = f.segmentation.nouveaux + f.segmentation.reguliers + f.segmentation.fans;
    const row = (lbl, n, color) =>
      '<div style="margin-bottom:8px"><div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:3px"><span>' + lbl + '</span><span>' + n + ' (' + (total ? Math.round((n / total) * 100) : 0) + '%)</span></div>' +
      '<div style="height:8px;border-radius:4px;background:var(--surf2);overflow:hidden"><div style="height:100%;width:' + (total ? Math.round((n / total) * 100) : 0) + '%;background:' + color + '"></div></div></div>';
    segEl.innerHTML = total
      ? row('Nouveaux (1 session)', f.segmentation.nouveaux, '#7c74ff') + row('Reguliers (2-4 sessions)', f.segmentation.reguliers, '#f0c419') + row('Fans (5+ sessions)', f.segmentation.fans, '#ff3b30') + '<div style="font-size:11px;color:var(--mut);margin-top:6px">Segmentation basee sur le nombre de sessions du pilote sur la periode selectionnee : 1 = nouveau, 2 a 4 = regulier, 5 et plus = fan.</div>'
      : '<div class="empty">Aucun pilote sur la periode.</div>';
  }
  const topEl = document.getElementById('stats-fid-top10');
  if (topEl) {
    topEl.innerHTML = f.top10.length
      ? '<table class="rank-tbl"><thead><tr><th>#</th><th>Nom</th><th>Nat.</th><th>Sessions</th></tr></thead><tbody>' +
        f.top10.map((p, i) => '<tr><td>' + (i + 1) + '</td><td>' + p.name + '</td><td>' + p.nationality + '</td><td>' + p.sessions + '</td></tr>').join('') +
        '</tbody></table>'
      : '<div class="empty">Aucun pilote.</div>';
  }
}

function renderPerformanceBlock(p) {
  const kpiGrid = document.getElementById('stats-perf-kpi-grid');
  if (kpiGrid) {
    kpiGrid.innerHTML =
      kpiBox('Pilotes en progression', pct(p.pctProgression), null, '📈', 'Part des pilotes ayant au moins 2 sessions chronometrees sur la periode ET dont le meilleur tour s\'est ameliore entre la 1ere et la derniere. Les pilotes avec une seule session ne comptent pas (rien a comparer).') +
      // p.progressionMoyenne est toujours positif (voir loadPremiumStatsBlocks : ne cumule que
      // les deltas > 0) — c'est un gain de temps, affiche avec un signe moins pour bien
      // marquer "plus rapide", jamais un delta negatif/regression.
      kpiBox('Progression moyenne', p.progressionMoyenne != null ? '−' + p.progressionMoyenne.toFixed(2) + ' s' : '--', p.progressionMoyenne != null ? 'Plus rapide entre 1re et derniere session' : 'Entre 1re et derniere session', '⏱️', 'Gain de temps moyen entre le meilleur tour de la 1ere session et celui de la derniere, pour les pilotes en progression uniquement -- ne tient pas compte des sessions intermediaires.');
  }
  const nivEl = document.getElementById('stats-perf-niveaux');
  if (nivEl) {
    const total = p.niveaux.debutant + p.niveaux.intermediaire + p.niveaux.expert;
    nivEl.innerHTML = total
      ? '<table class="rank-tbl"><thead><tr><th>Niveau</th><th>Pilotes</th><th>Part</th></tr></thead><tbody>' +
        [['Debutant', p.niveaux.debutant], ['Intermediaire', p.niveaux.intermediaire], ['Expert', p.niveaux.expert]]
          .map((pair) => '<tr><td>' + pair[0] + '</td><td>' + pair[1] + '</td><td>' + Math.round((pair[1] / total) * 100) + '%</td></tr>').join('') +
        '</tbody></table>' + '<div style="font-size:11px;color:var(--mut);margin-top:8px">Niveau base sur le meilleur tour du pilote sur la periode : Expert &le; ' + LEVEL_THRESHOLDS_SECONDS.expertMax + 's, Intermediaire &le; ' + LEVEL_THRESHOLDS_SECONDS.intermediaireMax + 's, Debutant au-dela. Seuils ajustables dans Parametres.</div>'
      : '<div class="empty">Aucun temps enregistre.</div>';
  }
  const hofEl = document.getElementById('stats-perf-hof');
  if (hofEl) {
    const NIVEAU_LABELS = { expert: 'Expert', intermediaire: 'Intermediaire', debutant: 'Debutant' };
    hofEl.innerHTML = p.hofEnrichi.length
      ? '<table class="rank-tbl"><thead><tr><th>#</th><th>Nom</th><th>Temps</th><th>Sessions</th><th>Niveau</th><th>Regularite</th></tr></thead><tbody>' +
        p.hofEnrichi.map((r, i) => '<tr><td>' + (i + 1) + '</td><td>' + r.name + '</td><td>' + formatTime(r.total) + '</td><td>' + r.sessions + '</td><td>' + (NIVEAU_LABELS[r.niveau] || '--') + '</td><td>' + (r.regulier ? '🎯 Metronome' : '--') + '</td></tr>').join('') +
        '</tbody></table>'
      : '<div class="empty">Aucun classement disponible.</div>';
  }
}


function renderUsageAvanceBlock(u) {
  const kpiGrid = document.getElementById('stats-usage-kpi-grid');
  if (kpiGrid) {
    kpiGrid.innerHTML =
      kpiBox('Inscriptions en ligne', pct(u.pctEnLigne), 'Via register.html', '💻') +
      kpiBox('Inscriptions sur place', pct(u.pctSurPlace), 'Walk-in / saisie admin', '🚶') +
      kpiBox('Plan de piste', u.planPisteActif ? 'Actif' : 'Inactif', null, '🗺️') +
      kpiBox('Theme actuel', u.themeActuel || '--', u.themePremium ? 'Theme Premium' : 'Theme gratuit', '🎨');
  }
  const saisonEl = document.getElementById('stats-usage-saison');
  if (!saisonEl) return;
  if (!u.saisonnalite.months.length) {
    saisonEl.innerHTML = '<div class="empty">Pas assez d\'historique (12 mois).</div>';
    return;
  }
  const maxCount = Math.max.apply(null, u.saisonnalite.months.map((m) => m.count).concat([1]));
  const bars = u.saisonnalite.months.map((m) =>
    '<div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">' +
    '<span style="width:52px;font-size:11px;color:var(--mut)">' + m.month + '</span>' +
    '<div style="flex:1;height:8px;border-radius:4px;background:var(--surf2);overflow:hidden"><div style="height:100%;width:' + Math.round((m.count / maxCount) * 100) + '%;background:#7c74ff"></div></div>' +
    '<span style="width:24px;text-align:right;font-size:11px">' + m.count + '</span></div>'
  ).join('');
  const topHoursTxt = u.saisonnalite.topHours.length ? u.saisonnalite.topHours.map((h) => h.hour + 'h (' + h.count + ')').join(' · ') : '--';
  saisonEl.innerHTML = bars + '<div style="margin-top:10px;font-size:11px;color:var(--mut)">Creneaux les plus demandes : ' + topHoursTxt + '</div>';
}

// --- Export XLSX (multi-onglets) --------------------------------------------------------------
// 🆕 v17 : remplace l'ancien export CSV (qui ne couvrait que le "Top temps")
// par un classeur Excel avec UN ONGLET PAR BLOC de l'onglet Statistiques —
// c'était la demande explicite ("plusieurs onglets... qu'on sache de quoi on
// parle"). Utilise SheetJS (déjà chargé globalement dans admin.html, voir la
// balise <script> xlsx.full.min.js — jusqu'ici seulement utilisé en LECTURE
// pour l'import de chronos dans results.js) : aucune nouvelle dépendance.
// Reprend les blocs déjà calculés et affichés par loadStatsTab() pour le
// filtre en cours (lastKpis/lastTimeRows/lastHofKarts/lastExploitation) —
// aucune requête DB supplémentaire.
const RANGE_SLUGS = {
  jour: 'jour', semaine: 'semaine', mois: 'mois', annee: 'annee', personnalise: 'personnalise', all: 'depuis-le-debut',
};

function rangeLabelForExport() {
  const base = RANGE_LABELS[currentRange.key] || 'Depuis le debut';
  if (!currentRange.from) return base;
  const toTxt = currentRange.to && currentRange.to !== currentRange.from ? ' au ' + fmtRangeDate(currentRange.to) : '';
  return base + ' (du ' + fmtRangeDate(currentRange.from) + toTxt + ')';
}

export function exportStatsXLSX() {
  if (typeof XLSX === 'undefined') {
    window.alert("La bibliotheque d'export Excel n'est pas chargee — recharge la page et reessaie.");
    return;
  }
  const periodeTxt = rangeLabelForExport();
  const wb = XLSX.utils.book_new();

  const kpiSheet = XLSX.utils.aoa_to_sheet([
    ['Statistiques — resume', periodeTxt],
    [],
    ['Indicateur', 'Valeur'],
    ['Sessions', lastKpis.sessions],
    ['Pilotes uniques', lastKpis.pilotsUniques],
    ['Chronos enregistres', lastKpis.chronos],
  ]);
  XLSX.utils.book_append_sheet(wb, kpiSheet, 'Resume');

  const topTimesSheet = XLSX.utils.aoa_to_sheet([
    ['Top temps — ' + periodeTxt],
    [],
    ['Position', 'Nom', 'Kart', 'Temps', 'Date'],
    ...lastTimeRows.map((r, i) => [i + 1, r.name, r.kart || '', formatTime(r.total), r.date ? fmtRangeDate(r.date) : '']),
  ]);
  XLSX.utils.book_append_sheet(wb, topTimesSheet, 'Top temps');

  const hofKartsSheet = XLSX.utils.aoa_to_sheet([
    ['Hall of Fame — meilleur temps par kart — ' + periodeTxt],
    [],
    ['Kart', 'Meilleur tour', 'Pilote'],
    ...lastHofKarts.map((r) => [r.kart, formatTime(r.time), r.name || '']),
  ]);
  XLSX.utils.book_append_sheet(wb, hofKartsSheet, 'HOF karts');

  const e = lastExploitation;
  const exploitationSheet = XLSX.utils.aoa_to_sheet([
    ['Exploitation piste — ' + periodeTxt],
    [],
    ['Indicateur', 'Valeur', 'Detail'],
    ['Remplissage moyen des sessions', pct(e.avgFill), e.avgFill != null ? 'min ' + pct(e.minFill) + ' / max ' + pct(e.maxFill) : 'Aucune session avec capacite connue'],
    ['Utilisation piste (estimee)', pct(e.utilizationRate), 'Base : ' + DEFAULT_OPENING_HOURS_PER_DAY + 'h/jour, session ~' + DEFAULT_AVG_SESSION_MINUTES + ' min (estimation)'],
    ['Sessions par jour (moyenne)', e.sessionsPerDay != null ? e.sessionsPerDay.toFixed(1) : '--', e.days ? 'sur ' + e.days + ' jour(s)' : ''],
    ['Sessions par semaine (moyenne)', e.sessionsPerWeek != null ? e.sessionsPerWeek.toFixed(1) : '--', ''],
  ]);
  XLSX.utils.book_append_sheet(wb, exploitationSheet, 'Exploitation piste');

  // --- Premium : 4 feuilles supplementaires, memes principes (aucune requete DB, reprend
  // ce qui est deja affiche a l'ecran via lastFidelisation/lastPerformance/lastQualite/
  // lastUsageAvance) ------------------------------------------------------------------------
  const f = lastFidelisation;
  const fidSheet = XLSX.utils.aoa_to_sheet([
    ['Fidelisation pilotes — ' + periodeTxt],
    [],
    ['Indicateur', 'Valeur'],
    ['Taux de retour', pct(f.tauxRetour)],
    ['Visites / pilote (30j)', f.visites30 != null ? f.visites30.toFixed(1) : '--'],
    ['Visites / pilote (90j)', f.visites90 != null ? f.visites90.toFixed(1) : '--'],
    ['Visites / pilote (1 an)', f.visites365 != null ? f.visites365.toFixed(1) : '--'],
    [],
    ['Segmentation', 'Nb pilotes'],
    ['Nouveaux (1 session)', f.segmentation.nouveaux],
    ['Reguliers (2-4 sessions)', f.segmentation.reguliers],
    ['Fans (5+ sessions)', f.segmentation.fans],
    [],
    ['Top 10 par engagement — Position', 'Nom', 'Nationalite', 'Sessions'],
    ...f.top10.map((p, i) => [i + 1, p.name, p.nationality, p.sessions]),
  ]);
  XLSX.utils.book_append_sheet(wb, fidSheet, 'Fidelisation');

  const p = lastPerformance;
  const NIVEAU_LABELS_XLSX = { expert: 'Expert', intermediaire: 'Intermediaire', debutant: 'Debutant' };
  const perfSheet = XLSX.utils.aoa_to_sheet([
    ['Performance sportive avancee — ' + periodeTxt],
    [],
    ['Indicateur', 'Valeur'],
    ['Pilotes en progression', pct(p.pctProgression)],
    ['Progression moyenne', p.progressionMoyenne != null ? '-' + p.progressionMoyenne.toFixed(2) + ' s' : '--'],
    [],
    ['Niveau', 'Pilotes'],
    ['Debutant', p.niveaux.debutant],
    ['Intermediaire', p.niveaux.intermediaire],
    ['Expert', p.niveaux.expert],
    [],
    ['Hall of Fame enrichi — Position', 'Nom', 'Temps', 'Sessions', 'Niveau', 'Regulier'],
    ...p.hofEnrichi.map((r, i) => [i + 1, r.name, formatTime(r.total), r.sessions, NIVEAU_LABELS_XLSX[r.niveau] || '--', r.regulier ? 'Oui' : 'Non']),
  ]);
  XLSX.utils.book_append_sheet(wb, perfSheet, 'Performance sportive');

  const u = lastUsageAvance;
  const usageSheet = XLSX.utils.aoa_to_sheet([
    ['Utilisation avancee & saisonnalite — ' + periodeTxt],
    [],
    ['Indicateur', 'Valeur', 'Detail'],
    ['Inscriptions en ligne (register.html)', pct(u.pctEnLigne), ''],
    ['Inscriptions sur place (walk-in/admin)', pct(u.pctSurPlace), ''],
    ['Plan de piste', u.planPisteActif ? 'Actif' : 'Inactif', ''],
    ['Theme actuel', u.themeActuel || '--', u.themePremium ? 'Theme Premium' : 'Theme gratuit'],
    [],
    ['Saisonnalite (12 derniers mois) — Mois', 'Sessions'],
    ...u.saisonnalite.months.map((m) => [m.month, m.count]),
    [],
    ['Creneaux les plus demandes — Heure', 'Sessions'],
    ...u.saisonnalite.topHours.map((h) => [h.hour + 'h', h.count]),
  ]);
  XLSX.utils.book_append_sheet(wb, usageSheet, 'Utilisation avancee');

  const today = new Date();
  const dateStr = today.getFullYear() + '-' + String(today.getMonth() + 1).padStart(2, '0') + '-' + String(today.getDate()).padStart(2, '0');
  const label = RANGE_SLUGS[currentRange.key] || 'depuis-le-debut';
  XLSX.writeFile(wb, 'stats-' + label + '-' + dateStr + '.xlsx');
}
