// Module Résultats — classement, statistiques, export CSV, historique pilote, import des
// chronos (avec ou sans secteurs), publication publique et archives.
// Repris depuis index.html (lignes 984-1354).
//
// BUG CORRIGÉ ICI (par rapport à l'original) : la version "secteurs activés" de
// importChrono() appelait deux fonctions qui n'étaient définies nulle part dans le
// projet — `parseTime()` et `loadDetailSession()`. Résultat : dès qu'un organisateur
// activait les secteurs et importait des temps, l'app plantait avec une ReferenceError.
// Les deux fonctions sont maintenant réellement implémentées ci-dessous.
import { db, fetchAll, fetchAllIn } from '../lib/supabase.js';
import { state } from '../state.js';
import { showMsg, formatTime, formatDate, randomCode4, confirmModal } from './ui.js';
import { APP_CONFIG } from '../config.js';
import { loadInscrits, refreshOccupation, renderActivesGrid, isSessionPublished } from './sessions.js';
import { uploadSessionAsset, triggerResultEmails, BUCKET as SESSION_EXPORTS_BUCKET } from './publish-exports.js';
import { generateSessionPDFs } from './publish-pdfs.js';
import { hasFeature, renderPremiumLock } from './plan.js';
import { sessionTypeLabel, defaultSessionType } from '../state.js';

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
  // 24/08 : beaucoup de systemes de chronometrage europeens ecrivent la decimale avec une
  // virgule ("45,320", "1:23,456"). Sans cette normalisation parseFloat("45,320") renvoyait
  // 45 — un temps FAUX importe silencieusement — et "1:23,456" renvoyait NaN. La virgule ne
  // peut pas etre un separateur de colonnes ici : la valeur recue est deja une cellule isolee.
  const s = String(str).trim().replace(',', '.');
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
}

