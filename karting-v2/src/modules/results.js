// Module Résultats — classement, statistiques, export CSV, historique pilote, import des
// chronos (avec ou sans secteurs), publication publique et archives.
// Repris depuis index.html (lignes 984-1354).
//
// BUG CORRIGÉ ICI (par rapport à l'original) : la version "secteurs activés" de
// importChrono() appelait deux fonctions qui n'étaient définies nulle part dans le
// projet — `parseTime()` et `loadDetailSession()`. Résultat : dès qu'un organisateur
// activait les secteurs et importait des temps, l'app plantait avec une ReferenceError.
// Les deux fonctions sont maintenant réellement implémentées ci-dessous.
import { db } from '../lib/supabase.js';
import { state } from '../state.js';
import { showMsg, qrSrc, formatTime, formatDate, randomCode4 } from './ui.js';
import { APP_CONFIG } from '../config.js';
import { loadInscrits, refreshOccupation, updateQRReg, renderActivesGrid } from './sessions.js';

// --- Parsing des temps saisis à l'import --------------------------------------------

// Accepte "44.980" (secondes) ou "1:14.900" (minutes:secondes) — cette fonction
// n'existait pas dans l'original alors qu'elle était appelée (bug corrigé, cf. plus haut).
export function parseTime(str) {
  const s = String(str).trim();
  if (s.includes(':')) {
    const [m, rest] = s.split(':');
    const minutes = Number(m);
    const seconds = Number(rest);
    if (!Number.isFinite(minutes) || !Number.isFinite(seconds)) return NaN;
    return minutes * 60 + seconds;
  }
  return parseFloat(s);
}

// Recharge intégralement l'écran "détail session" après un import (n'existait pas dans
// l'original — bug corrigé, cf. en-tête du fichier). Équivalent de ce que fait déjà la
// branche "sans secteurs" de importChrono() : recharger inscrits + occupation + résultats.
export async function loadDetailSession(sessionId) {
  if (!state.activeDetailSession || state.activeDetailSession.id !== sessionId) return;
  await loadInscrits();
  await refreshOccupation();
  await renderResultatsSection();
}

// --- Classement & stats ----------------------------------------------------------------

export async function renderResultatsSection() {
  if (!state.activeDetailSession) return;
  const results = await loadRanking(state.activeDetailSession);
  renderRankTable('ranking-preview', results);
  renderSessionStats(results, 'stats-session-card', 'stats-session-grid');
  updateQRRes();
}

export async function loadRanking(sess) {
  const s = sess;
  if (!s) return [];
  const { data: laps } = await db.from('laps').select('*').eq('session_id', s.id);
  const { data: regs } = await db.from('session_registrations').select('*').eq('session_id', s.id);
  if (!laps || !regs) return [];
  const totals = new Map();
  laps.forEach((l) => totals.set(l.registration_id, (totals.get(l.registration_id) || 0) + Number(l.lap_time_seconds)));
  const results = [];
  regs.forEach((r) => {
    const t = totals.get(r.id);
    if (t != null) results.push({ name: r.display_name || '--', kart: r.kart_number, t, nat: r.nationality || 'FR' });
  });
  results.sort((a, b) => a.t - b.t);
  return results;
}

export function renderRankTable(elId, results) {
  const el = document.getElementById(elId);
  if (!el) return;
  if (!results.length) {
    el.innerHTML = '<div class="empty">Aucun resultat.</div>';
    return;
  }
  const pc = ['p1', 'p2', 'p3'];
  el.innerHTML =
    '<table class="rank-tbl"><thead><tr><th>Pos.</th><th>Kart</th><th>Nom</th><th>Temps</th></tr></thead><tbody>' +
    results
      .map((r, i) => '<tr><td class="' + (pc[i] || '') + '">' + (i + 1) + '</td><td>' + (r.kart || '--') + '</td><td>' + r.name + '</td><td>' + formatTime(r.t) + '</td></tr>')
      .join('') +
    '</tbody></table>';
}

