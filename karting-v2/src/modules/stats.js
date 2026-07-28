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

function kpiBox(lbl, val, sub) {
  return (
    '<div class="card" style="text-align:center;padding:16px">' +
    '<div style="font-size:11px;color:var(--mut);text-transform:uppercase;font-weight:700;margin-bottom:6px">' + lbl + '</div>' +
    '<div style="font-size:22px;font-weight:900">' + val + '</div>' +
    (sub ? '<div style="font-size:11px;color:var(--mut);margin-top:4px">' + sub + '</div>' : '') +
    '</div>'
  );
}

export async function loadStatsTab() {
  const kpiGrid = document.getElementById('stats-kpi-grid');
  const topTimesEl = document.getElementById('stats-top-times');
  const topPilotsEl = document.getElementById('stats-top-pilots');
  const hofKartsEl = document.getElementById('stats-hof-karts');
  const hofPilotsEl = document.getElementById('stats-hof-pilots');
  if (kpiGrid) kpiGrid.innerHTML = '<div class="empty">Chargement...</div>';

  const [sessRes, regsRes, lapsRes] = await Promise.all([
    db.from('sessions').select('id,session_date,created_at'),
    db.from('session_registrations').select('id,session_id,display_name,kart_number'),
    db.from('laps').select('registration_id,lap_time_seconds'),
  ]);
  const allSessions = sessRes.data || [];
  const allRegs = regsRes.data || [];
  const allLaps = lapsRes.data || [];

  // --- KPIs globaux -----------------------------------------------------------------------
  const uniquePilots = new Set(allRegs.map((r) => (r.display_name || '').trim().toLowerCase()).filter(Boolean));
  if (kpiGrid) {
    kpiGrid.innerHTML =
      kpiBox('Sessions', allSessions.length) +
      kpiBox('Pilotes uniques', uniquePilots.size) +
      kpiBox('Chronos enregistres', allLaps.length);
  }

  // --- Totaux par inscription (pour top temps + classement permanent) --------------------
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
  if (topTimesEl) {
    const top = timeRows.slice(0, 10);
    topTimesEl.innerHTML = top.length
      ? '<table class="rank-tbl"><thead><tr><th>#</th><th>Nom</th><th>Kart</th><th>Temps</th><th>Date</th></tr></thead><tbody>' +
        top.map((r, i) => '<tr><td>' + (i + 1) + '</td><td>' + r.name + '</td><td>' + (r.kart || '--') + '</td><td>' + formatTime(r.total) + '</td><td>' + (r.date ? formatDate(r.date) : '--') + '</td></tr>').join('') +
        '</tbody></table>'
      : '<div class="empty">Aucun chrono enregistre.</div>';
  }

  // --- Top 5 pilotes par nombre de sessions jouées ----------------------------------------
  const sessionsByPilot = new Map();
  allRegs.forEach((r) => {
    const key = (r.display_name || '').trim().toLowerCase();
    if (!key) return;
    if (!sessionsByPilot.has(key)) sessionsByPilot.set(key, { name: r.display_name, sessions: new Set() });
    sessionsByPilot.get(key).sessions.add(r.session_id);
  });
  const pilotList = Array.from(sessionsByPilot.values()).map((p) => ({ name: p.name, count: p.sessions.size }));
  pilotList.sort((a, b) => b.count - a.count);
  if (topPilotsEl) {
    const top5 = pilotList.slice(0, 5);
    topPilotsEl.innerHTML = top5.length
      ? '<table class="rank-tbl"><thead><tr><th>#</th><th>Nom</th><th>Sessions jouees</th></tr></thead><tbody>' +
        top5.map((p, i) => '<tr><td>' + (i + 1) + '</td><td>' + p.name + '</td><td>' + p.count + '</td></tr>').join('') +
        '</tbody></table>'
      : '<div class="empty">Aucun pilote.</div>';
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
  if (hofKartsEl) {
    const kartRows = Array.from(bestLapByKart.entries()).map(([kart, v]) => ({ kart, ...v })).sort((a, b) => a.kart - b.kart);
    hofKartsEl.innerHTML = kartRows.length
      ? '<table class="rank-tbl"><thead><tr><th>Kart</th><th>Meilleur tour</th><th>Pilote</th></tr></thead><tbody>' +
        kartRows.map((r) => '<tr><td>' + r.kart + '</td><td>' + formatTime(r.time) + '</td><td>' + (r.name || '--') + '</td></tr>').join('') +
        '</tbody></table>'
      : '<div class="empty">Aucun tour enregistre.</div>';
  }

  // --- Hall of Fame : classement permanent — meilleur temps unique par pilote, top 10 -----
  const bestByPilot = new Map();
  timeRows.forEach((r) => {
    const key = r.name.trim().toLowerCase();
    const cur = bestByPilot.get(key);
    if (!cur || r.total < cur.total) bestByPilot.set(key, r);
  });
  const permanentTop10 = Array.from(bestByPilot.values()).sort((a, b) => a.total - b.total).slice(0, 10);
  if (hofPilotsEl) {
    hofPilotsEl.innerHTML = permanentTop10.length
      ? '<table class="rank-tbl"><thead><tr><th>#</th><th>Nom</th><th>Meilleur temps</th></tr></thead><tbody>' +
        permanentTop10.map((r, i) => '<tr><td class="' + (['p1', 'p2', 'p3'][i] || '') + '">' + (i + 1) + '</td><td>' + r.name + '</td><td>' + formatTime(r.total) + '</td></tr>').join('') +
        '</tbody></table>'
      : '<div class="empty">Aucun classement disponible.</div>';
  }

  // --- Fréquentation : sessions par semaine sur 8 semaines --------------------------------
  renderFrequencyChart(allSessions);
}

function isoWeekLabel(date) {
  // Lundi de la semaine contenant `date`, affiché "DD/MM".
  const d = new Date(date);
  const day = (d.getDay() + 6) % 7; // 0 = lundi
  d.setDate(d.getDate() - day);
  return d;
}

function renderFrequencyChart(allSessions) {
  const canvas = document.getElementById('stats-freq-chart');
  if (!canvas || typeof Chart === 'undefined') return;
  const weeks = [];
  const today = new Date();
  today.setHours(12, 0, 0, 0);
  for (let i = 7; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i * 7);
    weeks.push(isoWeekLabel(d));
  }
  const counts = weeks.map(() => 0);
  allSessions.forEach((s) => {
    const dRaw = s.session_date || (s.created_at ? s.created_at.slice(0, 10) : null);
    if (!dRaw) return;
    const monday = isoWeekLabel(dRaw + 'T12:00:00');
    const idx = weeks.findIndex((w) => w.getTime() === monday.getTime());
    if (idx >= 0) counts[idx]++;
  });
  const labels = weeks.map((w) => w.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit' }));
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