export async function loadRanking(sess) {
  const s = sess;
  if (!s) return [];
  // P0-5 (audit 30/07) : pagination obligatoire. Sans .range(), PostgREST tronquait
  // silencieusement à 1000 lignes — une session de 60 pilotes x 20 tours suffit à
  // fausser le classement, sans le moindre message d'erreur.
  const [lapsRes, regsRes] = await Promise.all([
    fetchAll(() => db.from('laps').select('*').eq('session_id', s.id)),
    fetchAll(() => db.from('session_registrations').select('*').eq('session_id', s.id)),
  ]);
  const laps = lapsRes.data;
  const regs = regsRes.data;
  if (!laps || !regs) return [];
  // Classement au MEILLEUR TOUR (et non au temps cumule). Le cumul penalisait
  // mecaniquement les pilotes ayant fait le plus de tours : un pilote arrive en
  // retard, parti en tete-a-queue ou rentre au stand se retrouvait devant les
  // autres. En karting loisir, la reference est le meilleur tour de chacun.
  const bests = new Map();
  const totals = new Map();
  const counts = new Map();
  laps.forEach((l) => {
    const v = Number(l.lap_time_seconds);
    if (!Number.isFinite(v) || v <= 0) return;
    const prev = bests.get(l.registration_id);
    if (prev == null || v < prev) bests.set(l.registration_id, v);
    totals.set(l.registration_id, (totals.get(l.registration_id) || 0) + v);
    counts.set(l.registration_id, (counts.get(l.registration_id) || 0) + 1);
  });
  const results = [];
  regs.forEach((r) => {
    const t = bests.get(r.id);
    if (t != null) {
      results.push({
        name: r.display_name || '--',
        kart: r.kart_number,
        t,                                  // temps de classement = meilleur tour
        total: totals.get(r.id) || 0,       // cumul conserve, a titre indicatif
        lapsCount: counts.get(r.id) || 0,
        nat: r.nationality || 'FR',
      });
    }
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
  // Toutes les stats portent sur le meilleur tour : c'est la valeur sur laquelle
  // le classement est etabli, donc la seule qui soit comparable entre pilotes.
  const times = results.map((r) => r.t);
  const best = Math.min(...times);
  const avg = times.reduce((a, b) => a + b, 0) / times.length;
  const bestDriver = results.find((r) => r.t === best);
  const gapLeader = results.length > 1 ? results[1].t - results[0].t : 0;
  grid.innerHTML =
    statBox('Meilleur tour', formatTime(best), bestDriver ? escapeHTML(bestDriver.name) : '') +
    statBox('Meilleur tour moyen', formatTime(avg), results.length + ' pilotes') +
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
    const { data: allRegs } = await fetchAll(() =>
      db
        .from('session_registrations')
        .select('id,session_id,kart_number,display_name,sessions(id,title,session_date)')
        .ilike('display_name', (name || '').trim())
    );
    if (!allRegs || !allRegs.length) {
      contentEl.innerHTML = '<div class="empty">Aucun historique trouve.</div>';
      return;
    }
    // Correction N+1 (audit 28/07) : une seule requête laps + une seule requête
    // session_registrations pour TOUTES les sessions concernées, au lieu d'une
    // requête laps et d'un loadRanking() (2 requêtes de plus) par inscription.
    const sessionIds = Array.from(new Set(allRegs.map((r) => r.sessions && r.sessions.id).filter(Boolean)));
    const regIds = allRegs.map((r) => r.id);
    // P0-5 (audit 30/07) : pagination + découpage des listes `.in()` (au-delà de
    // ~600 UUID dans l'URL, PostgREST répond 414 Request-URI Too Large).
    const [lapsRes, allSessionRegsRes] = await Promise.all([
      fetchAllIn(() => db.from('laps').select('registration_id,lap_time_seconds'), 'registration_id', regIds),
      fetchAllIn(() => db.from('session_registrations').select('id,session_id,display_name'), 'session_id', sessionIds),
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

// --- Format d'import personnalisable par circuit (24/08, Trinisette) --------------------
// Objectif : que l'import fonctionne quel que soit le systeme de chronometrage du
// circuit (Apex Timing, MyLaps, chrono manuel maison...), sans imposer un format fixe.
//
// Principe de securite : TANT QUE le circuit n'a pas explicitement active "Personnaliser
// le format d'import" dans Parametres, tout le code ci-dessous est un pur NO-OP et le
// comportement reste EXACTEMENT celui d'avant (separateur ';' fixe, tolerance historique
// 3 ou 4 colonnes geree ligne par ligne). Aucune reecriture, aucun risque de regression
// pour les circuits deja en production. La personnalisation n'entre en jeu que si
// getChronoImportFormat().customized === true.

function identityChronoFormat() {
  const n = Number(state.prefs.sector_count || 3);
  return {
    customized: false,
    delimiter: ';',
    has_header: false,
    col_name: 1,
    col_kart: 2,
    col_lap: 3,
    col_sectors: Array.from({ length: n }, (_, i) => 4 + i),
    col_time: 4 + n,
  };
}

export function getChronoImportFormat() {
  const saved = state.prefs.chrono_import;
  if (saved && saved.customized) return { ...identityChronoFormat(), ...saved };
  return identityChronoFormat();
}

export function detectDelimiter(sampleLine) {
  const candidates = [';', ',', '\t'];
  let best = ';', bestCount = 1;
  candidates.forEach((d) => {
    const c = String(sampleLine || '').split(d).length;
    if (c > bestCount) { bestCount = c; best = d; }
  });
  return best;
}

function resolvedDelimiter(fmt, firstLine) {
  if (fmt.delimiter === 'auto') return detectDelimiter(firstLine);
  if (fmt.delimiter === 'tab') return '\t';
  // 'space' : exports en colonnes alignees (largeur fixe) — on decoupe sur toute suite
  // d'espaces, sinon chaque espace de remplissage creerait une colonne vide. Volontairement
  // absent de la detection automatique (detectDelimiter), qui couperait les noms composes ;
  // ce choix n'est proposé que dans la fenetre de correction manuelle du mapping.
  if (fmt.delimiter === 'space') return /\s+/;
  return fmt.delimiter;
}

// Traduit le texte colle/charge en lignes canoniques 'Nom;Kart;NumTour[;S1..Sn];Temps',
// pretes pour importChronoSimple/importChronoWithSectors. Pure fonction en memoire —
// aucune ecriture DB — utilisee a la fois par l'apercu et juste avant l'import reel.
// Quand le format n'est pas personnalise, reproduit fidelement la logique historique
// (tolerance 3 ou 4 colonnes) plutot que d'imposer un mapping fixe, pour que l'apercu
// et le comportement reel restent identiques dans ce cas.
// explicitFmt (optionnel) : evalue le texte avec CE format-la au lieu du format enregistre.
// Sert a tester un format devine avant de l'enregistrer, et a convertir le texte une fois
// que l'organisateur a corrige le mapping dans la fenetre de correction, sans avoir a
// toucher aux preferences.
export function normalizeChronoText(rawText, explicitFmt) {
  const fmt = explicitFmt || getChronoImportFormat();
  const sectorsOn = !!state.prefs.sectors_enabled;
  const n = Number(state.prefs.sector_count || 3);
  const lines = String(rawText || '').split('\n').map((l) => l.replace(/\r$/, '')).filter((l) => l.trim() !== '');
  if (!lines.length) return { text: '', rows: [] };

  if (!fmt.customized) {
    const rows = lines.map((line) => {
      const parts = line.split(';').map((p) => p.trim());
      if (sectorsOn) {
        const valid = parts.length === 4 + n && !!parts[0] && Number.isFinite(Number(parts[1])) && Number.isFinite(Number(parts[2])) &&
          Number.isFinite(parseTime(parts[parts.length - 1])) && parts.slice(3, 3 + n).every((s) => Number.isFinite(parseTime(s)));
        return { raw: line, canonical: line, name: parts[0] || '', kart: parts[1] || '', lap: parts[2] || '', sectorVals: parts.slice(3, 3 + n), time: parts[parts.length - 1] || '', valid };
      }
      const isMultiLap = parts.length >= 4;
      const name = parts[0] || '';
      const kart = parts[1] || '';
      const lap = isMultiLap ? parts[2] : '1';
      const time = isMultiLap ? parts[3] : parts[2];
      const valid = parts.length >= 3 && !!name && Number.isFinite(Number(kart)) && Number.isFinite(Number(lap)) && Number.isFinite(parseTime(time));
      return { raw: line, canonical: line, name, kart, lap, sectorVals: [], time: time || '', valid };
    });
    return { text: rows.map((r) => r.canonical).join('\n'), rows };
  }

  // Format personnalise : separateur + en-tete + mapping de colonnes explicite (voir
  // Parametres > Secteurs et format d'import des chronos).
  const delim = resolvedDelimiter(fmt, lines[0]);
  const dataLines = fmt.has_header ? lines.slice(1) : lines;
  const get = (parts, colNum) => (parts[colNum - 1] != null ? String(parts[colNum - 1]).trim() : '');
  const rows = dataLines.map((line) => {
    const parts = line.split(delim);
    const name = get(parts, fmt.col_name);
    const kart = get(parts, fmt.col_kart);
    const lap = get(parts, fmt.col_lap) || '1';
    const sectorVals = sectorsOn ? (fmt.col_sectors || []).slice(0, n).map((c) => get(parts, c)) : [];
    const time = get(parts, fmt.col_time);
    const canonicalParts = sectorsOn ? [name, kart, lap, ...sectorVals, time] : [name, kart, lap, time];
    const valid = !!name && Number.isFinite(Number(kart)) && Number.isFinite(parseTime(time)) && (!sectorsOn || sectorVals.every((v) => Number.isFinite(parseTime(v))));
    return { raw: line, canonical: canonicalParts.join(';'), name, kart, lap, sectorVals, time, valid };
  });
  return { text: rows.map((r) => r.canonical).join('\n'), rows };
}

// Re-ecrit #chrono-raw en format canonique juste avant l'import reel. NO-OP tant que le
// format n'est pas personnalise — voir le principe de securite en tete de section.
function normalizeChronoRawTextarea() {
  const fmt = getChronoImportFormat();
  if (!fmt.customized) return;
  const area = document.getElementById('chrono-raw');
  if (!area) return;
  const { text } = normalizeChronoText(area.value);
  if (text) area.value = text;
}

// Apercu live des lignes telles qu'elles seront interpretees — vit desormais dans
// Parametres (echantillon colle + mapping), appele a la saisie de l'echantillon et a
// chaque changement de colonne/separateur/en-tete, pour que l'organisateur valide son
// format une fois pour toutes. sourceId/targetId restent parametrables (repli sur
// 'chrono-raw'/'chrono-preview', l'ancien emplacement sur Sessions actives, au cas ou
// un appelant plus ancien — cache navigateur non purge — invoquerait la fonction sans
// argument). N'ecrit jamais en base : lecture seule, purement informative.
export function renderChronoPreview(sourceId, targetId) {
  const area = document.getElementById(sourceId || 'chrono-raw');
  const el = document.getElementById(targetId || 'chrono-preview');
  if (!area || !el) return;
  const raw = area.value.trim();
  if (!raw) { el.innerHTML = ''; return; }
  const { rows } = normalizeChronoText(raw);
  const validCount = rows.filter((r) => r.valid).length;
  const invalidCount = rows.length - validCount;
  const sample = rows.slice(0, 5);
  const sectorsOn = !!state.prefs.sectors_enabled;
  const head = sectorsOn
    ? '<tr><th>Nom</th><th>Kart</th><th>Tour</th><th>Secteurs</th><th>Temps</th><th></th></tr>'
    : '<tr><th>Nom</th><th>Kart</th><th>Tour</th><th>Temps</th><th></th></tr>';
  const body = sample.map((r) => {
    const badge = r.valid ? '<span style="color:#3ddc97;font-weight:700">OK</span>' : '<span style="color:#ff6767;font-weight:700">Ignoree</span>';
    return sectorsOn
      ? '<tr><td>' + escapeHTML(r.name) + '</td><td>' + escapeHTML(r.kart) + '</td><td>' + escapeHTML(r.lap) + '</td><td>' + r.sectorVals.map(escapeHTML).join(' / ') + '</td><td>' + escapeHTML(r.time) + '</td><td>' + badge + '</td></tr>'
      : '<tr><td>' + escapeHTML(r.name) + '</td><td>' + escapeHTML(r.kart) + '</td><td>' + escapeHTML(r.lap) + '</td><td>' + escapeHTML(r.time) + '</td><td>' + badge + '</td></tr>';
  }).join('');
  el.innerHTML =
    '<div style="font-size:11px;color:var(--mut);margin-bottom:6px">Aperçu (' + sample.length + ' sur ' + rows.length + ' lignes) — ' +
    '<span style="color:#3ddc97">' + validCount + ' valides</span>' + (invalidCount ? ', <span style="color:#ff6767">' + invalidCount + ' ignorées</span>' : '') + '</div>' +
    '<table class="tbl" style="font-size:12px">' + '<thead>' + head + '</thead><tbody>' + body + '</tbody></table>';
}

// Sauvegarde minimale du mapping detecte/personnalise, independante de settings.savePrefs()
// (les champs de Parametres ne sont pas forcement montes quand on detecte depuis l'onglet
// Sessions actives). Meme mecanisme d'ecriture que savePrefs (cle 'global' de app_settings).
async function saveChronoImportFormat(fmt) {
  state.prefs.chrono_import = fmt;
  try {
    await db.from('app_settings').upsert({ key: 'global', value: state.prefs }, { onConflict: 'tenant_id,key' });
  } catch (e) {
    console.warn('[results] format d’import détecté non enregistré — non bloquant.', e);
  }
}

// Devine le role de chaque colonne (nom / kart / tour / temps) a partir d'un echantillon
// de lignes DEJA decoupees en colonnes (independant du separateur ou du support texte vs
// tableur — utilise a la fois par computeDetectedFormat (texte) et
// computeDetectedFormatFromRows (Excel/CSV) ci-dessous).
function inferColumnRoles(dataRows) {
  if (!dataRows || !dataRows.length) return null;
  const colCount = Math.max(...dataRows.map((p) => p.length));
  const looksTime = (s) => /^\d{1,2}:\d{2}([.,]\d+)?$/.test(String(s).trim()) || /^\d+[.,]\d{1,3}$/.test(String(s).trim());
  const looksSmallInt = (s) => /^\d{1,3}$/.test(String(s).trim());
  const timeScores = [];
  const intCols = [];
  let colName = null;
  for (let c = 0; c < colCount; c++) {
    const vals = dataRows.map((p) => (p[c] != null ? String(p[c]).trim() : '')).filter(Boolean);
    if (!vals.length) continue;
    const timeRatio = vals.filter(looksTime).length / vals.length;
    const intRatio = vals.filter(looksSmallInt).length / vals.length;
    const textRatio = vals.filter((v) => isNaN(Number(String(v).replace(',', '.'))) && !looksTime(v)).length / vals.length;
    timeScores.push({ c, timeRatio });
    if (intRatio > 0.7) intCols.push(c);
    if (textRatio > 0.7 && colName == null) colName = c + 1;
  }
  timeScores.sort((a, b) => b.timeRatio - a.timeRatio);
  const colTime = timeScores.length && timeScores[0].timeRatio > 0.5 ? timeScores[0].c + 1 : colCount;
  const colKart = intCols.length ? intCols[0] + 1 : Math.min(2, colCount);
  const colLap = intCols.length > 1 ? intCols[1] + 1 : colKart;
  return { col_name: colName == null ? 1 : colName, col_kart: colKart, col_lap: colLap, col_time: colTime };
}

// Devine separateur + en-tete + mapping de colonnes a partir de LIGNES DE TEXTE brutes
// (collage dans un textarea). Pure fonction, aucune ecriture DB. Retourne null si le
// contenu est insuffisant pour deviner quoi que ce soit.
function computeDetectedFormat(lines) {
  if (!lines || !lines.length) return null;
  const delim = detectDelimiter(lines[0]);
  let dataLines = lines;
  let hasHeader = false;
  const looksNumeric = (s) => /^-?\d+([.,:]\d+)?$/.test(String(s).trim());
  const firstParts = lines[0].split(delim);
  if (firstParts.length >= 3 && !firstParts.some(looksNumeric)) {
    hasHeader = true;
    dataLines = lines.slice(1);
  }
  if (!dataLines.length) return null;
  const sample = dataLines.slice(0, Math.min(10, dataLines.length)).map((l) => l.split(delim));
  const roles = inferColumnRoles(sample);
  if (!roles) return null;
  return {
    customized: true,
    delimiter: delim === '\t' ? 'tab' : delim,
    has_header: hasHeader,
    ...roles,
    col_sectors: (state.prefs.chrono_import && state.prefs.chrono_import.col_sectors) || identityChronoFormat().col_sectors,
  };
}

// Meme detection que computeDetectedFormat, mais a partir de LIGNES DEJA DECOUPEES EN
// COLONNES par le lecteur Excel/CSV (XLSX.utils.sheet_to_json), donc pas de separateur a
// deviner. Utilisee par handleChronoFile() ci-dessous pour la detection automatique sur
// fichier importe.
function computeDetectedFormatFromRows(rawRows) {
  if (!rawRows || !rawRows.length) return null;
  const looksNumeric = (s) => /^-?\d+([.,:]\d+)?$/.test(String(s ?? '').trim());
  const firstRow = rawRows[0] || [];
  let hasHeader = false;
  let dataRows = rawRows;
  if (firstRow.length >= 3 && !firstRow.some((v) => looksNumeric(v))) {
    hasHeader = true;
    dataRows = rawRows.slice(1);
  }
  if (!dataRows.length) return null;
  const roles = inferColumnRoles(dataRows.slice(0, Math.min(10, dataRows.length)));
  if (!roles) return null;
  return {
    customized: true,
    delimiter: ';', // non pertinent ici (colonnes deja separees par la feuille) — garde pour coherence de forme avec le format texte
    has_header: hasHeader,
    ...roles,
    col_sectors: (state.prefs.chrono_import && state.prefs.chrono_import.col_sectors) || identityChronoFormat().col_sectors,
  };
}

// Reflete un format (detecte ou personnalise) dans le formulaire de Parametres (memes ids
// que ceux peuples par settings.loadPrefs()), pour que l'organisateur le voie et puisse le
// corriger avant de cliquer sur "Enregistrer les parametres". Sans effet si ces champs ne
// sont pas montes (ex. Parametres pas encore ouvert) — chaque set est garde par une
// verification d'existence.
function reflectChronoFormatInSettingsForm(fmt) {
  const setV = (id, val) => { const el = document.getElementById(id); if (el) el.value = val; };
  const setC = (id, val) => { const el = document.getElementById(id); if (el) el.checked = val; };
  setC('pref-chrono-custom', true);
  setV('pref-chrono-delim', fmt.delimiter);
  setC('pref-chrono-header', fmt.has_header);
  setV('pref-chrono-col-name', fmt.col_name);
  setV('pref-chrono-col-kart', fmt.col_kart);
  setV('pref-chrono-col-lap', fmt.col_lap);
  setV('pref-chrono-col-time', fmt.col_time);
  setV('pref-chrono-col-sectors', (fmt.col_sectors || []).join(','));
  const wrap = document.getElementById('pref-chrono-custom-wrap');
  if (wrap) wrap.style.display = 'block';
}

// Fenetre de correction du mapping — ouverte UNIQUEMENT quand un import echoue faute de
// format reconnu (voir importChrono() et handleChronoFile()). A gauche ce qui a ete trouve
// dans le fichier (colonnes, en-tetes, exemples de valeurs), a droite l'attribution :
// quelle colonne du fichier alimente chaque champ dont l'app a besoin pour calculer.
// L'organisateur corrige, voit l'apercu se mettre a jour en direct, puis choisit d'appliquer
// le mapping pour ce seul import ou de l'enregistrer definitivement dans les Parametres.
// Resout {fmt, persist} ou null si annule. N'ecrit jamais en base elle-meme.
function openChronoMappingModal(opts) {
  const isText = !!(opts && opts.lines && opts.lines.length);
  const lines = (opts && opts.lines) || [];
  const fileRows = (opts && opts.rawRows) || [];
  const suggested = (opts && opts.suggested) || null;
  const sectorsOn = !!state.prefs.sectors_enabled;
  const nSectors = Number(state.prefs.sector_count || 3);

  let delim = suggested && suggested.delimiter ? suggested.delimiter : (isText ? (detectDelimiter(lines[0]) === '\t' ? 'tab' : detectDelimiter(lines[0])) : ';');
  let hasHeader = suggested ? !!suggested.has_header : false;
  let colName = (suggested && suggested.col_name) || 1;
  let colKart = (suggested && suggested.col_kart) || 2;
  let colLap = (suggested && suggested.col_lap) || 3;
  let colTime = (suggested && suggested.col_time) || 4;
  let colSectors = ((suggested && suggested.col_sectors) || identityChronoFormat().col_sectors).slice(0, nSectors);

  const splitRows = () => {
    if (!isText) return fileRows.filter((r) => r && r.length).map((r) => r.map((v) => (v == null ? '' : String(v))));
    const d = resolvedDelimiter({ delimiter: delim }, lines[0]);
    return lines.map((l) => l.split(d));
  };
  const currentFmt = () => ({
    customized: true,
    delimiter: isText ? delim : ';',
    has_header: hasHeader,
    col_name: colName,
    col_kart: colKart,
    col_lap: colLap,
    col_time: colTime,
    col_sectors: colSectors.slice(0, nSectors),
  });
  const columns = () => {
    const rows = splitRows();
    const count = Math.max(1, ...rows.map((r) => r.length));
    const header = hasHeader ? (rows[0] || []) : [];
    const out = [];
    for (let c = 1; c <= count; c++) {
      const h = hasHeader && header[c - 1] != null && String(header[c - 1]).trim() ? String(header[c - 1]).trim() : '';
      out.push({ c, head: h, label: h ? c + ' — ' + h : 'Colonne ' + c });
    }
    return out;
  };
  // Memes regles de validite que la branche "format personnalise" de normalizeChronoText(),
  // mais appliquees a des lignes deja decoupees en colonnes (texte ET fichier tableur).
  const evaluate = () => {
    const rows = splitRows();
    const data = hasHeader ? rows.slice(1) : rows;
    const f = currentFmt();
    const get = (parts, c) => (parts[c - 1] != null ? String(parts[c - 1]).trim() : '');
    return data.map((parts) => {
      const name = get(parts, f.col_name);
      const kart = get(parts, f.col_kart);
      const lap = get(parts, f.col_lap) || '1';
      const sv = sectorsOn ? f.col_sectors.map((c) => get(parts, c)) : [];
      const time = get(parts, f.col_time);
      const valid = !!name && Number.isFinite(Number(kart)) && Number.isFinite(parseTime(time)) &&
        (!sectorsOn || sv.every((v) => Number.isFinite(parseTime(v))));
      return { name, kart, lap, sectorVals: sv, time, valid };
    });
  };

  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'cm-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(6,8,14,.62);backdrop-filter:blur(6px);z-index:9999;display:flex;align-items:center;justify-content:center;padding:16px;';
    const box = document.createElement('div');
    box.className = 'cm-box';
    box.style.cssText = 'background:var(--surf,#181818);border:1px solid var(--bord,#333);border-radius:16px;padding:22px;max-width:820px;width:100%;max-height:88vh;overflow:auto;color:var(--txt,#eee);font-family:inherit;box-shadow:0 26px 70px -18px rgba(0,0,0,.55);';
    overlay.appendChild(box);

    function close(result) {
      document.removeEventListener('keydown', onKey);
      if (overlay.parentNode) document.body.removeChild(overlay);
      resolve(result);
    }
    function onKey(e) { if (e.key === 'Escape') close(null); }

    function render() {
      const cols = columns();
      const rowsEval = evaluate();
      const validCount = rowsEval.filter((r) => r.valid).length;
      const sample = rowsEval.slice(0, 5);
      const dataRows = (hasHeader ? splitRows().slice(1) : splitRows()).slice(0, 3);

      const colSelect = (id, current) =>
        '<select data-col="' + id + '" style="width:100%;padding:7px 8px;border-radius:8px;border:1px solid var(--bord,#444);background:var(--surf2,#111);color:var(--txt,#eee);font-size:12px">' +
        cols.map((c) => '<option value="' + c.c + '"' + (Number(current) === c.c ? ' selected' : '') + '>' + escapeHTML(c.label) + '</option>').join('') +
        '</select>';

      const detectedTable =
        '<table class="tbl" style="font-size:11px;width:100%"><thead><tr><th>Colonne</th><th>En-tête</th><th>Exemples</th></tr></thead><tbody>' +
        cols.map((c) => {
          const ex = dataRows.map((r) => (r[c.c - 1] != null ? String(r[c.c - 1]).trim() : '')).filter(Boolean).slice(0, 3).join(' · ');
          return '<tr><td style="white-space:nowrap">' + c.c + '</td><td>' + escapeHTML(c.head || '—') + '</td><td style="color:var(--mut,#aaa)">' + escapeHTML(ex) + '</td></tr>';
        }).join('') +
        '</tbody></table>';

      const attribution =
        '<div class="field" style="margin-bottom:8px"><label style="font-size:11px">Nom du pilote</label>' + colSelect('name', colName) + '</div>' +
        '<div class="field" style="margin-bottom:8px"><label style="font-size:11px">N° de kart</label>' + colSelect('kart', colKart) + '</div>' +
        '<div class="field" style="margin-bottom:8px"><label style="font-size:11px">N° de tour</label>' + colSelect('lap', colLap) + '</div>' +
        '<div class="field" style="margin-bottom:8px"><label style="font-size:11px">Temps au tour</label>' + colSelect('time', colTime) + '</div>' +
        (sectorsOn ? colSectors.map((sc, i) =>
          '<div class="field" style="margin-bottom:8px"><label style="font-size:11px">Secteur ' + (i + 1) + '</label>' + colSelect('sector' + i, sc) + '</div>').join('') : '');

      const head = sectorsOn
        ? '<tr><th>Nom</th><th>Kart</th><th>Tour</th><th>Secteurs</th><th>Temps</th><th></th></tr>'
        : '<tr><th>Nom</th><th>Kart</th><th>Tour</th><th>Temps</th><th></th></tr>';
      const previewBody = sample.map((r) => {
        const badge = r.valid ? '<span style="color:#3ddc97;font-weight:700">OK</span>' : '<span style="color:#ff6767;font-weight:700">Ignorée</span>';
        return sectorsOn
          ? '<tr><td>' + escapeHTML(r.name) + '</td><td>' + escapeHTML(r.kart) + '</td><td>' + escapeHTML(r.lap) + '</td><td>' + r.sectorVals.map(escapeHTML).join(' / ') + '</td><td>' + escapeHTML(r.time) + '</td><td>' + badge + '</td></tr>'
          : '<tr><td>' + escapeHTML(r.name) + '</td><td>' + escapeHTML(r.kart) + '</td><td>' + escapeHTML(r.lap) + '</td><td>' + escapeHTML(r.time) + '</td><td>' + badge + '</td></tr>';
      }).join('');

      box.innerHTML =
        '<div style="font-weight:800;font-size:16px;margin-bottom:6px">Format d’import non reconnu</div>' +
        '<div style="font-size:13px;color:var(--mut,#ccc);margin-bottom:16px;line-height:1.5">Ton fichier a bien été lu, mais aucune ligne n’a pu être interprétée avec le format enregistré. Vérifie ci-dessous ce qui a été trouvé, et indique quelle colonne correspond à quoi. L’aperçu se met à jour au fur et à mesure.</div>' +
        '<div style="display:flex;gap:16px;flex-wrap:wrap">' +
        '<div style="flex:1 1 340px;min-width:280px">' +
        '<div style="font-weight:700;font-size:12px;text-transform:uppercase;letter-spacing:.04em;margin-bottom:8px">Format détecté</div>' +
        (isText
          ? '<div class="field" style="margin-bottom:8px"><label style="font-size:11px">Séparateur</label>' +
            '<select data-ctl="delim" style="width:100%;padding:7px 8px;border-radius:8px;border:1px solid var(--bord,#444);background:var(--surf2,#111);color:var(--txt,#eee);font-size:12px">' +
            [[';', 'Point-virgule ( ; )'], [',', 'Virgule ( , )'], ['tab', 'Tabulation'], ['|', 'Barre verticale ( | )'], ['space', 'Espaces (colonnes alignées)']].map((o) =>
              '<option value="' + o[0] + '"' + (delim === o[0] ? ' selected' : '') + '>' + o[1] + '</option>').join('') +
            '</select></div>'
          : '<div style="font-size:11px;color:var(--mut,#aaa);margin-bottom:8px">Colonnes lues directement depuis le fichier (pas de séparateur à choisir).</div>') +
        '<label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-size:12px;margin-bottom:10px">' +
        '<input type="checkbox" data-ctl="header" style="width:auto"' + (hasHeader ? ' checked' : '') + '/>' +
        '<span>La 1ère ligne est un en-tête</span></label>' +
        detectedTable +
        '</div>' +
        '<div style="flex:1 1 260px;min-width:230px">' +
        '<div style="font-weight:700;font-size:12px;text-transform:uppercase;letter-spacing:.04em;margin-bottom:8px">Attribution</div>' +
        '<div style="font-size:11px;color:var(--mut,#aaa);margin-bottom:10px">Ce dont l’application a besoin pour calculer le classement.</div>' +
        attribution +
        '</div>' +
        '</div>' +
        '<div style="margin-top:16px">' +
        '<div style="font-size:11px;color:var(--mut,#aaa);margin-bottom:6px">Aperçu (' + sample.length + ' sur ' + rowsEval.length + ' lignes) — ' +
        '<span style="color:' + (validCount ? '#3ddc97' : '#ff6767') + '">' + validCount + ' valides</span>' +
        (rowsEval.length - validCount ? ', <span style="color:#ff6767">' + (rowsEval.length - validCount) + ' ignorées</span>' : '') + '</div>' +
        '<table class="tbl" style="font-size:12px;width:100%"><thead>' + head + '</thead><tbody>' + previewBody + '</tbody></table>' +
        '</div>' +
        (validCount ? '' : '<div style="margin-top:10px;font-size:12px;color:#ff6767">Aucune ligne valide avec cette attribution — ajuste les colonnes ci-dessus.</div>') +
        '<div style="display:flex;gap:10px;justify-content:flex-end;flex-wrap:wrap;margin-top:18px">' +
        '<button type="button" data-act="cancel" style="padding:9px 16px;border-radius:9px;border:1px solid var(--bord,#444);background:var(--surf2,transparent);color:var(--txt,#eee);cursor:pointer;font-weight:600">Annuler</button>' +
        '<button type="button" data-act="once"' + (validCount ? '' : ' disabled') + ' style="padding:9px 16px;border-radius:9px;border:1px solid var(--bord,#444);background:var(--surf2,transparent);color:var(--txt,#eee);font-weight:700;cursor:' + (validCount ? 'pointer' : 'not-allowed') + ';opacity:' + (validCount ? '1' : '.5') + '">Utiliser pour cet import</button>' +
        '<button type="button" data-act="always"' + (validCount ? '' : ' disabled') + ' style="padding:9px 16px;border-radius:9px;border:none;background:#2563eb;color:#fff;font-weight:700;cursor:' + (validCount ? 'pointer' : 'not-allowed') + ';opacity:' + (validCount ? '1' : '.5') + '">Enregistrer définitivement</button>' +
        '</div>' +
        '<div style="font-size:11px;color:var(--mut,#aaa);margin-top:8px;text-align:right">« Définitivement » enregistre ce mapping dans Paramètres : les prochains fichiers du même système passeront tout seuls.</div>';

      box.querySelectorAll('[data-col]').forEach((sel) => {
        sel.addEventListener('change', () => {
          const v = parseInt(sel.value, 10);
          const which = sel.getAttribute('data-col');
          if (which === 'name') colName = v;
          else if (which === 'kart') colKart = v;
          else if (which === 'lap') colLap = v;
          else if (which === 'time') colTime = v;
          else if (which.startsWith('sector')) colSectors[parseInt(which.slice(6), 10)] = v;
          render();
        });
      });
      const delimSel = box.querySelector('[data-ctl="delim"]');
      if (delimSel) delimSel.addEventListener('change', () => { delim = delimSel.value; render(); });
      const headerCb = box.querySelector('[data-ctl="header"]');
      if (headerCb) headerCb.addEventListener('change', () => { hasHeader = headerCb.checked; render(); });
      box.querySelector('[data-act="cancel"]').addEventListener('click', () => close(null));
      const onceBtn = box.querySelector('[data-act="once"]');
      const alwaysBtn = box.querySelector('[data-act="always"]');
      if (onceBtn && !onceBtn.disabled) onceBtn.addEventListener('click', () => close({ fmt: currentFmt(), persist: false }));
      if (alwaysBtn && !alwaysBtn.disabled) alwaysBtn.addEventListener('click', () => close({ fmt: currentFmt(), persist: true }));
    }

    render();
    document.body.appendChild(overlay);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(null); });
    document.addEventListener('keydown', onKey);
  });
}

// Outil manuel (Parametres) : devine le format a partir d'un echantillon colle a la main
// et l'enregistre. Reste disponible pour pre-configurer un circuit avant sa premiere
// session ou pour forcer une nouvelle detection, mais n'est PLUS le chemin principal —
// l'import reel (texte colle ou fichier charge sur Sessions actives) detecte desormais le
// format tout seul, voir autoDetectChronoTextIfNeeded() et handleChronoFile() ci-dessous.
export async function detectAndSaveChronoFormat(sourceId) {
  const area = document.getElementById(sourceId || 'chrono-raw');
  const msgId = document.getElementById('pref-chrono-detect-sample') ? 'msg-prefs' : 'msg-chrono';
  const raw = area?.value.trim();
  if (!raw) {
    showMsg(msgId, 'Colle un extrait de ton fichier avant de détecter le format.', 'err');
    return;
  }
  const lines = raw.split('\n').map((l) => l.replace(/\r$/, '')).filter((l) => l.trim() !== '');
  const fmt = computeDetectedFormat(lines);
  if (!fmt) {
    showMsg(msgId, 'Impossible de détecter un format sur ce contenu.', 'err');
    return;
  }
  await saveChronoImportFormat(fmt);
  reflectChronoFormatInSettingsForm(fmt);

  // Apercu directement dans Parametres (id 'pref-chrono-preview') quand on detecte depuis
  // l'echantillon colle ici ; repli sur l'ancien emplacement Sessions actives sinon.
  const previewTargetId = sourceId === 'pref-chrono-detect-sample' ? 'pref-chrono-preview' : 'chrono-preview';
  renderChronoPreview(sourceId, previewTargetId);
  showMsg(msgId, 'Format détecté et enregistré — vérifie le mapping et l’aperçu ci-dessus avant de sauvegarder.', 'ok');
}

// Detection automatique SILENCIEUSE au moment d'un import de texte reel (voir
// importChrono() plus bas) : si le format actuellement enregistre ne reconnait AUCUNE
// ligne valide sur ce contenu (signal fort d'un format etranger au format habituel), on
// devine et sauvegarde un nouveau mapping personnalise a la volee — l'organisateur n'a
// plus besoin de le pre-configurer dans Parametres. Ne touche JAMAIS a un format qui
// reconnait deja au moins une ligne, y compris un format corrige manuellement au prealable.
// Retourne true si un nouveau format a ete detecte et applique.
async function autoDetectChronoTextIfNeeded(rawText) {
  const lines = String(rawText || '').split('\n').map((l) => l.replace(/\r$/, '')).filter((l) => l.trim() !== '');
  if (!lines.length) return false;
  const { rows } = normalizeChronoText(lines.join('\n'));
  if (rows.some((r) => r.valid)) return false;
  const fmt = computeDetectedFormat(lines);
  if (!fmt) return false;
  // Le format devine doit REELLEMENT reconnaitre des lignes avant d'etre enregistre —
  // sinon on n'ecrase pas les preferences pour rien et on laisse la main a la fenetre de
  // correction du mapping (voir importChrono()).
  const trial = normalizeChronoText(lines.join('\n'), fmt).rows;
  if (!trial.some((r) => r.valid)) return false;
  await saveChronoImportFormat(fmt);
  reflectChronoFormatInSettingsForm(fmt);
  return true;
}

// --- Import des chronos (fichier Excel/CSV → texte) --------------------------------------

export function handleChronoFile(inputEl) {
  const file = inputEl.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = async function (e) {
    try {
      const data = new Uint8Array(e.target.result);
      const wb = XLSX.read(data, { type: 'array' });
      const sheet = wb.Sheets[wb.SheetNames[0]];
      const rawRows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true });

      // Extraction des lignes canoniques ';'-separees pour un format donne — factorisee
      // pour pouvoir etre rejouee une seconde fois si la detection automatique ci-dessous
      // devine un meilleur mapping.
      const extract = (f) => {
        const sectorsOn = !!state.prefs.sectors_enabled;
        const n = Number(state.prefs.sector_count || 3);
        const rows = f.customized && f.has_header ? rawRows.slice(1) : rawRows;
        const out = [];
        rows.forEach((row) => {
          if (!row || !row.length) return;
          if (!f.customized) {
            // Comportement historique inchangé (tolerance 3 ou 4 colonnes).
            if (row.length < 3) return;
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
            if (isNaN(parseInt(kart)) || isNaN(parseTime(time))) return;
            out.push(name + ';' + kart + ';' + lapIdx + ';' + time);
            return;
          }
          // Format personnalisé : mapping de colonnes explicite (Paramètres).
          const get = (colNum) => (row[colNum - 1] != null ? String(row[colNum - 1]).trim() : '');
          const name = get(f.col_name);
          const kart = get(f.col_kart);
          const lap = get(f.col_lap) || '1';
          const time = get(f.col_time);
          const sectorVals = sectorsOn ? (f.col_sectors || []).slice(0, n).map(get) : [];
          if (!name || !kart || !time) return;
          if (isNaN(parseInt(kart)) || isNaN(parseTime(time))) return;
          const parts = sectorsOn ? [name, kart, lap, ...sectorVals, time] : [name, kart, lap, time];
          out.push(parts.join(';'));
        });
        return out;
      };

      let fmt = getChronoImportFormat();
      let lines = extract(fmt);
      let autoNote = '';
      // Detection automatique SILENCIEUSE : le format actuellement enregistre ne reconnait
      // AUCUNE ligne dans ce fichier (contenu non vide) — signal fort d'un format etranger.
      // On devine un nouveau mapping a partir du fichier lui-meme et on reessaie une fois.
      // Ne touche jamais a un format qui reconnait deja au moins une ligne.
      if (!lines.length && rawRows.some((r) => r && r.length)) {
        const detected = computeDetectedFormatFromRows(rawRows);
        if (detected) {
          const retryLines = extract(detected);
          if (retryLines.length) {
            await saveChronoImportFormat(detected);
            reflectChronoFormatInSettingsForm(detected);
            fmt = detected;
            lines = retryLines;
            autoNote = ' — format d’import différent détecté et enregistré automatiquement (vérifie/corrige le mapping dans Paramètres si besoin)';
          }
        }
      }

      // Toujours rien de reconnu, meme apres la detection auto : fenetre de correction du
      // mapping, alimentee par les colonnes reelles du fichier.
      if (!lines.length && rawRows.some((r) => r && r.length)) {
        const res = await openChronoMappingModal({ rawRows, suggested: computeDetectedFormatFromRows(rawRows) });
        if (!res) {
          document.getElementById('chrono-raw').value = '';
          showMsg('msg-chrono', 'Import annulé — le format du fichier n’a pas été reconnu.', 'err');
          return;
        }
        if (res.persist) {
          await saveChronoImportFormat(res.fmt);
          reflectChronoFormatInSettingsForm(res.fmt);
        }
        lines = extract(res.fmt);
        autoNote = res.persist
          ? ' — mapping corrigé et enregistré dans les Paramètres'
          : ' — mapping corrigé pour cet import';
      }

      document.getElementById('chrono-raw').value = lines.join('\n');
      renderChronoPreview();
      if (lines.length) {
        showMsg('msg-chrono', 'Fichier chargé' + autoNote + '. Vérifie l’aperçu ci-dessous puis clique Importer.', 'ok');
      } else {
        showMsg('msg-chrono', 'Aucune ligne reconnue dans ce fichier — vérifie/corrige le mapping dans Paramètres.', 'err');
      }
    } catch (err) {
      showMsg('msg-chrono', 'Erreur lecture fichier: ' + err.message, 'err');
    }
  };
  reader.readAsArrayBuffer(file);
}