export function renderSessionStats(results, cardId, gridId) {
  cardId = cardId || 'stats-session-card';
  gridId = gridId || 'stats-session-grid';
  const card = document.getElementById(cardId);
  const grid = document.getElementById(gridId);
  if (!card || !grid) return;
  if (!results || !results.length) {
    card.style.display = 'none';
    return;
  }
  card.style.display = 'block';
  const times = results.map((r) => r.t);
  const best = Math.min(...times);
  const avg = times.reduce((a, b) => a + b, 0) / times.length;
  const bestDriver = results.find((r) => r.t === best);
  const gapLeader = results.length > 1 ? results[1].t - results[0].t : 0;
  grid.innerHTML =
    statBox('Meilleur temps', formatTime(best), bestDriver ? bestDriver.name : '') +
    statBox('Temps moyen', formatTime(avg), results.length + ' pilotes') +
    statBox('Ecart 1er/2eme', results.length > 1 ? formatTime(gapLeader) : '--', '');
}

function statBox(lbl, val, sub) {
  return (
    '<div style="background:var(--surf2);border:1px solid var(--bord);border-radius:10px;padding:14px;text-align:center">' +
    '<div style="font-size:11px;color:var(--mut);text-transform:uppercase;font-weight:700;margin-bottom:6px">' + lbl + '</div>' +
    '<div style="font-size:20px;font-weight:900">' + val + '</div>' +
    (sub ? '<div style="font-size:11px;color:var(--mut);margin-top:4px">' + sub + '</div>' : '') +
    '</div>'
  );
}

export async function exportCSV(sess) {
  const s = sess;
  if (!s) {
    showMsg('msg-res', 'Aucune session.', 'err');
    return;
  }
  const results = await loadRanking(s);
  if (!results.length) {
    showMsg('msg-res', 'Aucun resultat a exporter.', 'err');
    return;
  }
  let csv = 'Position;Kart;Nom;Temps (s);Temps formate\n';
  results.forEach((r, i) => {
    csv += (i + 1) + ';' + (r.kart || '--') + ';' + r.name + ';' + r.t.toFixed(3) + ';' + formatTime(r.t) + '\n';
  });
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = (s.title || 'session').replace(/[^a-z0-9]/gi, '_') + '_resultats.csv';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// --- Historique pilote -------------------------------------------------------------------

export async function showPilotHistory(regId, name) {
  document.getElementById('hist-title').textContent = 'Historique - ' + (name || 'Pilote');
  const contentEl = document.getElementById('hist-content');
  contentEl.innerHTML = '<div class="empty">Chargement...</div>';
  document.getElementById('hist-overlay').classList.add('show');
  try {
    const { data: allRegs } = await db
      .from('session_registrations')
      .select('id,session_id,kart_number,display_name,sessions(title,session_date)')
      .ilike('display_name', (name || '').trim());
    if (!allRegs || !allRegs.length) {
      contentEl.innerHTML = '<div class="empty">Aucun historique trouve.</div>';
      return;
    }
    const rows = [];
    for (const reg of allRegs) {
      const { data: laps } = await db.from('laps').select('lap_time_seconds').eq('registration_id', reg.id);
      if (!laps || !laps.length) continue;
      const total = laps.reduce((a, l) => a + Number(l.lap_time_seconds), 0);
      rows.push({
        title: (reg.sessions && reg.sessions.title) || '--',
        date: (reg.sessions && reg.sessions.session_date) || '',
        kart: reg.kart_number,
        time: total,
      });
    }
    if (!rows.length) {
      contentEl.innerHTML = '<div class="empty">Aucun chrono enregistre pour ce pilote.</div>';
      return;
    }
    rows.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    contentEl.innerHTML =
      '<table class="tbl"><thead><tr><th>Session</th><th>Date</th><th>Kart</th><th>Temps</th></tr></thead><tbody>' +
      rows.map((r) => '<tr><td>' + r.title + '</td><td>' + (r.date ? formatDate(r.date) : '--') + '</td><td>' + (r.kart || '--') + '</td><td>' + formatTime(r.time) + '</td></tr>').join('') +
      '</tbody></table>';
  } catch (e) {
    contentEl.innerHTML = '<div class="empty">Erreur: ' + e.message + '</div>';
  }
}

export function closeHistory() {
  document.getElementById('hist-overlay').classList.remove('show');
}

// --- Import des chronos (fichier Excel/CSV → texte) --------------------------------------

export function handleChronoFile(inputEl) {
  const file = inputEl.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = function (e) {
    try {
      const data = new Uint8Array(e.target.result);
      const wb = XLSX.read(data, { type: 'array' });
      const sheet = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true });
      const lines = [];
      rows.forEach((row) => {
        if (!row || row.length < 3) return;
        const name = String(row[0]).trim();
        const kart = String(row[1]).trim();
        let lapIdx = '1', time;
        if (row.length >= 4) {
          lapIdx = String(row[2]).trim();
          time = String(row[3]).trim();
        } else {
          time = String(row[2]).trim();
        }
        if (!name || !kart || !time) return;
        if (isNaN(parseInt(kart)) || isNaN(parseFloat(time))) return;
        lines.push(name + ';' + kart + ';' + lapIdx + ';' + time);
      });
      document.getElementById('chrono-raw').value = lines.join('\n');
      showMsg('msg-chrono', 'Fichier charge, verifie puis clique Importer le texte.', 'ok');
    } catch (err) {
      showMsg('msg-chrono', 'Erreur lecture fichier: ' + err.message, 'err');
    }
  };
  reader.readAsArrayBuffer(file);
}

