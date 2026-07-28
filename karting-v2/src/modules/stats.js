// Module Statistiques — Point 7 (onglet "Statistiques" : KPIs globaux, fréquentation,
// top 10 meilleurs temps absolus, top 5 pilotes par nb de sessions) et Point 9
// (Hall of Fame : meilleur temps par kart + classement permanent top 10 pilotes).
//
// Toutes les requêtes sont volontairement dépourvues de filtre explicite sur
// tenant_id : une fois l'authentification admin branchée (Point 1, fait le 24/07),
// les policies RLS "*_auth" (voir migration-v2.sql) filtrent déjà automatiquement
// sur le tenant de l'admin connecté — un filtre client-side serait redondant et,
// pire, pourrait laisser croire à tort qu'il protège quelque chose côté navigateur.
import { db } from '../lib/supabase.js';
import { formatTime, formatDate } from './ui.js';

let chartInstance = null;
// 🆕 v20 : Offre 1 — l'onglet Statistiques reste un pack leger (KPIs globaux,
// exploitation piste, Hall of Fame chronos compact). Les blocs "Top 5 pilotes
// (nb sessions jouees)" et "Classement permanent (meilleur temps unique par
// pilote)" ont ete retires : ce sont des analyses de frequentation/sportives
// qui relevent de l'Offre 2, pas du pack de base. Le code ci-dessous ne les
// calcule donc plus (voir git history si besoin de les reprendre).
//
// Les blocs de l'onglet Statistiques sont conserves en memoire au fil de
// loadStatsTab() pour que l'export (XLSX multi-onglets, voir
// exportStatsXLSX()) reprenne exactement ce qui est affiche a l'ecran, pour
// le filtre en cours, sans requete DB supplementaire.
let lastKpis = { sessions: 0, pilotsUniques: 0, chronos: 0 };
let lastHofKarts = [];
let lastExploitation = { avgFill: null, minFill: null, maxFill: null, utilizationRate: null, sessionsPerDay: null, sessionsPerWeek: null, days: 0 };

// --- Exploitation piste (Offre 1, MVP) --------------------------------------------------
// Ni la table `sessions` ni les Parametres n'ont aujourd'hui de champ "duree
// de session" ou "horaires d'ouverture" — ajouter un vrai reglage sort du
// perimetre de cette tache (Offre 1 = pack leger, pas de nouvelle UI de
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

// KPIs "Exploitation piste" (Offre 1) : taux de remplissage moyen des
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
function kpiBox(lbl, val, sub, icon) {
  return (
    '<div class="card" style="text-align:center;padding:16px">' +
    (icon ? '<div style="font-size:20px;margin-bottom:4px" aria-hidden="true">' + icon + '</div>' : '') +
    '<div style="font-size:11px;color:var(--mut);text-transform:uppercase;font-weight:700;margin-bottom:6px">' + lbl + '</div>' +
    '<div style="font-size:22px;font-weight:900">' + val + '</div>' +
    (sub ? '<div style="font-size:11px;color:var(--mut);margin-top:4px">' + sub + '</div>' : '') +
    '</div>'
  );
}

export async function loadStatsTab(range) {
  currentRange = range || currentRange || { key: 'all', from: null, to: null };
  const kpiGrid = document.getElementById('stats-kpi-grid');
  const exploitationGrid = document.getElementById('stats-exploitation-grid');
  const topTimesEl = document.getElementById('stats-top-times');
  const hofKartsEl = document.getElementById('stats-hof-karts');
  if (kpiGrid) kpiGrid.innerHTML = '<div class="empty">Chargement...</div>';

  let sessQuery = db.from('sessions').select('id,session_date,created_at,max_karts');
  if (currentRange.from) sessQuery = sessQuery.gte('session_date', currentRange.from);
  if (currentRange.to) sessQuery = sessQuery.lte('session_date', currentRange.to);
  const sessRes = await sessQuery;
  const allSessions = sessRes.data || [];
  const sessionIds = allSessions.map((s) => s.id);

  // Sur "Depuis le debut" (pas de filtre), on garde les requetes globales
  // telles quelles pour ne rien changer au comportement existant. Sur un
  // filtre actif, on restreint regs/laps aux sessions déjà filtrées via
  // .in('session_id', ...) plutôt que de filtrer côté client — plus proche
  // du style existant (filtres appliqués côté requête) et ça évite de
  // retélécharger des lignes qui seront de toute façon jetées.
  let regsQuery = db.from('session_registrations').select('id,session_id,display_name,kart_number');
  let lapsQuery = db.from('laps').select('registration_id,lap_time_seconds,session_id');
  if (currentRange.from || currentRange.to) {
    regsQuery = regsQuery.in('session_id', sessionIds.length ? sessionIds : ['00000000-0000-0000-0000-000000000000']);
    lapsQuery = lapsQuery.in('session_id', sessionIds.length ? sessionIds : ['00000000-0000-0000-0000-000000000000']);
  }
  const [regsRes, lapsRes] = await Promise.all([regsQuery, lapsQuery]);
  const allRegs = regsRes.data || [];
  const allLaps = lapsRes.data || [];

  // --- KPIs globaux -----------------------------------------------------------------------
  const uniquePilots = new Set(allRegs.map((r) => (r.display_name || '').trim().toLowerCase()).filter(Boolean));
  lastKpis = { sessions: allSessions.length, pilotsUniques: uniquePilots.size, chronos: allLaps.length };
  if (kpiGrid) {
    kpiGrid.innerHTML =
      kpiBox('Sessions', allSessions.length, null, '🏁') +
      kpiBox('Pilotes uniques', uniquePilots.size, null, '👤') +
      kpiBox('Chronos enregistres', allLaps.length, null, '⏱️');
  }

  // --- Exploitation piste (Offre 1, MVP) — voir computeExploitationKpis() -----------------
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
        '🪑'
      ) +
      kpiBox(
        'Utilisation piste (estimee)',
        pct(exploitation.utilizationRate),
        'Base : ' + DEFAULT_OPENING_HOURS_PER_DAY + 'h/jour, session ≈' + DEFAULT_AVG_SESSION_MINUTES + 'min',
        '📈'
      ) +
      kpiBox(
        'Sessions / jour',
        exploitation.sessionsPerDay != null ? exploitation.sessionsPerDay.toFixed(1) : '--',
        exploitation.days ? 'sur ' + exploitation.days + ' jour(s)' : null,
        '📅'
      ) +
      kpiBox(
        'Sessions / semaine',
        exploitation.sessionsPerWeek != null ? exploitation.sessionsPerWeek.toFixed(1) : '--',
        null,
        '🗓️'
      );
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
  renderFrequencyChart(allSessions, currentRange);
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

  const today = new Date();
  const dateStr = today.getFullYear() + '-' + String(today.getMonth() + 1).padStart(2, '0') + '-' + String(today.getDate()).padStart(2, '0');
  const label = RANGE_SLUGS[currentRange.key] || 'depuis-le-debut';
  XLSX.writeFile(wb, 'stats-' + label + '-' + dateStr + '.xlsx');
}