// Import unifié : detecte automatiquement le format si le texte colle ne correspond a
// rien de connu (voir autoDetectChronoTextIfNeeded), normalise le texte selon le format
// resultant (no-op si le format n'est pas personnalisé), puis bascule automatiquement
// selon state.prefs.sectors_enabled, comme l'original.
export async function importChrono() {
  const area = document.getElementById('chrono-raw');
  const raw = area?.value || '';
  if (!raw.trim()) {
    showMsg('msg-chrono', 'Colle les temps.', 'err');
    return;
  }
  const autoDetected = await autoDetectChronoTextIfNeeded(raw);

  // Toujours aucune ligne exploitable apres la detection auto : on ne lance pas un import
  // voue a l'echec, on ouvre la fenetre de correction du mapping. L'organisateur corrige,
  // le texte est converti au format canonique, et il relance l'import depuis cet ecran.
  if (!normalizeChronoText(raw).rows.some((r) => r.valid)) {
    const lines = raw.split('\n').map((l) => l.replace(/\r$/, '')).filter((l) => l.trim() !== '');
    const res = await openChronoMappingModal({ lines, suggested: computeDetectedFormat(lines) });
    if (!res) {
      showMsg('msg-chrono', 'Import annulé — le format du fichier n’a pas été reconnu.', 'err');
      return;
    }
    if (res.persist) {
      await saveChronoImportFormat(res.fmt);
      reflectChronoFormatInSettingsForm(res.fmt);
    }
    // Conversion au format canonique avec le mapping choisi : le texte devient lisible par
    // l'import standard, que le mapping ait ete enregistre durablement ou non.
    const { text } = normalizeChronoText(raw, res.fmt);
    if (area && text) area.value = text;
    showMsg('msg-chrono', 'Mapping appliqué' + (res.persist ? ' et enregistré dans les Paramètres' : ' pour cet import') + ' — clique « Importer le texte » pour lancer l’import.', 'ok');
    return;
  }

  normalizeChronoRawTextarea();
  if (state.prefs.sectors_enabled) return importChronoWithSectors(autoDetected);
  return importChronoSimple(autoDetected);
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

// Import "sans secteurs" : format Nom;Kart;Tour;Temps. Reste exportée car
// importChrono() y délègue quand state.prefs.sectors_enabled est désactivé.
// autoDetected (optionnel) : true si importChrono() a du deviner le format a la volee pour
// ce texte — ajoute une note au message final pour que l'organisateur le sache et puisse
// verifier/corriger le mapping dans Paramètres si besoin.
export async function importChronoSimple(autoDetected) {
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
    // parseTime (et non parseFloat) : gere la decimale virgule et le format mm:ss.mmm,
    // comme la branche "secteurs activés" le faisait deja.
    const time = parseTime(timeStr);
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
  showMsg('msg-chrono', imported + ' temps importes' + (errors.length ? ' - ' + errors.length + ' erreurs' : '') + (autoDetected ? ' — format d’import détecté et enregistré automatiquement (vérifie/corrige dans Paramètres si besoin)' : ''), 'ok');
  await loadInscrits();
  await refreshOccupation();
  await renderResultatsSection();
}

// Variante "secteurs activés" — format attendu : Nom;Kart;NumTour;S1;S2;...;Sn;Temps
// autoDetected (optionnel) : voir importChronoSimple() ci-dessus.
async function importChronoWithSectors(autoDetected) {
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
    showMsg('msg-chrono', rows.length + ' tours importés' + (errors.length ? ' — ' + errors.length + ' lignes ignorées' : '') + (autoDetected ? ' — format d’import détecté et enregistré automatiquement (vérifie/corrige dans Paramètres si besoin)' : ''), 'ok');
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
    let pdfError = null;
    try {
      pdfReport = await generateSessionPDFs(sess, (done, total, label) => {
        showMsg(msgId, 'Generation des PDF ' + done + '/' + total + ' (' + label + ')...', 'ok');
      });
    } catch (e) {
      // Rendu impossible (iframe bloquee, page publique en erreur) : on
      // continue quand meme. Le pilote recevra le lien vers le classement en
      // ligne, ce qui est l'essentiel. Repli sur le rendu admin du classement.
      // 02/08 — PLUS DE CLASSEMENT DE REPLI. buildSessionPDF() est le rendu
      // interne de l'admin : mise en page differente, sans le theme ni les
      // avatars du circuit. Le televerser sous kind:'full_pdf' ecrasait le vrai
      // classement et c'est CE document que recevaient les pilotes — signale par
      // le client le 02/08 ("ce n'est pas du tout le bon PDF"). Mieux vaut aucun
      // classement qu'un mauvais : l'echec est desormais visible dans le bandeau
      // de verification, ou l'admin peut relancer.
      console.warn('[publication] generation des PDF publics :', e.message || e);
      pdfError = e.message || String(e);
    }

    // 2. La file d'envoi, une fois les pieces jointes deposees.
    const enq = await db.rpc('enqueue_position_cards', { _session_id: sess.id });
    if (enq.error) throw enq.error;

    // 3. Envoi immediat ; le cron de rattrapage reprend les echecs.
    const res = await triggerResultEmails();
    const suffix = pdfReport
      ? ' (' + pdfReport.pilots + ' fiche(s)' +
        (pdfReport.positionCards ? ', ' + pdfReport.positionCards + ' carte(s) position' : '') +
        (pdfReport.recordCards ? ', ' + pdfReport.recordCards + ' carte(s) record' : '') +
        (pdfReport.failed || pdfReport.cardsFailed
          ? ', ' + (pdfReport.failed + pdfReport.cardsFailed) + ' en echec'
          : '') + ')'
      : (pdfError ? ' (rendu des PDF en echec : ' + pdfError + ')' : '');
    if (res && typeof res.sent === 'number') {
      showMsg(msgId, 'Resultats publies — ' + res.sent + ' e-mail(s) envoye(s)' + suffix + '.', 'ok');
    } else {
      showMsg(msgId, 'Resultats publies' + suffix + ' — envoi en cours.', 'ok');
    }
  } catch (e) {
    showMsg(msgId, 'Publie, mais envoi des e-mails a reprendre : ' + (e.message || e), 'err');
  } finally {
    // Quoi qu'il arrive, on montre l'etat reel : c'est justement quand la chaine
    // casse au milieu que l'admin a besoin de voir ce qui est parti (point 2.1).
    refreshPublishVerify().catch(() => {});
  }
}