// Import unifié : bascule automatiquement selon state.prefs.sectors_enabled, comme
// l'original, mais sans le bug (parseTime/loadDetailSession sont maintenant réels).
export async function importChrono() {
  if (state.prefs.sectors_enabled) return importChronoWithSectors();
  return importChronoSimple();
}

async function importChronoSimple() {
  if (!state.activeDetailSession) {
    showMsg('msg-chrono', 'Aucune session active.', 'err');
    return;
  }
  const raw = document.getElementById('chrono-raw').value.trim();
  if (!raw) {
    showMsg('msg-chrono', 'Colle les temps.', 'err');
    return;
  }
  const sid = state.activeDetailSession.id;
  const btn = document.getElementById('btn-import-chrono');
  const originalLabel = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = '<span class="spin"></span>Import en cours...';
  const { data: regs } = await db.from('session_registrations').select('id,display_name,kart_number').eq('session_id', sid);
  const lines = raw.split('\n').map((l) => l.trim()).filter(Boolean);
  await db.from('laps').delete().eq('session_id', sid);
  let imported = 0, errors = [];
  const regCache = {};
  let processed = 0;
  for (const line of lines) {
    processed++;
    if (processed % 5 === 0 || processed === lines.length) btn.innerHTML = '<span class="spin"></span>Import ' + processed + '/' + lines.length + '...';
    const parts = line.split(';');
    if (parts.length < 3) {
      errors.push(line);
      continue;
    }
    const isMultiLap = parts.length >= 4;
    const name = parts[0];
    const kartStr = parts[1];
    const lapIdxStr = isMultiLap ? parts[2] : '1';
    const timeStr = isMultiLap ? parts[3] : parts[2];
    const kart = parseInt(kartStr);
    const lapIdx = parseInt(lapIdxStr);
    const time = parseFloat(timeStr);
    if (isNaN(kart) || isNaN(time) || isNaN(lapIdx)) {
      errors.push(line);
      continue;
    }
    const cacheKey = name.toLowerCase().trim() + '|' + kart;
    let reg = regCache[cacheKey];
    if (!reg) {
      reg =
        (regs || []).find((r) => Number(r.kart_number) === kart) ||
        (regs || []).find((r) => r.display_name.toLowerCase().trim() === name.toLowerCase().trim());
      if (!reg) {
        const uname = 'Unknown #' + randomCode4();
        const { data: nr } = await db
          .from('session_registrations')
          .insert({ session_id: sid, display_name: uname, kart_number: kart, is_unknown: true, nationality: 'FR' })
          .select('id,display_name,kart_number')
          .single();
        if (nr) {
          reg = nr;
          regs.push(nr);
        }
      }
      regCache[cacheKey] = reg;
    }
    if (!reg) continue;
    await db.from('laps').insert({ session_id: sid, registration_id: reg.id, lap_index: lapIdx, lap_time_seconds: time });
    imported++;
  }
  await db.from('sessions').update({ status: 'chrono_imported' }).eq('id', sid);
  btn.disabled = false;
  btn.innerHTML = originalLabel;
  showMsg('msg-chrono', imported + ' temps importes' + (errors.length ? ' - ' + errors.length + ' erreurs' : ''), 'ok');
  await loadInscrits();
  await refreshOccupation();
  await renderResultatsSection();
}

