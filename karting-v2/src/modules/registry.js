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
import { NATS } from './countries.js';

let registryCache = [];
// 🆕 v18 : clef de la ligne actuellement en édition ('pilot:<id>' ou
// 'legacy:<registrationId>'), null si aucune — un seul éditeur ouvert à la
// fois, on re-render toute la table à chaque changement d'état pour rester
// simple (le registre n'est jamais assez long pour que ça coûte quoi que
// ce soit de perceptible).
let editingKey = null;

function escapeHTML(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function rowKey(r) {
  return r.legacy ? 'legacy:' + r._registrationId : 'pilot:' + r.pilot_id;
}

function natOptionsHTML(selected) {
  return NATS.map((n) => '<option value="' + n.code + '"' + (n.code === selected ? ' selected' : '') + '>' + n.flag + ' ' + n.label + '</option>').join('');
}

function natFlagLabel(code) {
  const n = NATS.find((x) => x.code === code);
  return n ? n.flag + ' ' + n.label : '--';
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
    '<th>Pseudo</th><th>Prenom</th><th>Nom</th><th>Email</th><th>Naissance</th><th>Nationalite</th>' +
    '<th>1ere course</th><th>Derniere course</th><th>Sessions</th><th>Actions</th>' +
    '</tr></thead><tbody>' +
    rows.map((r) => (rowKey(r) === editingKey ? editRowHTML(r) : displayRowHTML(r))).join('') +
    '</tbody></table>';
}

function displayRowHTML(r) {
  const key = rowKey(r);
  const pseudo = r.legacy ? '<span style="color:var(--mut)">(pre-v14)</span>' : escapeHTML(r.pseudo);
  const deleteBtn = r.legacy
    ? '<button class="btn btn-red btn-sm" onclick="confirmDeleteLegacy(\'' + r._registrationId + '\',\'' + escapeHTML(r.email).replace(/'/g, "\\'") + '\')">Supprimer</button>'
    : '<button class="btn btn-red btn-sm" onclick="confirmDeletePilot(\'' + r.pilot_id + '\',\'' + escapeHTML(r.pseudo).replace(/'/g, "\\'") + '\')">Supprimer</button>';
  // Les inscriptions legacy sans _registrationId identifie (email agrege sur
  // plusieurs lignes anciennes sans qu'on ait pu en cibler une seule) ne sont
  // ni modifiables ni supprimables individuellement — le bouton Modifier
  // n'apparait alors pas plutot que d'echouer silencieusement.
  const canEdit = !r.legacy || !!r._registrationId;
  const editBtn = canEdit
    ? '<button class="btn btn-ghost btn-sm" onclick="startEditRegistry(\'' + key + '\')">Modifier</button>'
    : '';
  return (
    '<tr>' +
    '<td>' + pseudo + '</td>' +
    '<td>' + escapeHTML(r.first_name) + '</td>' +
    '<td>' + escapeHTML(r.last_name) + '</td>' +
    '<td>' + escapeHTML(r.email) + '</td>' +
    '<td>' + (r.birth_date ? formatDate(r.birth_date) : '--') + '</td>' +
    '<td>' + natFlagLabel(r.nationality) + '</td>' +
    '<td>' + (r.first_seen ? formatDate(r.first_seen) : '--') + '</td>' +
    '<td>' + (r.last_seen ? formatDate(r.last_seen) : '--') + '</td>' +
    '<td>' + (r.sessions_count || 0) + '</td>' +
    '<td style="display:flex;gap:6px;flex-wrap:wrap">' + editBtn + deleteBtn + '</td>' +
    '</tr>'
  );
}

function editRowHTML(r) {
  const key = rowKey(r);
  const inp = (id, val, type) => '<input type="' + (type || 'text') + '" id="' + id + '" value="' + escapeHTML(val || '') + '" style="width:100%;min-width:90px;padding:6px 8px;font-size:12.5px;border-radius:6px;border:1px solid var(--bord);background:var(--bg);color:var(--txt)"/>';
  const pseudoCell = r.legacy
    ? '<span style="color:var(--mut)">(pre-v14)</span>'
    : inp('reg-edit-pseudo', r.pseudo);
  const birthCell = r.legacy
    ? '<span style="color:var(--mut)">--</span>'
    : inp('reg-edit-birth', r.birth_date || '', 'date');
  return (
    '<tr style="background:rgba(255,59,48,.05)">' +
    '<td>' + pseudoCell + '</td>' +
    '<td>' + inp('reg-edit-first', r.first_name) + '</td>' +
    '<td>' + inp('reg-edit-last', r.last_name) + '</td>' +
    '<td>' + inp('reg-edit-email', r.email, 'email') + '</td>' +
    '<td>' + birthCell + '</td>' +
    '<td><select id="reg-edit-nat" style="width:100%;min-width:110px;padding:6px 8px;font-size:12.5px;border-radius:6px;border:1px solid var(--bord);background:var(--bg);color:var(--txt)">' + natOptionsHTML(r.nationality) + '</select></td>' +
    '<td>' + (r.first_seen ? formatDate(r.first_seen) : '--') + '</td>' +
    '<td>' + (r.last_seen ? formatDate(r.last_seen) : '--') + '</td>' +
    '<td>' + (r.sessions_count || 0) + '</td>' +
    '<td style="display:flex;gap:6px;flex-wrap:wrap">' +
    '<button class="btn btn-primary btn-sm" onclick="saveRegistryEdit(\'' + key + '\')">Enregistrer</button>' +
    '<button class="btn btn-ghost btn-sm" onclick="cancelRegistryEdit()">Annuler</button>' +
    '</td>' +
    '</tr>'
  );
}

export function startEditRegistry(key) {
  editingKey = key;
  renderRegistryTable(registryCache);
}

export function cancelRegistryEdit() {
  editingKey = null;
  renderRegistryTable(registryCache);
}

export async function saveRegistryEdit(key) {
  const r = registryCache.find((x) => rowKey(x) === key);
  if (!r) return;
  const firstName = (document.getElementById('reg-edit-first')?.value || '').trim();
  const lastName = (document.getElementById('reg-edit-last')?.value || '').trim();
  const email = (document.getElementById('reg-edit-email')?.value || '').trim();
  const nationality = document.getElementById('reg-edit-nat')?.value || null;

  if (!firstName || !lastName) { showMsg('msg-registre', 'Prenom et nom obligatoires.', 'err'); return; }
  if (!email) { showMsg('msg-registre', 'Email obligatoire.', 'err'); return; }

  try {
    if (r.legacy) {
      const { error } = await db.rpc('update_legacy_registration_info', {
        _registration_id: r._registrationId,
        _first_name: firstName,
        _last_name: lastName,
        _email: email,
        _nationality: nationality,
      });
      if (error) throw error;
    } else {
      const pseudo = (document.getElementById('reg-edit-pseudo')?.value || '').trim();
      const birthDate = document.getElementById('reg-edit-birth')?.value || null;
      if (!pseudo) { showMsg('msg-registre', 'Pseudo obligatoire.', 'err'); return; }
      const { error } = await db.rpc('update_pilot_info', {
        _pilot_id: r.pilot_id,
        _first_name: firstName,
        _last_name: lastName,
        _email: email,
        _pseudo: pseudo,
        _birth_date: birthDate,
        _nationality: nationality,
      });
      if (error) throw error;
    }
    editingKey = null;
    showMsg('msg-registre', 'Informations mises a jour.', 'ok');
    await loadRegistryTab();
  } catch (e) {
    showMsg('msg-registre', e.message || 'Erreur lors de la mise a jour.', 'err');
  }
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
  const rows = [['Pseudo', 'Prenom', 'Nom', 'Email', 'Naissance', 'Nationalite', '1ere course', 'Derniere course', 'Sessions']];
  registryCache.forEach((r) => {
    rows.push([
      r.legacy ? '(pre-v14)' : r.pseudo,
      r.first_name || '',
      r.last_name || '',
      r.email || '',
      r.birth_date ? formatDate(r.birth_date) : '',
      natFlagLabel(r.nationality),
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