// --- Point 2.1 (voie 1) : bandeau de verification post-publication ----------------------
// Publier declenche une chaine longue et partiellement asynchrone : rendu des PDF dans CE
// navigateur, depot dans session-exports, mise en file (card_deliveries), puis envoi par
// l'Edge Function. Jusqu'ici le seul retour etait un .msg qui disparait au bout de 5 s :
// une fois efface, plus aucun moyen de savoir si la publication etait vraiment complete.
// Ce bandeau persiste sous le classement, relit l'etat REEL en base (jamais un compteur
// garde en memoire) et se rafraichit a la demande via le bouton "Reverifier".

const PV_KINDS = [
  { kind: 'full_pdf', label: 'Classement complet' },
  { kind: 'pilot_pdf', label: 'Fiches pilote' },
  { kind: 'position_card', label: 'Cartes position' },
  { kind: 'record_card', label: 'Cartes record' },
];

const PV_TONES = {
  ok: { c: 'var(--grn)', bg: 'rgba(51,209,122,.12)', b: 'rgba(51,209,122,.3)' },
  warn: { c: 'var(--yel)', bg: 'rgba(255,204,51,.13)', b: 'rgba(255,204,51,.32)' },
  err: { c: 'var(--red)', bg: 'rgba(255,77,77,.12)', b: 'rgba(255,77,77,.3)' },
  mut: { c: 'var(--mut)', bg: 'var(--surf2)', b: 'var(--bord)' },
};