// Variante "secteurs activés" — format attendu : Nom;Kart;NumTour;S1;S2;...;Sn;Temps
async function importChronoWithSectors() {
  if (!state.activeDetailSession) {
    showMsg('msg-chrono', 'Aucune session active.', 'err');
    return;
  }
  const raw = document.getElementById('chrono-raw').value.trim();
  if (!raw) {
    showMsg('msg-chrono', 'Colle les temps.', 'err');
    return;
  }
  const sid = state.activeDetailSession.id;
  const n = Number(state.prefs.sector_count || 3);
  const lines = raw.split('\n').map((x) => x.trim()).filter(Boolean);
  const btn = document.getElementById('btn-import-chrono');
  const original = btn.innerHTML;
  btn.disabled = true;
  try {
    const q = await db.from('session_registrations').select('id,display_name,kart_number').eq('session_id', sid);
    const regs = q.data || [];
    const cache = {};
    const rows = [];
    const errors = [];
    await db.from('laps').delete().eq('session_id', sid);
    for (let i = 0; i < lines.length; i++) {
      const v = lines[i].split(';').map((x) => x.trim());
      if (v.length !== 4 + n) {
        errors.push(lines[i]);
        continue;
      }
      const [name, kartRaw, lapRaw, ...tail] = v;
      const time = parseTime(tail.pop());
      const sectors = tail.map(parseTime);
      const kart = Number(kartRaw);
      const lap = Number(lapRaw);
      if (!name || !Number.isFinite(kart) || !Number.isFinite(lap) || !Number.isFinite(time) || sectors.some((x) => !Number.isFinite(x))) {
        errors.push(lines[i]);
        continue;
      }
      const key = name.toLowerCase() + '|' + kart;
      let reg = cache[key] || regs.find((x) => x.display_name === name && Number(x.kart_number) === kart);
      if (!reg) {
        const made = await db
          .from('session_registrations')
          .insert({ session_id: sid, display_name: name, kart_number: kart, is_unknown: true, nationality: 'FR' })
          .select('id,display_name,kart_number')
          .single();
        if (made.error) throw made.error;
        reg = made.data;
        regs.push(reg);
      }
      cache[key] = reg;
      rows.push({
        session_id: sid,
        registration_id: reg.id,
        lap_index: lap,
        lap_time_seconds: time,
        sector_1_seconds: sectors[0] ?? null,
        sector_2_seconds: sectors[1] ?? null,
        sector_3_seconds: sectors[2] ?? null,
      });
      btn.innerHTML = '<span class="spin"></span>Import ' + (i + 1) + '/' + lines.length + '...';
    }
    if (!rows.length) {
      throw new Error('Aucune ligne valide. Format attendu : Nom;Kart;NumTour;' + Array.from({ length: n }, (_, i) => 'S' + (i + 1)).join(';') + ';Temps');
    }
    const saved = await db.from('laps').insert(rows);
    if (saved.error && /sector_/i.test(saved.error.message || '')) {
      throw new Error('Colonnes secteurs absentes de Supabase : exécute supabase_sectors_migration.sql puis réimporte.');
    }
    if (saved.error) throw saved.error;
    await db.from('sessions').update({ status: 'chrono_imported' }).eq('id', sid);
    showMsg('msg-chrono', rows.length + ' tours importés' + (errors.length ? ' — ' + errors.length + ' lignes ignorées' : ''), 'ok');
    document.getElementById('chrono-raw').value = '';
    await loadDetailSession(sid);
  } catch (e) {
    showMsg('msg-chrono', e.message || 'Erreur import', 'err');
  } finally {
    btn.disabled = false;
    btn.innerHTML = original;
  }
}

// --- Publication publique ----------------------------------------------------------------

