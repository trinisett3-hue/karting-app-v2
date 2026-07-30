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
import { showMsg, qrSrc, formatTime, formatDate, randomCode4, confirmModal } from './ui.js';
import { APP_CONFIG } from '../config.js';
import { loadInscrits, refreshOccupation, updateQRReg, renderActivesGrid } from './sessions.js';
import { uploadSessionAsset, triggerResultEmails } from './publish-exports.js';
import { generateSessionPDFs } from './publish-pdfs.js';

// Echappement HTML minimal pour tout texte saisi par le public (display_name, etc.)
// avant injection dans innerHTML — protection XSS (audit du 28/07, section 4.1).
function escapeHTML(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

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
      .map((r, i) => '<tr><td class="' + (pc[i] || '') + '">' + (i + 1) + '</td><td>' + (r.kart || '--') + '</td><td>' + escapeHTML(r.name) + '</td><td>' + formatTime(r.t) + '</td></tr>')
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
    statBox('Meilleur temps', formatTime(best), bestDriver ? escapeHTML(bestDriver.name) : '') +
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

// 🆕 Palmarès (Point 8a) : meilleur temps absolu, nb sessions jouées, nb de
// podiums (position ≤ 3 dans le classement complet de chaque session, pas
// seulement le temps), et un mini sparkline SVG de l'évolution du temps total
// session par session (les plus anciennes à gauche).
function sparklineSVG(values) {
  if (!values.length) return '';
  const w = 220, h = 40, pad = 4;
  const min = Math.min(...values), max = Math.max(...values);
  const span = max - min || 1;
  const pts = values.map((v, i) => {
    const x = pad + (i * (w - 2 * pad)) / Math.max(values.length - 1, 1);
    // inversé : temps plus petit = mieux = plus haut sur le graphe
    const y = pad + ((v - min) / span) * (h - 2 * pad);
    return x + ',' + y;
  });
  return (
    '<svg width="' + w + '" height="' + h + '" viewBox="0 0 ' + w + ' ' + h + '" style="display:block">' +
    '<polyline points="' + pts.join(' ') + '" fill="none" stroke="var(--acc)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>' +
    '</svg>'
  );
}

export async function showPilotHistory(regId, name) {
  document.getElementById('hist-title').textContent = 'Historique - ' + (name || 'Pilote');
  const contentEl = document.getElementById('hist-content');
  contentEl.innerHTML = '<div class="empty">Chargement...</div>';
  document.getElementById('hist-overlay').classList.add('show');
  try {
    const { data: allRegs } = await db
      .from('session_registrations')
      .select('id,session_id,kart_number,display_name,sessions(id,title,session_date)')
      .ilike('display_name', (name || '').trim());
    if (!allRegs || !allRegs.length) {
      contentEl.innerHTML = '<div class="empty">Aucun historique trouve.</div>';
      return;
    }
    // Correction N+1 (audit 28/07) : une seule requête laps + une seule requête
    // session_registrations pour TOUTES les sessions concernées, au lieu d'une
    // requête laps et d'un loadRanking() (2 requêtes de plus) par inscription.
    const sessionIds = Array.from(new Set(allRegs.map((r) => r.sessions && r.sessions.id).filter(Boolean)));
    const regIds = allRegs.map((r) => r.id);
    const [lapsRes, allSessionRegsRes] = await Promise.all([
      db.from('laps').select('registration_id,lap_time_seconds').in('registration_id', regIds.length ? regIds : ['00000000-0000-0000-0000-000000000000']),
      db.from('session_registrations').select('id,session_id,display_name').in('session_id', sessionIds.length ? sessionIds : ['00000000-0000-0000-0000-000000000000']),
    ]);
    const totalsByReg = new Map();
    (lapsRes.data || []).forEach((l) => {
      totalsByReg.set(l.registration_id, (totalsByReg.get(l.registration_id) || 0) + Number(l.lap_time_seconds));
    });
    const allSessionRegs = allSessionRegsRes.data || [];

    const rows = [];
    let podiums = 0;
    for (const reg of allRegs) {
      const total = totalsByReg.get(reg.id);
      if (total == null) continue;
      // Position réelle dans le classement complet de CETTE session (même logique
      // que loadRanking), pas seulement le temps — c'est ce qui définit un podium.
      let position = null;
      if (reg.sessions && reg.sessions.id) {
        const sessRanking = allSessionRegs
          .filter((r) => r.session_id === reg.sessions.id)
          .map((r) => ({ name: r.display_name || '--', t: totalsByReg.get(r.id) }))
          .filter((r) => r.t != null)
          .sort((a, b) => a.t - b.t);
        const idx = sessRanking.findIndex((r2) => Math.abs(r2.t - total) < 0.0005 && r2.name.toLowerCase().trim() === (name || '').toLowerCase().trim());
        position = idx >= 0 ? idx + 1 : null;
        if (position != null && position <= 3) podiums++;
      }
      rows.push({
        title: (reg.sessions && reg.sessions.title) || '--',
        date: (reg.sessions && reg.sessions.session_date) || '',
        kart: reg.kart_number,
        time: total,
        position,
      });
    }
    if (!rows.length) {
      contentEl.innerHTML = '<div class="empty">Aucun chrono enregistre pour ce pilote.</div>';
      return;
    }
    rows.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    const best = Math.min(...rows.map((r) => r.time));
    const sparklineValues = rows.slice().reverse().map((r) => r.time);
    contentEl.innerHTML =
      '<div class="g3" style="margin-bottom:12px">' +
      '<div style="background:var(--surf2);border:1px solid var(--bord);border-radius:8px;padding:10px;text-align:center"><div style="font-size:10px;color:var(--mut);text-transform:uppercase">Meilleur temps</div><div style="font-size:15px;font-weight:900">' + formatTime(best) + '</div></div>' +
      '<div style="background:var(--surf2);border:1px solid var(--bord);border-radius:8px;padding:10px;text-align:center"><div style="font-size:10px;color:var(--mut);text-transform:uppercase">Sessions jouees</div><div style="font-size:15px;font-weight:900">' + rows.length + '</div></div>' +
      '<div style="background:var(--surf2);border:1px solid var(--bord);border-radius:8px;padding:10px;text-align:center"><div style="font-size:10px;color:var(--mut);text-transform:uppercase">Podiums</div><div style="font-size:15px;font-weight:900">' + podiums + '</div></div>' +
      '</div>' +
      '<div style="margin-bottom:12px;text-align:center">' + sparklineSVG(sparklineValues) + '<div style="font-size:10px;color:var(--mut);margin-top:2px">Evolution du temps total (plus haut = plus rapide), sessions les plus anciennes a gauche</div></div>' +
      '<table class="tbl"><thead><tr><th>Session</th><th>Date</th><th>Kart</th><th>Pos.</th><th>Temps</th></tr></thead><tbody>' +
      rows.map((r) => '<tr><td>' + r.title + '</td><td>' + (r.date ? formatDate(r.date) : '--') + '</td><td>' + (r.kart || '--') + '</td><td>' + (r.position ? 'P' + r.position : '--') + '</td><td>' + formatTime(r.time) + '</td></tr>').join('') +
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

// 🆕 v19 : le texte brut de CHAQUE import (celui réellement traité, donc déjà
// normalisé même s'il vient d'un fichier Excel/CSV — voir handleChronoFile())
// est conservé dans chrono_imports, consultable/téléchargeable depuis les
// archives de la session (voir loadArchiveChronoImports() plus bas). Ne doit
// JAMAIS bloquer l'import lui-même si l'écriture échoue (RLS, réseau...) — le
// chrono importé prime, l'historique est un confort.
async function saveChronoImportHistory(sessionId, rawText, linesCount, importedCount) {
  try {
    await db.from('chrono_imports').insert({
      session_id: sessionId,
      raw_text: rawText,
      lines_count: linesCount,
      imported_count: importedCount,
    });
  } catch (e) {
    console.warn('[results] historique import chrono non enregistré — non bloquant.', e);
  }
}

// Exportée (en plus d'être utilisée par importChrono()) pour la saisie manuelle
// (validateManualChrono ci-dessous) : le tableau "1 ligne par kart" ne saisit
// jamais de secteurs, donc il doit toujours utiliser ce format-ci, même quand
// state.prefs.sectors_enabled est activé pour l'import texte/fichier.
export async function importChronoSimple() {
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
  let imported = 0, errors = [];
  const regCache = {};
  const rowsToImport = [];
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
    rowsToImport.push({ registration_id: reg.id, lap_index: lapIdx, lap_time_seconds: time });
    imported++;
  }
  // P0-4 (audit 28/07) : delete + insert des tours en UNE transaction SQL (import_laps),
  // exécutée seulement après résolution complète des lignes. Un échec de lecture ne
  // touche plus les tours déjà enregistrés.
  if (rowsToImport.length) {
    const { error: rpcErr } = await db.rpc('import_laps', { _session_id: sid, _rows: rowsToImport });
    if (rpcErr) {
      showMsg('msg-chrono', "Import annulé : " + rpcErr.message, 'err');
      btn.disabled = false;
      btn.innerHTML = originalLabel;
      return;
    }
  }
  await db.from('sessions').update({ status: 'chrono_imported' }).eq('id', sid);
  await saveChronoImportHistory(sid, raw, lines.length, imported);
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
    // P0-4 (audit 28/07) : delete + insert des tours en UNE transaction SQL (import_laps).
    const saved = await db.rpc('import_laps', { _session_id: sid, _rows: rows });
    if (saved.error) throw saved.error;
    await db.from('sessions').update({ status: 'chrono_imported' }).eq('id', sid);
    await saveChronoImportHistory(sid, raw, lines.length, rows.length);
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
  await db.from('sessions').update({
    status: 'results_published',
    public_results_token: token,
    // Sans cet horodatage, la page publique « resultats des 6 dernieres
    // heures » n'a aucun moyen de savoir quand la session est passee en ligne.
    results_published_at: new Date().toISOString(),
  }).eq('id', state.activeDetailSession.id);
  state.activeDetailSession.status = 'results_published';
  showMsg('msg-res', 'Resultats publies !', 'ok');
  updateQRRes();
  await renderActivesGrid();
  await afterPublish(state.activeDetailSession, 'msg-res');
}

// Enchainement de la publication : mise en file des envois, televersement du
// classement, puis appel immediat de l'Edge Function. Volontairement APRES
// l'affichage du message de succes : la publication est deja acquise en base,
// et l'admin n'a pas a attendre le rendu du PDF pour voir que ca a marche.
async function afterPublish(sess, msgId) {
  try {
    // 1. TOUS les PDF d'abord : le classement complet + une fiche par pilote
    //    destinataire (demande du 30/07). L'ordre est deliberement l'inverse de
    //    la v27 : la mise en file venait avant, si bien que le cron de
    //    rattrapage (toutes les 5 min) pouvait partir au milieu du rendu et
    //    envoyer a la moitie de la grille un e-mail sans sa fiche — irreparable,
    //    la ligne etant alors marquee 'sent'. Aucune ligne de file n'existe
    //    maintenant tant que les pieces jointes ne sont pas en place : au pire,
    //    un plantage du navigateur ne fait partir aucun e-mail, ce qui se
    //    corrige en republiant.
    showMsg(msgId, 'Resultats publies — generation des PDF...', 'ok');
    let pdfReport = null;
    try {
      pdfReport = await generateSessionPDFs(sess, (done, total, label) => {
        showMsg(msgId, 'Generation des PDF ' + done + '/' + total + ' (' + label + ')...', 'ok');
      });
    } catch (e) {
      // Rendu impossible (iframe bloquee, page publique en erreur) : on
      // continue quand meme. Le pilote recevra le lien vers le classement en
      // ligne, ce qui est l'essentiel. Repli sur le rendu admin du classement.
      console.warn('[publication] generation des PDF publics :', e.message || e);
      try {
        const pdf = await buildSessionPDF(sess);
        await uploadSessionAsset({
          session: sess,
          kind: 'full_pdf',
          blob: pdf.output('blob'),
          filename: 'classement.pdf',
        });
      } catch (e2) {
        console.warn('[publication] classement PDF de repli non televerse :', e2.message || e2);
      }
    }

    // 2. La file d'envoi, une fois les pieces jointes deposees.
    const enq = await db.rpc('enqueue_position_cards', { _session_id: sess.id });
    if (enq.error) throw enq.error;

    // 3. Envoi immediat ; le cron de rattrapage reprend les echecs.
    const res = await triggerResultEmails();
    const suffix = pdfReport
      ? ' (' + pdfReport.pilots + ' fiche(s)' + (pdfReport.failed ? ', ' + pdfReport.failed + ' en echec' : '') + ')'
      : '';
    if (res && typeof res.sent === 'number') {
      showMsg(msgId, 'Resultats publies — ' + res.sent + ' e-mail(s) envoye(s)' + suffix + '.', 'ok');
    } else {
      showMsg(msgId, 'Resultats publies' + suffix + ' — envoi en cours.', 'ok');
    }
  } catch (e) {
    showMsg(msgId, 'Publie, mais envoi des e-mails a reprendre : ' + (e.message || e), 'err');
  }
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
  const { data: s } = await db.from('sessions').select('title').eq('id', id).maybeSingle();
  const { count: regCount } = await db.from('session_registrations').select('id', { count: 'exact', head: true }).eq('session_id', id);
  const ok = await confirmModal({
    title: 'Supprimer cette session ?',
    message: '« ' + (s && s.title ? s.title : 'Session') + ' »\n' + (regCount || 0) + ' inscription(s) et tous les tours seront supprimés définitivement.',
    confirmLabel: 'Supprimer définitivement',
  });
  if (!ok) return;
  // Suppression atomique (audit 28/07, section 4.1) : les 3 delete sont maintenant
  // dans une seule transaction SQL (delete_session_cascade), plus d'orphelins possibles.
  const { error } = await db.rpc('delete_session_cascade', { _session_id: id });
  if (error) {
    showMsg('msg-chrono', 'Suppression annulée : ' + error.message, 'err');
  }
}

export async function openArchiveDetail(id) {
  const { data: s } = await db.from('sessions').select('*').eq('id', id).single();
  if (!s) return;
  state.archiveSession = s;
  document.getElementById('arch-list-view').style.display = 'none';
  document.getElementById('arch-detail-view').style.display = 'block';
  document.getElementById('arch-detail-title').textContent = s.title;
  const typeEl = document.getElementById('arch-type-input');
  if (typeEl) typeEl.value = s.session_type || 'loisir';
  const notesEl = document.getElementById('arch-notes-input');
  if (notesEl) notesEl.value = s.internal_notes || '';
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
      regs.map((r) => '<tr><td>' + (r.kart_number || '--') + '</td><td>' + escapeHTML(r.display_name || '--') + '</td><td>' + escapeHTML(r.nationality || '--') + '</td></tr>').join('') +
      '</tbody></table>';
  }
  if (s.public_results_token) {
    const url = APP_CONFIG.baseUrl + '/results.html?result=' + s.public_results_token + '&v=' + Date.now();
    document.getElementById('arch-qr-wrap').innerHTML = '<div class="qr-wrap"><img src="' + qrSrc(url, 180) + '"/></div>';
  } else {
    document.getElementById('arch-qr-wrap').innerHTML = '<div class="empty">Non publie</div>';
  }
  await loadArchiveChronoImports(id);
}

// --- Historique des imports chrono (v19) ---------------------------------------------------
// Permet de retrouver, depuis une archive, le texte exact qui a été importé
// (colle manuelle ou généré depuis un fichier Excel/CSV) — jusqu'ici ce texte
// était traité puis jeté, impossible à revoir après coup si un import avait
// laissé des trous (kart oublié, ligne mal formée...).

async function loadArchiveChronoImports(sessionId) {
  const el = document.getElementById('arch-chrono-imports');
  if (!el) return;
  el.innerHTML = '<div class="empty">Chargement...</div>';
  const { data, error } = await db
    .from('chrono_imports')
    .select('id,lines_count,imported_count,created_at')
    .eq('session_id', sessionId)
    .order('created_at', { ascending: false });
  if (error || !data || !data.length) {
    el.innerHTML = '<div class="empty">Aucun import chrono enregistré pour cette session.</div>';
    return;
  }
  el.innerHTML =
    '<table class="tbl"><thead><tr><th>Date</th><th>Lignes</th><th>Importés</th><th></th></tr></thead><tbody>' +
    data
      .map(
        (c) =>
          '<tr><td>' + fmtDateTime(c.created_at) + '</td><td>' + (c.lines_count ?? '--') + '</td><td>' + (c.imported_count ?? '--') + '</td>' +
          '<td><button class="btn btn-ghost btn-sm" onclick="downloadChronoImport(\'' + c.id + '\')">Télécharger</button></td></tr>'
      )
      .join('') +
    '</tbody></table>';
}

function fmtDateTime(iso) {
  if (!iso) return '--';
  return new Date(iso).toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export async function downloadChronoImport(importId) {
  const { data, error } = await db.from('chrono_imports').select('raw_text,created_at').eq('id', importId).single();
  if (error || !data) {
    showMsg('msg-arch', 'Import introuvable.', 'err');
    return;
  }
  const blob = new Blob([data.raw_text], { type: 'text/plain;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'chrono-import-' + (data.created_at ? data.created_at.slice(0, 10) : importId.slice(0, 8)) + '.txt';
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// Point 10/11 : type de session + notes internes, éditables aussi depuis une
// archive (une session peut être requalifiée après coup, ex: "Loisir" ->
// "Competition" a posteriori, ou une note ajoutée après la course).
export async function saveArchiveMeta() {
  if (!state.archiveSession) return;
  const sessionType = document.getElementById('arch-type-input')?.value || 'loisir';
  const internalNotes = document.getElementById('arch-notes-input')?.value ?? '';
  const { error } = await db.from('sessions').update({
    session_type: sessionType,
    internal_notes: internalNotes,
  }).eq('id', state.archiveSession.id);
  if (error) {
    showMsg('msg-arch-meta', 'Erreur: ' + error.message, 'err');
    return;
  }
  state.archiveSession.session_type = sessionType;
  state.archiveSession.internal_notes = internalNotes;
  showMsg('msg-arch-meta', 'Enregistre.', 'ok');
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
  const already = !!state.archiveSession.results_published_at;
  await db.from('sessions').update({
    status: 'results_published',
    public_results_token: token,
    // Republier ne doit pas reecrire la date de premiere publication.
    results_published_at: state.archiveSession.results_published_at || new Date().toISOString(),
  }).eq('id', state.archiveSession.id);
  showMsg('msg-arch', 'QR republie !', 'ok');
  const url = APP_CONFIG.baseUrl + '/results.html?result=' + token + '&v=' + Date.now();
  document.getElementById('arch-qr-wrap').innerHTML = '<div class="qr-wrap"><img src="' + qrSrc(url, 180) + '"/></div>';
  if (!already) {
    // Une premiere publication depuis l'archive doit envoyer les e-mails comme
    // une publication normale. Une REpublication, non : les lignes de file sont
    // deja 'sent' et personne ne recoit deux fois le meme e-mail.
    state.archiveSession.results_published_at = new Date().toISOString();
    await afterPublish(state.archiveSession, 'msg-arch');
  }
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

// --- Point 3 : saisie manuelle des chronos (1 ligne par kart) ----------------------------
// Tableau 1 à max_karts, colonnes N° kart / temps / nom (lecture seule, depuis
// session_registrations.kart_number / display_name). Le bouton "Valider" réutilise
// EXACTEMENT le même parsing/import que importChronoSimple()/importChronoWithSectors()
// (on construit le texte "Nom;Kart;1;Temps" attendu par ces fonctions et on délègue,
// au lieu de dupliquer la logique de matching/insertion des tours).

export function renderManualChronoTable() {
  const el = document.getElementById('manual-chrono-table');
  if (!el) return;
  if (!state.activeDetailSession) {
    el.innerHTML = '<div class="empty">Ouvre une session pour saisir les chronos.</div>';
    return;
  }
  const max = state.activeDetailSession.max_karts || 0;
  const byKart = new Map();
  (state.inscritsData || []).forEach((r) => {
    if (r.kart_number != null) byKart.set(Number(r.kart_number), r);
  });
  let html = '<table class="tbl"><thead><tr><th>Kart</th><th>Pilote</th><th>Temps (s ou m:ss.mmm)</th></tr></thead><tbody>';
  for (let k = 1; k <= max; k++) {
    const reg = byKart.get(k);
    html +=
      '<tr>' +
      '<td><span class="kart-badge assigned">' + k + '</span></td>' +
      '<td>' + (reg ? reg.display_name : '<span style="color:var(--mut)">Kart libre</span>') + '</td>' +
      '<td><input class="input-inline kart-inp" style="width:110px" type="text" data-kart="' + k + '" placeholder="--" ' + (reg ? '' : 'disabled') + '/></td>' +
      '</tr>';
  }
  html += '</tbody></table>';
  el.innerHTML = html;
}

export async function validateManualChrono() {
  if (!state.activeDetailSession) {
    showMsg('msg-manual-chrono', 'Aucune session active.', 'err');
    return;
  }
  const el = document.getElementById('manual-chrono-table');
  if (!el) return;
  const inputs = el.querySelectorAll('input[data-kart]');
  const byKart = new Map();
  (state.inscritsData || []).forEach((r) => {
    if (r.kart_number != null) byKart.set(Number(r.kart_number), r);
  });
  const lines = [];
  inputs.forEach((inp) => {
    const val = inp.value.trim();
    if (!val) return;
    const kart = Number(inp.dataset.kart);
    const reg = byKart.get(kart);
    if (!reg) return;
    lines.push(reg.display_name + ';' + kart + ';1;' + val);
  });
  if (!lines.length) {
    showMsg('msg-manual-chrono', 'Aucun temps saisi.', 'err');
    return;
  }
  const raw = document.getElementById('chrono-raw');
  const previous = raw.value;
  raw.value = lines.join('\n');
  // Toujours le format simple (jamais de secteurs en saisie manuelle) — voir
  // commentaire sur importChronoSimple().
  await importChronoSimple();
  raw.value = previous;
  showMsg('msg-manual-chrono', lines.length + ' temps valides et importes.', 'ok');
  renderManualChronoTable();
}

// --- Point 6 : export PDF du classement, côté admin (session active + archive) -----------
// Réutilise le même pattern jsPDF/html2canvas que public-results.js (déjà chargés dans
// admin.html), en s'appuyant sur le même conteneur hors-écran #pdf-render-root, plutôt
// que de réimplémenter un export différent. Rendu volontairement plus simple qu'en public
// (pas de thème circuit à gérer côté admin) : bandeau titre + tableau de classement complet.
async function adminSectionToCanvas(node, width) {
  const holder = document.getElementById('pdf-render-root');
  if (!holder) return null;
  holder.innerHTML = '';
  holder.style.width = width + 'px';
  const wrap = document.createElement('div');
  wrap.style.width = width + 'px';
  wrap.style.background = '#ffffff';
  wrap.appendChild(node);
  holder.appendChild(wrap);
  await new Promise((r) => setTimeout(r, 60));
  // Meme elagage que cote public (cf. sectionToCanvas dans public-results.js) :
  // html2canvas clone tout le document avant de recadrer sur `wrap`, et
  // admin.html est truffe d'icones <svg> en ligne que chaque appel rasterise
  // pour rien. On ne garde dans le clone que <head>, les ancetres de `wrap` et
  // son contenu.
  const keepInClone = (el) => document.head.contains(el) || el.contains(wrap) || wrap.contains(el);
  const canvas = await html2canvas(wrap, { backgroundColor: '#ffffff', scale: 2, width, windowWidth: width, useCORS: true, ignoreElements: (el) => !keepInClone(el) });
  holder.innerHTML = '';
  return canvas;
}

export async function exportSessionPDF(sess, btn) {
  const s = sess;
  if (!s) {
    showMsg('msg-res', 'Aucune session.', 'err');
    return;
  }
  const original = btn ? btn.innerHTML : null;
  if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spin"></span>Export...'; }
  try {
    const pdf = await buildSessionPDF(s);
    pdf.save((s.title || 'session').replace(/[^a-z0-9]/gi, '_') + '-classement.pdf');
  } catch (e) {
    showMsg('msg-res', 'Erreur PDF: ' + e.message, 'err');
  }
  if (btn) { btn.disabled = false; btn.innerHTML = original; }
}

// Le rendu est isole du telechargement : la publication a besoin du MEME
// document, mais sous forme de Blob a televerser, pas de fichier a enregistrer.
// Dupliquer le rendu garantirait qu'un jour le PDF telecharge et le PDF envoye
// par e-mail ne se ressemblent plus.
export async function buildSessionPDF(s) {
  {
    const rankResults = await loadRanking(s);
    const { jsPDF } = window.jspdf;
    const pdf = new jsPDF('p', 'mm', 'a4');
    const width = 700;
    const page = document.createElement('div');
    page.style.cssText = 'font-family:Arial,sans-serif;padding:24px;width:' + width + 'px;box-sizing:border-box;color:#111';
    const rowsHTML = rankResults
      .map((r, i) => {
        const t = formatTime(r.t);
        return '<tr style="border-bottom:1px solid #ddd">' +
          '<td style="padding:6px 8px;font-weight:700">' + (i + 1) + '</td>' +
          '<td style="padding:6px 8px">' + (r.kart || '--') + '</td>' +
          '<td style="padding:6px 8px">' + r.name + '</td>' +
          '<td style="padding:6px 8px">' + t + '</td>' +
          '</tr>';
      })
      .join('');
    page.innerHTML =
      '<div style="border-bottom:3px solid #7c74ff;padding-bottom:10px;margin-bottom:16px">' +
      '<div style="font-size:22px;font-weight:900">' + (s.title || 'Session') + '</div>' +
      '<div style="font-size:12px;color:#666;margin-top:4px">' + (s.session_date ? formatDate(s.session_date) : '') + (s.session_type ? ' · ' + s.session_type : '') + '</div>' +
      '</div>' +
      '<table style="width:100%;border-collapse:collapse;font-size:13px">' +
      '<thead><tr style="text-align:left;border-bottom:2px solid #111"><th style="padding:6px 8px">Pos.</th><th style="padding:6px 8px">Kart</th><th style="padding:6px 8px">Nom</th><th style="padding:6px 8px">Temps</th></tr></thead>' +
      '<tbody>' + (rowsHTML || '<tr><td colspan="4" style="padding:12px;color:#888">Aucun resultat.</td></tr>') + '</tbody>' +
      '</table>';
    const canvas = await adminSectionToCanvas(page, width);
    if (canvas) {
      const imgW = 190;
      const imgH = (canvas.height * imgW) / canvas.width;
      pdf.addImage(canvas.toDataURL('image/jpeg', 0.95), 'JPEG', 10, 10, imgW, imgH);
    }
    return pdf;
  }
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