function pvPill(tone, text) {
  const t = PV_TONES[tone] || PV_TONES.mut;
  return (
    '<span style="display:inline-flex;align-items:center;gap:5px;font-size:11.5px;font-weight:700;' +
    'border-radius:99px;padding:3px 10px;white-space:nowrap;color:' + t.c + ';background:' + t.bg +
    ';border:1px solid ' + t.b + '">' + text + '</span>'
  );
}

function pvRow(label, pill, hint) {
  return (
    '<div style="display:flex;align-items:center;justify-content:space-between;gap:12px;padding:8px 0;border-bottom:1px solid var(--bord-soft)">' +
    '<div><div style="font-size:13px;font-weight:600">' + label + '</div>' +
    (hint ? '<div style="font-size:11px;color:var(--mut);margin-top:2px">' + hint + '</div>' : '') +
    '</div>' + pill + '</div>'
  );
}

// Rafraichit le bandeau de verification. scope === 'arch' : fiche archive
// (state.archiveSession) ; sinon session active (state.activeDetailSession). Le bandeau
// existe dans les DEUX vues : publier bascule la session en 'results_published', elle
// quitte donc aussitot la liste des sessions actives et le seul endroit ou l'admin peut
// revenir verifier son envoi plus tard, c'est l'archive.
// Silencieux si la carte n'est pas dans le DOM (page publique, autre onglet) — le module
// est charge partout.
export async function refreshPublishVerify(scope) {
  const arch = scope === 'arch';
  const card = document.getElementById(arch ? 'arch-publish-verify' : 'publish-verify');
  const body = document.getElementById(arch ? 'arch-pv-body' : 'pv-body');
  if (!card || !body) return;
  const sess = arch ? state.archiveSession : state.activeDetailSession;
  if (!sess) {
    card.style.display = 'none';
    return;
  }

  const [assetsRes, delivRes, regsRes, sessRes] = await Promise.all([
    db.from('session_assets').select('kind').eq('session_id', sess.id),
    db.from('card_deliveries').select('status,registration_id,sent_at,last_error').eq('session_id', sess.id),
    db.from('session_registrations').select('id,display_name,email').eq('session_id', sess.id),
    db.from('sessions').select('status,results_published_at,public_results_token').eq('id', sess.id).maybeSingle(),
  ]);

  const row = (sessRes && sessRes.data) || {};
  const published = row.status === 'results_published';
  if (!published && !(assetsRes.data || []).length) {
    card.style.display = 'none';
    return;
  }
  card.style.display = '';

  // Etat de la session elle-meme : c'est la seule chose qui rend les resultats visibles.
  const when = row.results_published_at ? new Date(row.results_published_at) : null;
  const hhmm = when
    ? String(when.getHours()).padStart(2, '0') + ':' + String(when.getMinutes()).padStart(2, '0')
    : null;
  let html = pvRow(
    'Resultats en ligne',
    published ? pvPill('ok', hhmm ? 'Publie a ' + hhmm : 'Publie') : pvPill('err', 'Non publie'),
    published ? 'Visible par tout pilote ayant le lien ou le QR.' : 'Les pilotes ne voient encore rien.'
  );

  // Pieces jointes reellement deposees, par type.
  const byKind = {};
  (assetsRes.data || []).forEach((a) => {
    byKind[a.kind] = (byKind[a.kind] || 0) + 1;
  });
  // Destinataires attendus : un e-mail renseigne = une fiche pilote attendue.
  const recipients = (regsRes.data || []).filter((r) => r.email && r.email.trim()).length;

  PV_KINDS.forEach((k) => {
    const n = byKind[k.kind] || 0;
    if (k.kind === 'full_pdf') {
      html += pvRow(k.label, n ? pvPill('ok', 'Genere') : pvPill('warn', 'Absent'),
        n ? null : 'Republie pour le regenerer.');
    } else if (k.kind === 'pilot_pdf') {
      const tone = !recipients ? 'mut' : n >= recipients ? 'ok' : n ? 'warn' : 'err';
      html += pvRow(k.label, pvPill(tone, n + ' / ' + recipients),
        recipients ? 'Une fiche par pilote ayant laisse un e-mail.' : 'Aucun e-mail collecte sur cette session.');
    } else {
      html += pvRow(k.label, n ? pvPill('ok', String(n)) : pvPill('mut', 'Aucune'), null);
    }
  });

  // File d'envoi : c'est elle qui dit si les e-mails sont vraiment partis.
  const st = {};
  (delivRes.data || []).forEach((d) => {
    st[d.status] = (st[d.status] || 0) + 1;
  });
  const sent = st.sent || 0;
  const failed = st.failed || st.error || 0;
  const pending = (st.pending || 0) + (st.queued || 0) + (st.claimed || 0);
  const total = sent + failed + pending;
  let mailTone = 'mut';
  let mailTxt = 'Rien en file';
  if (total) {
    if (failed) {
      mailTone = 'err';
      mailTxt = sent + ' envoye(s), ' + failed + ' en echec';
    } else if (pending) {
      mailTone = 'warn';
      mailTxt = sent + ' / ' + total + ' envoye(s)';
    } else {
      mailTone = 'ok';
      mailTxt = sent + ' envoye(s)';
    }
  }
  html += pvRow('E-mails aux pilotes', pvPill(mailTone, mailTxt),
    pending ? 'Le rattrapage automatique repasse toutes les 5 minutes.'
      : failed ? 'Republie la session pour relancer les envois en echec.'
        : total ? null : 'Aucun destinataire, ou file non encore creee.');

  // Le lien public : la verification ultime, c'est de l'ouvrir soi-meme.
  const sc = arch ? ",'arch'" : '';

  // Detail par pilote : le compteur global ci-dessus dit "3 en echec", il ne dit pas
  // LESQUELS. Ici une ligne par destinataire, son etat reel relu dans card_deliveries,
  // et un bouton pour relancer ce pilote seul (RPC resend_pilot_results).
  const byReg = new Map();
  (delivRes.data || []).forEach((d) => {
    if (!d.registration_id) return;
    const arr = byReg.get(d.registration_id) || [];
    arr.push(d);
    byReg.set(d.registration_id, arr);
  });
  const dest = (regsRes.data || []).filter((r) => (r.email || '').trim().length > 3);
  if (dest.length) {
    let list = '';
    dest.forEach((r) => {
      const lines = byReg.get(r.id) || [];
      let tone = 'mut';
      let txt = 'Non planifie';
      let hint = escapeHTML(r.email);
      if (lines.length) {
        const bad = lines.filter((d) => d.status === 'failed' || d.status === 'error');
        const wait = lines.filter((d) => ['pending', 'queued', 'claimed', 'sending'].indexOf(d.status) >= 0);
        if (bad.length) {
          tone = 'err';
          txt = 'Echec';
          const err = (bad.find((d) => d.last_error) || {}).last_error;
          if (err) hint += ' — ' + escapeHTML(String(err).slice(0, 120));
        } else if (wait.length) {
          tone = 'warn';
          txt = 'En attente';
        } else {
          tone = 'ok';
          txt = 'Envoye';
          const times = lines.map((d) => d.sent_at).filter(Boolean).sort();
          const last = times.length ? new Date(times[times.length - 1]) : null;
          if (last && !isNaN(last.getTime())) {
            hint += ' — ' + String(last.getHours()).padStart(2, '0') + ':' +
              String(last.getMinutes()).padStart(2, '0');
          }
        }
      }
      const btn = '<button class="btn btn-ghost btn-sm" onclick="resendPilot(this,\'' +
        escapeHTML(r.id) + '\'' + sc + ')">Renvoyer</button>';
      const name = escapeHTML((r.display_name || '').trim() || r.email);
      list += pvRow(name, pvPill(tone, txt) + '<span style="margin-left:8px">' + btn + '</span>', hint);
    });
    html += '<div style="margin-top:12px">';
    if (dest.length > 12) {
      html += '<details><summary style="cursor:pointer;font-size:12px;font-weight:600;color:var(--mut);padding:4px 0">' +
        'Detail par pilote (' + dest.length + ')</summary><div style="margin-top:6px">' + list + '</div></details>';
    } else {
      html += '<div style="font-size:12px;font-weight:600;color:var(--mut);padding:4px 0">Detail par pilote (' +
        dest.length + ')</div>' + list;
    }
    html += '</div>';
  }
  if (published && row.public_results_token) {
    // 03/08 : URL propre /results et non /results.html — Cloudflare Pages repond 308 sur
    // la forme .html, ce qui ajoutait un aller-retour a chaque ouverture et faisait
    // apparaitre une URL differente de celle affichee dans la barre d'adresse.
    const url = APP_CONFIG.baseUrl + '/results?result=' + row.public_results_token;
    html +=
      '<div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-top:12px">' +
      '<a class="btn btn-ghost btn-sm" href="' + url + '" target="_blank" rel="noopener">Ouvrir la page publique</a>' +
      '<button class="btn btn-ghost btn-sm" onclick="verifyPublication(this' + sc + ')">Reverifier</button>' +
      '</div>';
  } else {
    html +=
      '<div style="margin-top:12px"><button class="btn btn-ghost btn-sm" onclick="verifyPublication(this' + sc + ')">Reverifier</button></div>';
  }
  body.innerHTML = html;
}