export async function publishResults() {
  if (!state.activeDetailSession) return;
  let token = state.activeDetailSession.public_results_token;
  if (!token) {
    token = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
    state.activeDetailSession.public_results_token = token;
  }
  await db.from('sessions').update({ status: 'results_published', public_results_token: token }).eq('id', state.activeDetailSession.id);
  state.activeDetailSession.status = 'results_published';
  showMsg('msg-res', 'Resultats publies !', 'ok');
  updateQRRes();
  await renderActivesGrid();
}

export function updateQRRes() {
  const wrap = document.getElementById('qr-res-wrap');
  if (!wrap) return;
  if (!state.activeDetailSession || !state.activeDetailSession.public_results_token) {
    wrap.innerHTML = '<div style="width:160px;height:160px;display:flex;align-items:center;justify-content:center;color:var(--mut);font-size:12px;text-align:center">Publie d\'abord</div>';
    return;
  }
  const url = APP_CONFIG.baseUrl + '/results.html?result=' + state.activeDetailSession.public_results_token + '&v=' + Date.now();
  wrap.innerHTML = '<img src="' + qrSrc(url, 160) + '" alt="QR"/>';
}

export function copyLink(type) {
  let url;
  if (type === 'reg' && state.activeDetailSession) url = APP_CONFIG.baseUrl + '/register.html?session=' + state.activeDetailSession.public_registration_token;
  if (type === 'res' && state.activeDetailSession && state.activeDetailSession.public_results_token)
    url = APP_CONFIG.baseUrl + '/results.html?result=' + state.activeDetailSession.public_results_token + '&v=' + Date.now();
  if (!url) {
    showMsg('msg-res', 'Lien indisponible.', 'err');
    return;
  }
  navigator.clipboard.writeText(url);
  showMsg(type === 'reg' ? 'msg-ins' : 'msg-res', 'Lien copie !', 'ok');
}

export function zoomQR(type) {
  let url, title;
  if (type === 'reg' && state.activeDetailSession) {
    url = APP_CONFIG.baseUrl + '/register.html?session=' + state.activeDetailSession.public_registration_token;
    title = 'QR Inscription';
  }
  if (type === 'res' && state.activeDetailSession && state.activeDetailSession.public_results_token) {
    url = APP_CONFIG.baseUrl + '/results.html?result=' + state.activeDetailSession.public_results_token + '&v=' + Date.now();
    title = 'QR Resultats';
  }
  if (!url) return;
  document.getElementById('qr-zoom-title').textContent = title;
  document.getElementById('qr-zoom-img').src = qrSrc(url, 280);
  document.getElementById('qr-overlay').classList.add('show');
}

export function closeZoom() {
  document.getElementById('qr-overlay').classList.remove('show');
}

export function togglePres(sess) {
  const overlay = document.getElementById('pres-overlay');
  if (overlay.classList.contains('show')) {
    overlay.classList.remove('show');
    return;
  }
  const s = sess || state.activeDetailSession;
  if (!s || !s.public_results_token) return;
  const url = APP_CONFIG.baseUrl + '/results.html?result=' + s.public_results_token + '&v=' + Date.now();
  document.getElementById('pres-img').src = qrSrc(url, 280);
  document.getElementById('pres-sub').textContent = s.title;
  overlay.classList.add('show');
}

// --- Archives ------------------------------------------------------------------------------

export async function deleteSession(id) {
  if (!confirm('Supprimer cette session et toutes ses donnees ?')) return;
  await db.from('laps').delete().eq('session_id', id);
  await db.from('session_registrations').delete().eq('session_id', id);
  await db.from('sessions').delete().eq('id', id);
}

