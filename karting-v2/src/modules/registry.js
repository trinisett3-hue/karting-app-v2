// Module Registre — onglet "Registre" : liste RGPD des clients (pilotes v14+ identifiés
// par pseudo + inscriptions "legacy" pré-v14 identifiées par email seul), avec suppression
// complète (hard delete, pas anonymisation — décision produit explicite, voir
// migration-v15-registre-stats-themes.sql section 3) et export CSV.
//
// Comme stats.js, aucun filtre tenant_id explicite ici : tenant_pilot_registry() est une
// RPC SECURITY DEFINER qui fait elle-même l'agrégation par tenant_users côté serveur (voir
// la migration) — le front ne fait que consommer ce qu'elle renvoie.
import { db } from '../lib/supabase.js';
import { formatDate, showMsg } from './ui.js';

let registryCache = [];

function escapeHTML(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function renderRegistryTable(rows) {
  const el = document.getElementById('registry-table');
  if (!el) return;
  if (!rows.length) {
    el.innerHTML = '<div class="empty">Aucun client enregistre.</div>';
    return;
  }
  el.innerHTML =
    '<table class="tbl"><thead><tr>' +
    '<th>Pseudo</th><th>Prenom</th><th>Nom</th><th>Email</th><th>Naissance</th>' +
    '<th>1ere course</th><th>Derniere course</th><th>Sessions</th><th>Action</th>' +
    '</tr></thead><tbody>' +
    rows
      .map((r) => {
        const pseudo = r.legacy ? '<span style="color:var(--mut)">(pre-v14)</span>' : escapeHTML(r.pseudo);
        const name = escapeHTML((r.first_name || '') + ' ' + (r.last_name || '') || '--');
        const actionBtn = r.legacy
          ? '<button class="btn btn-red btn-sm" onclick="confirmDeleteLegacy(\'' + r._registrationId + '\',\'' + escapeHTML(r.email).replace(/'/g, "\\'") + '\')">Supprimer</button>'
          : '<button class="btn btn-red btn-sm" onclick="confirmDeletePilot(\'' + r.pilot_id + '\',\'' + escapeHTML(r.pseudo).replace(/'/g, "\\'") + '\')">Supprimer</button>';
        return (
          '<tr>' +
          '<td>' + pseudo + '</td>' +
          '<td>' + escapeHTML(r.first_name) + '</td>' +
          '<td>' + escapeHTML(r.last_name) + '</td>' +
          '<td>' + escapeHTML(r.email) + '</td>' +
          '<td>' + (r.birth_date ? formatDate(r.birth_date) : '--') + '</td>' +
          '<td>' + (r.first_seen ? formatDate(r.first_seen) : '--') + '</td>' +
          '<td>' + (r.last_seen ? formatDate(r.last_seen) : '--') + '</td>' +
          '<td>' + (r.sessions_count || 0) + '</td>' +
          '<td>' + actionBtn + '</td>' +
          '</tr>'
        );
      })
      .join('') +
    '</tbody></table>';
}

export async function loadRegistryTab() {
  const el = document.getElementById('registry-table');
  if (el) el.innerHTML = '<div class="empty">Chargement...</div>';
  const searchEl = document.getElementById('reg-search');
  if (searchEl) searchEl.value = '';

  const { data, error } = await db.rpc('tenant_pilot_registry');
  if (error) {
    if (el) el.innerHTML = '<div class="empty">Erreur de chargement du registre.</div>';
    return;
  }
  // tenant_pilot_registry() ne renvoie pas d'identifiant de ligne pour les
  // inscriptions "legacy" (pas de pilot_id) : on va chercher l'id de la
  // dernière inscription concernée pour pouvoir cibler
  // delete_legacy_registration(_registration_id) précisément — la RPC de
  // suppression legacy attend UNE ligne, pas un email agrégé.
  const rows = data || [];
  const legacyEmails = rows.filter((r) => r.legacy).map((r) => r.email);
  let regByEmail = new Map();
  if (legacyEmails.length) {
    const { data: regs } = await db
      .from('session_registrations')
      .select('id,email')
      .is('pilot_id', null)
      .in('email', legacyEmails);
    (regs || []).forEach((r) => regByEmail.set(r.email, r.id));
  }
  registryCache = rows.map((r) => Object.assign({}, r, { _registrationId: regByEmail.get(r.email) || null }));
  renderRegistryTable(registryCache);
}

export function filterRegistry() {
  const q = (document.getElementById('reg-search')?.value || '').trim().toLowerCase();
  if (!q) {
    renderRegistryTable(registryCache);
    return;
  }
  const filtered = registryCache.filter((r) =>
    [r.pseudo, r.first_name, r.last_name, r.email].some((v) => (v || '').toLowerCase().includes(q))
  );
  renderRegistryTable(filtered);
}

export async function confirmDeletePilot(pilotId, pseudo) {
  const ok = window.confirm(
    'Supprimer definitivement ' + pseudo + ' et tout son historique de courses (y compris sur les autres circuits) ? Cette action est irreversible.'
  );
  if (!ok) return;
  const { error } = await db.rpc('delete_pilot_completely', { _pilot_id: pilotId });
  if (error) {
    showMsg('msg-registre', error.message || 'Erreur lors de la suppression.', 'err');
    return;
  }
  showMsg('msg-registre', pseudo + ' a ete supprime definitivement.', 'ok');
  await loadRegistryTab();
}

export async function confirmDeleteLegacy(registrationId, email) {
  if (!registrationId) {
    showMsg('msg-registre', 'Inscription introuvable.', 'err');
    return;
  }
  const ok = window.confirm(
    'Supprimer definitivement les donnees de ' + email + ' (inscription et historique de courses) ? Cette action est irreversible.'
  );
  if (!ok) return;
  const { error } = await db.rpc('delete_legacy_registration', { _registration_id: registrationId });
  if (error) {
    showMsg('msg-registre', error.message || 'Erreur lors de la suppression.', 'err');
    return;
  }
  showMsg('msg-registre', email + ' a ete supprime definitivement.', 'ok');
  await loadRegistryTab();
}

function csvCell(value) {
  const s = value == null ? '' : String(value);
  return /[;"\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

export function exportRegistryCSV() {
  const rows = [['Pseudo', 'Prenom', 'Nom', 'Email', 'Naissance', '1ere course', 'Derniere course', 'Sessions']];
  registryCache.forEach((r) => {
    rows.push([
      r.legacy ? '(pre-v14)' : r.pseudo,
      r.first_name || '',
      r.last_name || '',
      r.email || '',
      r.birth_date ? formatDate(r.birth_date) : '',
      r.first_seen ? formatDate(r.first_seen) : '',
      r.last_seen ? formatDate(r.last_seen) : '',
      r.sessions_count || 0,
    ]);
  });
  const csv = '﻿' + rows.map((r) => r.map(csvCell).join(';')).join('\r\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const today = new Date();
  const dateStr = today.getFullYear() + '-' + String(today.getMonth() + 1).padStart(2, '0') + '-' + String(today.getDate()).padStart(2, '0');
  const a = document.createElement('a');
  a.href = url;
  a.download = 'registre-clients-' + dateStr + '.csv';
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