// Bouton "Reverifier" : meme lecture, avec un retour visuel pendant l'aller-retour.
export async function verifyPublication(btn, scope) {
  const original = btn ? btn.innerHTML : null;
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = 'Verification...';
  }
  try {
    await refreshPublishVerify(scope);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = original;
    }
  }
}

// Bouton "Renvoyer" d'une ligne pilote : la RPC remet ses lignes card_deliveries en
// 'pending' (ou en cree une si le pilote n'en avait aucune), puis on redeclenche l'envoi
// tout de suite plutot que d'attendre le cron de rattrapage, et on relit le bandeau.
export async function resendPilot(btn, registrationId, scope) {
  const original = btn ? btn.innerHTML : null;
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = 'Envoi...';
  }
  try {
    const r = await db.rpc('resend_pilot_results', { _registration_id: registrationId });
    if (r && r.error) throw r.error;
    await triggerResultEmails();
    await refreshPublishVerify(scope);
  } catch (e) {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = original;
    }
    showMsg(scope === 'arch' ? 'msg-arch' : 'msg-res', 'Renvoi impossible : ' + (e.message || e), 'err');
  }
}

// 02/08 (client) : "Enleve aussi les QR code Resultats". updateQRRes() ecrivait dans
// #qr-res-wrap, disparu de admin.html le 31/07 avec le passage au QR permanent du
// circuit : le code etait deja mort. Supprime, ainsi que zoomQR()/closeZoom() et le
// QR de la fiche archive. Le lien resultats reste accessible via "Copier lien".