export async function openArchiveDetail(id) {
  const { data: s } = await db.from('sessions').select('*').eq('id', id).single();
  if (!s) return;
  state.archiveSession = s;
  document.getElementById('arch-list-view').style.display = 'none';
  document.getElementById('arch-detail-view').style.display = 'block';
  document.getElementById('arch-detail-title').textContent = s.title;
  const results = await loadRanking(s);
  renderRankTable('arch-ranking', results);
  renderSessionStats(results, 'arch-stats-card', 'arch-stats-grid');
  const { data: regsAll } = await db.from('session_registrations').select('*').eq('session_id', id);
  const regs = (regsAll || []).filter((r) => !r.is_unknown);
  const ri = document.getElementById('arch-inscrits');
  if (!regs.length) {
    ri.innerHTML = '<div class="empty">Aucun inscrit via QR.</div>';
  } else {
    ri.innerHTML =
      '<table class="tbl"><thead><tr><th>Kart</th><th>Nom</th><th>Nat.</th></tr></thead><tbody>' +
      regs.map((r) => '<tr><td>' + (r.kart_number || '--') + '</td><td>' + (r.display_name || '--') + '</td><td>' + (r.nationality || '--') + '</td></tr>').join('') +
      '</tbody></table>';
  }
  if (s.public_results_token) {
    const url = APP_CONFIG.baseUrl + '/results.html?result=' + s.public_results_token + '&v=' + Date.now();
    document.getElementById('arch-qr-wrap').innerHTML = '<div class="qr-wrap"><img src="' + qrSrc(url, 180) + '"/></div>';
  } else {
    document.getElementById('arch-qr-wrap').innerHTML = '<div class="empty">Non publie</div>';
  }
}

export function backToArchives() {
  state.archiveSession = null;
  document.getElementById('arch-list-view').style.display = 'block';
  document.getElementById('arch-detail-view').style.display = 'none';
}

export async function archPublish() {
  if (!state.archiveSession) return;
  let token = state.archiveSession.public_results_token;
  if (!token) {
    token = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
    state.archiveSession.public_results_token = token;
  }
  await db.from('sessions').update({ status: 'results_published', public_results_token: token }).eq('id', state.archiveSession.id);
  showMsg('msg-arch', 'QR republie !', 'ok');
  const url = APP_CONFIG.baseUrl + '/results.html?result=' + token + '&v=' + Date.now();
  document.getElementById('arch-qr-wrap').innerHTML = '<div class="qr-wrap"><img src="' + qrSrc(url, 180) + '"/></div>';
}

export function archCopyLink() {
  if (!state.archiveSession || !state.archiveSession.public_results_token) {
    showMsg('msg-arch', "Publie d'abord.", 'err');
    return;
  }
  navigator.clipboard.writeText(APP_CONFIG.baseUrl + '/results.html?result=' + state.archiveSession.public_results_token + '&v=' + Date.now());
  showMsg('msg-arch', 'Lien copie !', 'ok');
}

export function archTogglePres() {
  togglePres(state.archiveSession);
}

// --- Réglages secteurs / format d'import (Trinisette) -------------------------------------

export function toggleSectorsField() {
  const on = document.getElementById('pref-sectors-enabled')?.checked;
  const wrap = document.getElementById('pref-sectors-wrap');
  const status = document.getElementById('pref-sectors-status');
  if (wrap) wrap.style.display = on ? 'block' : 'none';
  if (status)
    status.textContent = on
      ? 'Les secteurs seront proposés à l’import et affichés dans la fiche PDF seulement s’ils sont renseignés.'
      : 'Mode simplifié : import sans secteurs et fiche PDF avec les temps, écarts et résumé de session.';
  updateChronoFormat();
}

export function updateChronoFormat() {
  const on = document.getElementById('pref-sectors-enabled')?.checked;
  const n = Number(document.getElementById('pref-sector-count')?.value || 3);
  const sectors = Array.from({ length: n }, (_, i) => 'S' + (i + 1));
  const fmt = on ? ['Nom', 'Kart', 'NumTour', ...sectors, 'Temps'] : ['Nom', 'Kart', 'NumTour', 'Temps'];
  const label = document.getElementById('chrono-format-label');
  const help = document.getElementById('chrono-format-help');
  const area = document.getElementById('chrono-raw');
  if (label) label.textContent = 'Temps (format : ' + fmt.join(';') + ' — une ligne par tour)';
  if (help) help.textContent = on ? 'Secteurs activés : ' + fmt.join(';') : 'Sans secteurs : Nom;Kart;NumTour;Temps';
  if (area && !area.value.trim())
    area.placeholder = on
      ? 'Pilote1;1;1;15.120;14.960;14.900;44.980\nPilote2;2;1;16.100;15.550;15.732;47.382'
      : 'Pilote1;1;1;45.210\nPilote1;1;2;44.980\nPilote2;2;1;47.382';
}
