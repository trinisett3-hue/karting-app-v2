// Export des sessions archivees en CSV ou XLSX (onglet Archives).
//
// Pourquoi ici et pas dans Statistiques : Statistiques repond a « comment
// evolue mon activite » (agregats, graphes). Ici on veut la ligne brute,
// une session = une ligne, pour la recoller dans un tableur ou une compta.
// C'est un export d'archives, il reste dans Archives — et il respecte le
// filtre affiche a l'ecran, ce que l'utilisateur attend d'un bouton
// « Exporter » place juste au-dessus de la liste.
//
// Confidentialite : la RPC v25 ne renvoie aucun nom ni e-mail. Le fichier
// est statistique, il peut circuler sans risque RGPD.
import { db } from '../lib/supabase.js';
import { showMsg } from './ui.js';

// Colonnes du fichier, dans l'ordre. [entete, cle, transformation]
const COLS = [
  ['Date de la session',      (r) => fmtDate(r.session_date)],
  ['Heure de la session',     (r) => fmtTime(r.starts_at)],
  ['Nom de la session',       (r) => r.title || ''],
  ['Type',                    (r) => r.session_type || ''],
  ['Circuit',                 (r) => r.circuit_name || ''],
  ['Date de creation',        (r) => fmtDate(r.created_at)],
  ['Heure de creation',       (r) => fmtTime(r.created_at)],
  // Terminer une session EST l'archiver (confirmTerminerSession pose
  // archived_at) : une seule paire de colonnes, pas deux identiques.
  ['Date d\'archivage',       (r) => fmtDate(r.archived_at)],
  ['Heure d\'archivage',      (r) => fmtTime(r.archived_at)],
  ['Resultats publies le',    (r) => (r.results_published_at ? fmtDate(r.results_published_at) + ' ' + fmtTime(r.results_published_at) : '')],
  ['Statut',                  (r) => r.status || ''],
  ['Karts max',               (r) => num(r.max_karts)],
  ['Inscriptions',            (r) => num(r.inscriptions_count)],
  ['Participants (kart attribue)', (r) => num(r.participants_count)],
  ['Taux de remplissage %',   (r) => (r.max_karts ? Math.round((100 * (r.inscriptions_count || 0)) / r.max_karts) : '')],
  ['Pilotes identifies',      (r) => num(r.known_pilots_count)],
  ['Anonymes',                (r) => num(r.anonymous_count)],
  ['Avec e-mail',             (r) => num(r.with_email_count)],
  ['Pilotes chronometres',    (r) => num(r.racers_count)],
  ['Tours prevus',            (r) => num(r.laps_planned)],
  ['Tours enregistres',       (r) => num(r.laps_recorded)],
  ['Meilleur tour (s)',       (r) => sec(r.best_lap_seconds)],
  ['Tour moyen (s)',          (r) => sec(r.avg_lap_seconds)],
  ['Duree ouverte (min)',     (r) => durationMinutes(r)],
  ['Incidents',               (r) => num(r.incident_count)],
  ['Interruptions (min)',     (r) => num(r.interruption_minutes)],
  ['Note interne',            (r) => (r.has_internal_notes ? 'oui' : 'non')],
];

function fmtDate(v) {
  if (!v) return '';
  const d = new Date(v);
  if (isNaN(d)) return String(v);
  // Format ISO : trie correctement dans un tableur, sans ambiguite jour/mois.
  return d.toISOString().slice(0, 10);
}

function fmtTime(v) {
  if (!v) return '';
  const d = new Date(v);
  if (isNaN(d)) return '';
  return d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
}

function num(v) {
  return v == null ? '' : Number(v);
}

function sec(v) {
  return v == null ? '' : Number(Number(v).toFixed(3));
}

// De la creation a l'archivage : combien de temps la session a-t-elle vecu.
function durationMinutes(r) {
  const a = r.starts_at || r.created_at;
  if (!a || !r.archived_at) return '';
  const ms = new Date(r.archived_at) - new Date(a);
  if (isNaN(ms) || ms < 0) return '';
  return Math.round(ms / 60000);
}

let cache = null;

// On ne recharge la RPC que si necessaire : l'utilisateur clique souvent
// CSV puis XLSX pour comparer.
async function fetchRows(force) {
  if (cache && !force) return cache;
  const { data, error } = await db.rpc('admin_archived_sessions_export', {
    _from: null,
    _to: null,
  });
  if (error) throw error;
  cache = Array.isArray(data) ? data : [];
  return cache;
}

export function invalidateArchivesExportCache() {
  cache = null;
}

// Le filtre jour/type applique a l'ecran doit se retrouver dans le fichier :
// exporter autre chose que ce qui est affiche est le meilleur moyen de
// produire un fichier faux sans que personne ne le remarque.
function currentFilters() {
  const t = document.getElementById('arch-type-filter');
  const d = document.getElementById('arch-day-filter');
  return {
    type: t ? t.value : '',
    day: d ? d.value : '',
  };
}

function applyFilters(rows) {
  const f = currentFilters();
  return rows.filter((r) => {
    if (f.type && r.session_type !== f.type) return false;
    if (f.day && fmtDate(r.session_date || r.created_at) !== f.day) return false;
    return true;
  });
}

function matrix(rows) {
  return [COLS.map((c) => c[0])].concat(rows.map((r) => COLS.map((c) => c[1](r))));
}

function stamp() {
  const f = currentFilters();
  if (f.day) return f.day;
  return new Date().toISOString().slice(0, 10);
}

function csvCell(v) {
  const s = v == null ? '' : String(v);
  return /[";\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

export async function exportArchivesCSV() {
  try {
    const rows = applyFilters(await fetchRows());
    if (!rows.length) { showMsg('msg-arch-export', 'Aucune session a exporter avec ce filtre.', 'err'); return; }
    // Point-virgule + BOM : Excel francais ouvre le fichier correctement,
    // accents compris, sans passer par l'assistant d'importation.
    const csv = matrix(rows).map((line) => line.map(csvCell).join(';')).join('\r\n');
    download(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' }), 'sessions-archivees-' + stamp() + '.csv');
    showMsg('msg-arch-export', rows.length + ' session(s) exportee(s) en CSV.', 'ok');
  } catch (e) {
    showMsg('msg-arch-export', 'Export impossible : ' + (e.message || e), 'err');
  }
}

export async function exportArchivesXLSX() {
  if (typeof XLSX === 'undefined') {
    showMsg('msg-arch-export', 'Module XLSX indisponible. Utilise l\'export CSV.', 'err');
    return;
  }
  try {
    const rows = applyFilters(await fetchRows());
    if (!rows.length) { showMsg('msg-arch-export', 'Aucune session a exporter avec ce filtre.', 'err'); return; }
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet(matrix(rows));
    // Largeurs calees sur les entetes : sans ca toutes les colonnes
    // sortent a 8 caracteres et le fichier est illisible.
    ws['!cols'] = COLS.map((c) => ({ wch: Math.min(30, Math.max(11, c[0].length + 2)) }));
    ws['!freeze'] = { xSplit: 0, ySplit: 1 };
    XLSX.utils.book_append_sheet(wb, ws, 'Sessions archivees');
    XLSX.writeFile(wb, 'sessions-archivees-' + stamp() + '.xlsx');
    showMsg('msg-arch-export', rows.length + ' session(s) exportee(s) en XLSX.', 'ok');
  } catch (e) {
    showMsg('msg-arch-export', 'Export impossible : ' + (e.message || e), 'err');
  }
}

function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