export function copyLink(type) {
  let url;
  // 03/08 — deux corrections d'un coup (voir docs/ARCHITECTURE-URL.md) :
  //  a) URL propres (/register, /results) : la forme .html declenche un 308 Cloudflare.
  //  b) le cache-buster s'appelait `v`... qui est DEJA le parametre du jeton de circuit
  //     lu par public-results.js (`params.get('v') || params.get('venue')`). Aucun degat
  //     visible jusqu'ici parce que `result` est teste en premier, mais deux parametres
  //     homonymes dans le meme espace d'URL est une bombe a retardement. Renomme `_r`.
  if (type === 'reg' && state.activeDetailSession) url = APP_CONFIG.baseUrl + '/register?session=' + state.activeDetailSession.public_registration_token;
  if (type === 'res' && isSessionPublished(state.activeDetailSession) && state.activeDetailSession.public_results_token)
    url = APP_CONFIG.baseUrl + '/results?result=' + state.activeDetailSession.public_results_token + '&_r=' + Date.now();
  if (!url) {
    showMsg('msg-res', 'Lien indisponible.', 'err');
    return;
  }
  navigator.clipboard.writeText(url);
  showMsg(type === 'reg' ? 'msg-ins' : 'msg-res', 'Lien copie !', 'ok');
}


// 03/08 (client) : mode presentation supprime. Il affichait en plein ecran un QR
// vers la page publique de CETTE session, alors que le circuit affiche depuis le
// 31/07 un QR permanent unique. Deux QR visibles en meme temps, c'est la garantie
// qu'un pilote scanne le mauvais. togglePres()/archTogglePres() et l'overlay
// #pres-overlay d'admin.html sont donc retires.
// MAJ 03/08 : le dernier appelant de qrSrc() (updateQRReg() dans sessions.js,
// deja mort a ce moment) a lui aussi ete retire — qrSrc() n'a plus d'appelant
// dans le code. Elle reste definie dans ui.js si un futur QR ad hoc en a besoin.

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
  if (typeEl) typeEl.value = s.session_type || defaultSessionType();
  const notesEl = document.getElementById('arch-notes-input');
  if (notesEl) notesEl.value = s.internal_notes || '';
  // 30/07 : Classement / Inscrits / Imports chrono passent en Premium (flag
  // 'archive_detail', voir plan.js) -- notes internes, republier/copier le lien et la
  // liste des archives restent Basique (non touches ici). Meme principe que les autres
  // gatings : le verrou est verifie AVANT tout calcul/fetch, ces trois blocs ne sont donc
  // ni charges ni deposes dans le DOM pour un compte Basique.
  const detailAllowed = await hasFeature('archive_detail');
  if (detailAllowed) {
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
    await loadArchiveChronoImports(id);
  } else {
    // "Statistiques de la session" (arch-stats-card) derive du meme classement que
    // Classement/Inscrits -- on la masque aussi plutot que de laisser un ancien contenu
    // (potentiellement d'une autre archive consultee juste avant) affiche par erreur.
    const statsCard = document.getElementById('arch-stats-card');
    if (statsCard) statsCard.style.display = 'none';
    renderPremiumLock('arch-ranking');
    renderPremiumLock('arch-inscrits');
    renderPremiumLock('arch-chrono-imports');
  }
  await refreshArchiveExportButtons();
  // Bandeau de verification (point 2.1) : c'est ici que l'admin revient des heures plus
  // tard, la session ayant quitte la liste des actives au moment de la publication.
  refreshPublishVerify('arch').catch(() => {});
}

// Boutons "Exporter CSV" / "Exporter PDF" de la fiche archive individuelle -- flag
// 'archive_export' (voir plan.js). Ne concerne pas l'export GLOBAL CSV/XLSX de la liste
// des archives (archives-export.js), qui reste Basique.
async function refreshArchiveExportButtons() {
  const allowed = await hasFeature('archive_export');
  ['btn-csv-archive', 'btn-pdf-archive'].forEach((id) => {
    const btn = document.getElementById(id);
    if (!btn) return;
    btn.disabled = !allowed;
    btn.title = allowed ? '' : 'Reserve au plan Premium';
    btn.style.opacity = allowed ? '' : '0.5';
    btn.style.cursor = allowed ? '' : 'not-allowed';
  });
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
  const sessionType = document.getElementById('arch-type-input')?.value || defaultSessionType();
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
  state.archiveSession.status = 'results_published';
  if (!already) state.archiveSession.results_published_at = new Date().toISOString();
  showMsg('msg-arch', already ? 'Publication relancee...' : 'Resultats publies !', 'ok');
  // 03/08 — « Relancer la publication » rejoue TOUTE la chaine, y compris sur une
  // session deja publiee. Avant, seule une premiere publication appelait
  // afterPublish() : un PDF rate ou un e-mail bloque ne se reparait donc par aucun
  // bouton. Rejouer est sans risque de double envoi, verifie dans le code :
  //   - generateSessionPDFs() reversene les assets en upsert (meme chemin, meme
  //     ligne session_assets) : ce qui manque est regenere, le reste remplace ;
  //   - enqueue_position_cards fait un `on conflict do nothing` sur l'index unique
  //     (registration_id, kind, scope) : aucune ligne de file dupliquee ;
  //   - claim_card_deliveries ne prend que les lignes `pending` : une ligne deja
  //     'sent' n'est jamais reprise, donc personne ne recoit deux fois le meme
  //     e-mail. Seuls les envois jamais partis (ou repasses 'pending' apres echec)
  //     redemarrent.
  await afterPublish(state.archiveSession, 'msg-arch');
  await refreshPublishVerify('arch');
}

export function archCopyLink() {
  if (!isSessionPublished(state.archiveSession) || !state.archiveSession.public_results_token) {
    showMsg('msg-arch', "Publie d'abord.", 'err');
    return;
  }
  // 03/08 : idem copyLink — URL propre et cache-buster renomme `_r` (cf. collision sur `v`).
  navigator.clipboard.writeText(APP_CONFIG.baseUrl + '/results?result=' + state.archiveSession.public_results_token + '&_r=' + Date.now());
  showMsg('msg-arch', 'Lien copie !', 'ok');
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

// Retire le 01/08 (demande client) : la saisie manuelle "1 tour par kart" faisait
// doublon avec l'import texte/fichier ci-dessus, qui couvre deja ce cas.

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

// 03/08 — « Exporter PDF » telecharge desormais le fichier REELLEMENT stocke.
// Il appelait buildSessionPDF(), le rendu interne de l'admin : sans theme du
// circuit ni avatars, il ne ressemblait pas au classement recu par les pilotes,
// et c'est ce document-la qui avait ete signale comme « pas du tout le bon PDF »
// le 02/08. On lit maintenant l'asset session_assets kind='full_pdf' depose a la
// publication, exactement celui que l'Edge Function joint aux e-mails.
// Volontairement SANS repli sur buildSessionPDF si l'asset manque (decision du
// 02/08 : mieux vaut aucun PDF qu'un mauvais) — l'admin est renvoye vers une
// relance de publication, qui regenere l'asset.
export async function exportSessionPDF(sess, btn, scope) {
  const msgId = scope === 'arch' ? 'msg-arch' : 'msg-res';
  const s = sess;
  if (!s) {
    showMsg(msgId, 'Aucune session.', 'err');
    return;
  }
  const original = btn ? btn.innerHTML : null;
  if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spin"></span>Export...'; }
  try {
    const { data: asset, error } = await db
      .from('session_assets')
      .select('storage_path')
      .eq('session_id', s.id)
      .eq('kind', 'full_pdf')
      .maybeSingle();
    if (error) throw error;
    if (!asset || !asset.storage_path) {
      showMsg(msgId, 'Aucun classement PDF genere pour cette session - relance la publication.', 'err');
    } else {
      // Meme bucket prive que le televersement (publish-exports.js) : on telecharge
      // le binaire plutot que d'exposer une URL signee dans la page.
      const dl = await db.storage.from(SESSION_EXPORTS_BUCKET).download(asset.storage_path);
      if (dl.error) throw dl.error;
      const url = URL.createObjectURL(dl.data);
      const a = document.createElement('a');
      a.href = url;
      a.download = (s.title || 'session').replace(/[^a-z0-9]/gi, '_') + '-classement.pdf';
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    }
  } catch (e) {
    showMsg(msgId, 'Erreur PDF: ' + (e.message || e), 'err');
  }
  if (btn) { btn.disabled = false; btn.innerHTML = original; }
}

// PLUS BRANCHEE SUR AUCUN BOUTON depuis le 03/08 : ni la publication (repli
// retire le 02/08), ni « Exporter PDF » (bascule sur l'asset full_pdf) ne
// l'appellent. Conservee comme brouillon interne : c'est le seul rendu de
// classement qui n'a besoin ni de la page publique ni du pont d'export, donc le
// seul utilisable si un jour l'admin doit sortir un document hors publication.
// Ne pas la rebrancher sur un bouton visible du client sans lui donner le theme
// et les avatars du circuit.
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
      '<div style="font-size:12px;color:#666;margin-top:4px">' + (s.session_date ? formatDate(s.session_date) : '') + (s.team_mode ? ' · Écurie' : (s.session_type ? ' · ' + sessionTypeLabel(s.session_type) : '')) + '</div>' +
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
