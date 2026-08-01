// Module Registre — onglet "Registre" : liste RGPD des clients (pilotes v14+ identifiés
// par pseudo + inscriptions "legacy" pré-v14 identifiées par email seul), avec suppression
// complète (hard delete, pas anonymisation — décision produit explicite, voir
// migration-v15-registre-stats-themes.sql section 3) et export CSV.
//
// Comme stats.js, aucun filtre tenant_id explicite ici : tenant_pilot_registry() est une
// RPC SECURITY DEFINER qui fait elle-même l'agrégation par tenant_users côté serveur (voir
// la migration) — le front ne fait que consommer ce qu'elle renvoie.
import { db, fetchAll, fetchAllIn } from '../lib/supabase.js';
import { formatDate, showMsg, confirmModal } from './ui.js';
import { NATS } from './countries.js';
import { hasFeature } from './plan.js';

let registryCache = [];
// 🆕 v18 : clef de la ligne actuellement en édition ('pilot:<id>' ou
// 'legacy:<registrationId>'), null si aucune — un seul éditeur ouvert à la
// fois, on re-render toute la table à chaque changement d'état pour rester
// simple (le registre n'est jamais assez long pour que ça coûte quoi que
// ce soit de perceptible).
let editingKey = null;

// 🆕 v28 : pagination. `registryCache` = tout le registre (sert au compteur
// total, qui ne doit jamais bouger quand on filtre) ; `viewRows` = ce que la
// recherche laisse passer, c'est lui qu'on pagine. Séparer les deux est ce
// qui permet d'afficher « 12 résultats sur 73 clients » sans recharger.
const PAGE_SIZE = 20;
let viewRows = [];
let page = 1;
// 🆕 v29 : filtre "uniquement les clients ayant accepte les offres". Se
// combine avec la recherche texte plutot que de la remplacer.
let promoOnly = false;

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

// Point d'entrée unique du rendu : compteur + table + pagination sont
// toujours recalculés ensemble. Avant, `filterRegistry()` appelait
// directement `renderRegistryTable()`, si bien qu'ouvrir un éditeur alors
// qu'une recherche était active faisait réapparaître tout le registre.
function renderRegistry() {
  const total = registryCache.length;
  const shown = viewRows.length;
  const pages = Math.max(1, Math.ceil(shown / PAGE_SIZE));
  // Supprimer le dernier client d'une page peut rendre la page courante
  // inexistante : on se recale au lieu d'afficher une table vide.
  if (page > pages) page = pages;
  if (page < 1) page = 1;
  renderRegistryCount(total, shown);
  renderRegistryTable(viewRows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE));
  renderRegistryPager(shown, pages);
}

function renderRegistryCount(total, shown) {
  const el = document.getElementById('registry-total');
  if (!el) return;
  const s = total > 1 ? 's' : '';
  el.innerHTML =
    '<span class="reg-count-n">' + total + '</span>' +
    '<span class="reg-count-lbl">client' + s + ' enregistre' + s + '</span>' +
    (shown !== total
      ? '<span class="reg-count-filter">' + shown + ' affiche' + (shown > 1 ? 's' : '') + '</span>'
      : '');
}

// Fenêtre de numéros de page : au-delà de 7 pages on n'aligne pas 40 boutons,
// on garde les extrémités et le voisinage immédiat.
function pageNumbers(pages, current) {
  if (pages <= 7) {
    const all = [];
    for (let i = 1; i <= pages; i++) all.push(i);
    return all;
  }
  const out = [1];
  let a = Math.max(2, current - 1);
  let b = Math.min(pages - 1, current + 1);
  if (current <= 3) { a = 2; b = 4; }
  if (current >= pages - 2) { a = pages - 3; b = pages - 1; }
  if (a > 2) out.push('gap');
  for (let i = a; i <= b; i++) out.push(i);
  if (b < pages - 1) out.push('gap');
  out.push(pages);
  return out;
}

function renderRegistryPager(shown, pages) {
  const el = document.getElementById('registry-pager');
  if (!el) return;
  // Une seule page : pas de pagination affichée, elle n'apporterait rien.
  if (shown <= PAGE_SIZE) { el.innerHTML = ''; return; }
  const from = (page - 1) * PAGE_SIZE + 1;
  const to = Math.min(shown, page * PAGE_SIZE);
  el.innerHTML =
    '<div class="reg-pager-info">' + from + '–' + to + ' sur ' + shown + '</div>' +
    '<div class="reg-pager-btns">' +
    '<button class="btn btn-ghost btn-sm"' + (page === 1 ? ' disabled' : '') + ' onclick="gotoRegistryPage(' + (page - 1) + ')">Precedent</button>' +
    pageNumbers(pages, page)
      .map((p) => (p === 'gap'
        ? '<span class="reg-pager-gap">…</span>'
        : '<button class="btn btn-sm ' + (p === page ? 'btn-primary' : 'btn-ghost') + '" onclick="gotoRegistryPage(' + p + ')">' + p + '</button>'))
      .join('') +
    '<button class="btn btn-ghost btn-sm"' + (page === pages ? ' disabled' : '') + ' onclick="gotoRegistryPage(' + (page + 1) + ')">Suivant</button>' +
    '</div>';
}

export function gotoRegistryPage(p) {
  page = p;
  // Changer de page pendant une édition laisserait un formulaire ouvert sur
  // une ligne devenue invisible : on ferme l'éditeur.
  editingKey = null;
  renderRegistry();
  const el = document.getElementById('panel-registre');
  if (el && el.scrollIntoView) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function renderRegistryTable(rows) {
  const el = document.getElementById('registry-table');
  if (!el) return;
  if (!rows.length) {
    el.innerHTML = registryCache.length
      ? '<div class="empty">Aucun client ne correspond a cette recherche.</div>'
      : '<div class="empty">Aucun client enregistre.</div>';
    return;
  }
  el.innerHTML =
    '<table class="tbl"><thead><tr>' +
    '<th>Pseudo</th><th>Prenom</th><th>Nom</th><th>Email</th><th title="Consentement a recevoir les offres du circuit, donne par le pilote lui-meme a l\'inscription">Promo</th><th>Naissance</th><th>Nationalite</th>' +
    '<th>1ere course</th><th>Derniere course</th><th>Sessions</th><th>Actions</th>' +
    '</tr></thead><tbody>' +
    rows.map((r) => (rowKey(r) === editingKey ? editRowHTML(r) : displayRowHTML(r))).join('') +
    '</tbody></table>';
}

// 🆕 v29 : consentement marketing. La pastille est volontairement discrete
// quand la reponse est "non" — c'est l'etat par defaut de la grande majorite
// des lignes, la mettre en rouge donnerait l'impression d'une anomalie.
function promoBadgeHTML(r) {
  if (!r.promo_opt_in) {
    return '<span class="promo-badge promo-no" title="Ce client n\'a pas accepte de recevoir les offres du circuit">Non</span>';
  }
  const since = r.promo_opt_in_at ? formatDate(r.promo_opt_in_at) : null;
  return (
    '<span class="promo-badge promo-yes" title="Consentement donne par le client' +
    (since ? ' le ' + since : '') +
    '">Oui</span>'
  );
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
    '<td>' + promoBadgeHTML(r) + '</td>' +
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
  // 🆕 v29 : le consentement marketing n'est PAS un champ que l'admin remplit.
  // Il se donne uniquement par le pilote, sur la page d'inscription. Depuis le
  // registre on ne peut donc que le RETIRER (droit d'opposition, typiquement
  // apres un appel ou un mail du client) — jamais le cocher a sa place.
  const promoCell =
    promoBadgeHTML(r) +
    (r.promo_opt_in
      ? '<button class="btn btn-ghost btn-sm" style="margin-top:6px;display:block" onclick="withdrawPromoConsent(\'' + key + '\')">Retirer</button>'
      : '');
  return (
    '<tr style="background:rgba(255,59,48,.05)">' +
    '<td>' + pseudoCell + '</td>' +
    '<td>' + inp('reg-edit-first', r.first_name) + '</td>' +
    '<td>' + inp('reg-edit-last', r.last_name) + '</td>' +
    '<td>' + inp('reg-edit-email', r.email, 'email') + '</td>' +
    '<td>' + promoCell + '</td>' +
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
  renderRegistry();
}

export function cancelRegistryEdit() {
  editingKey = null;
  renderRegistry();
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
    // keepView : on revient sur la meme page et la meme recherche, sinon
    // corriger le 45e client renvoie l'admin en page 1 sans son filtre.
    await loadRegistryTab(true);
  } catch (e) {
    showMsg('msg-registre', e.message || 'Erreur lors de la mise a jour.', 'err');
  }
}

export async function loadRegistryTab(keepView) {
  const keep = keepView === true;
  const el = document.getElementById('registry-table');
  if (el) el.innerHTML = '<div class="empty">Chargement...</div>';
  const searchEl = document.getElementById('reg-search');
  if (searchEl && !keep) searchEl.value = '';
  if (!keep) page = 1;

  // P0-5 (audit 30/07) : la RPC renvoie un SETOF, donc PostgREST la plafonne aussi
  // a max_rows (1000). Au-dela de 1000 clients le registre se tronquait en silence.
  // (email, pilot_id) est unique : email seul suffit pour les lignes legacy
  // (agregees par email), pilot_id departage les pilotes identifies.
  const { data, error } = await fetchAll(() => db.rpc('tenant_pilot_registry'), {
    orderBy: ['email', 'pilot_id'],
  });
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
    const { data: regs } = await fetchAllIn(
      () => db.from('session_registrations').select('id,email').is('pilot_id', null),
      'email',
      legacyEmails
    );
    (regs || []).forEach((r) => regByEmail.set(r.email, r.id));
  }
  registryCache = rows.map((r) => Object.assign({}, r, { _registrationId: regByEmail.get(r.email) || null }));
  applySearch();
  renderRegistry();
  await refreshExportButtonState();
}

// 30/07 : le registre (total, pagination, recherche) reste Basique -- seul l'export CSV
// devient Premium (flag 'registry_export', voir plan.js). On desactive juste le bouton
// avec un titre explicite plutot que de le masquer : le reste de l'onglet Registre n'est
// pas touche.
async function refreshExportButtonState() {
  const btns = ['btn-registry-export', 'btn-registry-export-xlsx']
    .map((id) => document.getElementById(id))
    .filter(Boolean);
  if (!btns.length) return;
  const allowed = await hasFeature('registry_export');
  btns.forEach((btn) => {
    btn.disabled = !allowed;
    btn.title = allowed ? '' : 'Reserve au plan Premium';
    btn.style.opacity = allowed ? '' : '0.5';
    btn.style.cursor = allowed ? '' : 'not-allowed';
  });
}

// Recalcule `viewRows` depuis le champ de recherche. Isolé de
// `filterRegistry()` pour pouvoir être rejoué après un rechargement sans
// remettre la pagination à zéro.
function applySearch() {
  const q = (document.getElementById('reg-search')?.value || '').trim().toLowerCase();
  let rows = !q
    ? registryCache
    : registryCache.filter((r) =>
      [r.pseudo, r.first_name, r.last_name, r.email].some((v) => (v || '').toLowerCase().includes(q))
    );
  // 🆕 v29 : filtre "opt-in promo". Il agit sur `viewRows`, donc l'export
  // reprend exactement la liste filtree — c'est ce qui permet de sortir un
  // fichier de diffusion propre sans avoir a trier a la main derriere.
  if (promoOnly) rows = rows.filter((r) => !!r.promo_opt_in);
  viewRows = rows;
}

export function togglePromoFilter() {
  promoOnly = !promoOnly;
  const btn = document.getElementById('btn-registry-promo-filter');
  if (btn) {
    btn.classList.toggle('on', promoOnly);
    btn.setAttribute('aria-pressed', promoOnly ? 'true' : 'false');
  }
  page = 1;
  applySearch();
  renderRegistry();
}

export function filterRegistry() {
  // Taper dans la recherche doit ramener en page 1 : rester en page 4 d'un
  // résultat qui n'a plus qu'une page afficherait une table vide.
  page = 1;
  editingKey = null;
  applySearch();
  renderRegistry();
}

// 🆕 v29 : retrait du consentement marketing. Sens unique cote base aussi
// (withdraw_promo_consent ne sait que passer promo_opt_in a false), pour que
// personne ne puisse "reactiver" un consentement depuis l'admin.
export async function withdrawPromoConsent(key) {
  const r = registryCache.find((x) => rowKey(x) === key);
  if (!r) return;
  const who = r.legacy ? r.email : r.pseudo;
  const ok = await confirmModal({
    title: 'Retirer le consentement ?',
    message:
      who + ' ne recevra plus les offres du circuit. Ce retrait s\'applique à toutes ses inscriptions et ne peut pas être annulé depuis l\'admin : seul le pilote peut redonner son accord, en cochant la case sur la page d\'inscription.',
    confirmLabel: 'Retirer le consentement',
  });
  if (!ok) return;
  const { error } = await db.rpc('withdraw_promo_consent', {
    _pilot_id: r.legacy ? null : r.pilot_id,
    _email: r.legacy ? r.email : null,
  });
  if (error) {
    showMsg('msg-registre', error.message || 'Erreur lors du retrait du consentement.', 'err');
    return;
  }
  editingKey = null;
  showMsg('msg-registre', 'Consentement retire pour ' + who + '.', 'ok');
  await loadRegistryTab(true);
}

export async function confirmDeletePilot(pilotId, pseudo) {
  const ok = await confirmModal({
    title: 'Supprimer ce pilote ?',
    message: pseudo + ' et tout son historique de courses (y compris sur les autres circuits) seront supprimés définitivement.',
    confirmLabel: 'Supprimer définitivement',
  });
  if (!ok) return;
  const { error } = await db.rpc('delete_pilot_completely', { _pilot_id: pilotId });
  if (error) {
    showMsg('msg-registre', error.message || 'Erreur lors de la suppression.', 'err');
    return;
  }
  showMsg('msg-registre', pseudo + ' a ete supprime definitivement.', 'ok');
  await loadRegistryTab(true);
}

export async function confirmDeleteLegacy(registrationId, email) {
  if (!registrationId) {
    showMsg('msg-registre', 'Inscription introuvable.', 'err');
    return;
  }
  const ok = await confirmModal({
    title: 'Supprimer ces données ?',
    message: 'Inscription et historique de courses de ' + email + ' seront supprimés définitivement.',
    confirmLabel: 'Supprimer définitivement',
  });
  if (!ok) return;
  const { error } = await db.rpc('delete_legacy_registration', { _registration_id: registrationId });
  if (error) {
    showMsg('msg-registre', error.message || 'Erreur lors de la suppression.', 'err');
    return;
  }
  showMsg('msg-registre', email + ' a ete supprime definitivement.', 'ok');
  await loadRegistryTab(true);
}

function csvCell(value) {
  const s = value == null ? '' : String(value);
  return /[;"\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

// 🆕 v29 : une seule definition des colonnes pour le CSV et le XLSX. Avant, le
// tableau d'entetes vivait dans exportRegistryCSV() ; ajouter une colonne
// obligeait a la reporter a deux endroits, avec le risque classique d'un
// fichier dont les entetes ne correspondent plus aux donnees.
// 'Promo' est en Oui/Non (et non true/false) : c'est sur cette colonne que le
// circuit trie ou filtre dans Excel pour sortir sa liste de diffusion.
function registryMatrix(source) {
  const rows = [[
    'Pseudo', 'Prenom', 'Nom', 'Email', 'Promo', 'Promo depuis',
    'Naissance', 'Nationalite', '1ere course', 'Derniere course', 'Sessions',
  ]];
  source.forEach((r) => {
    rows.push([
      r.legacy ? '(pre-v14)' : r.pseudo,
      r.first_name || '',
      r.last_name || '',
      r.email || '',
      r.promo_opt_in ? 'Oui' : 'Non',
      r.promo_opt_in && r.promo_opt_in_at ? formatDate(r.promo_opt_in_at) : '',
      r.birth_date ? formatDate(r.birth_date) : '',
      natFlagLabel(r.nationality),
      r.first_seen ? formatDate(r.first_seen) : '',
      r.last_seen ? formatDate(r.last_seen) : '',
      r.sessions_count || 0,
    ]);
  });
  return rows;
}

function exportStamp() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

// 🆕 v29 : export XLSX du registre. Le CSV reste la pour les imports machine,
// mais c'est le XLSX qu'on ouvre dans Excel : entetes figees + filtre
// automatique, donc trier sur "Promo" se fait en deux clics sans manipulation.
export async function exportRegistryXLSX() {
  if (!(await hasFeature('registry_export'))) {
    showMsg('msg-registre', 'Export reserve au plan Premium.', 'err');
    return;
  }
  if (typeof XLSX === 'undefined') {
    showMsg('msg-registre', 'Module XLSX indisponible. Utilise l\'export CSV.', 'err');
    return;
  }
  const source = viewRows;
  if (!source.length) {
    showMsg('msg-registre', registryCache.length ? 'Aucun client ne correspond a cette recherche.' : 'Aucun client a exporter.', 'err');
    return;
  }
  try {
    const matrix = registryMatrix(source);
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet(matrix);
    ws['!cols'] = [
      { wch: 16 }, { wch: 14 }, { wch: 14 }, { wch: 28 }, { wch: 7 }, { wch: 13 },
      { wch: 12 }, { wch: 18 }, { wch: 13 }, { wch: 15 }, { wch: 9 },
    ];
    ws['!freeze'] = { xSplit: 0, ySplit: 1 };
    ws['!autofilter'] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: matrix.length - 1, c: matrix[0].length - 1 } }) };
    XLSX.utils.book_append_sheet(wb, ws, 'Registre clients');
    XLSX.writeFile(wb, 'registre-clients-' + exportStamp() + '.xlsx');
    showMsg('msg-registre', source.length + ' client(s) exporte(s) en XLSX.', 'ok');
  } catch (e) {
    showMsg('msg-registre', e.message || 'Erreur lors de l\'export XLSX.', 'err');
  }
}

export async function exportRegistryCSV() {
  // Flag 'registry_export' (voir plan.js) : le bouton est deja desactive cote UI pour un
  // compte Basique (refreshExportButtonState()), mais on revalide ici aussi -- au cas ou
  // l'appel viendrait d'ailleurs que du clic sur le bouton.
  if (!(await hasFeature('registry_export'))) {
    showMsg('msg-registre', 'Export CSV reserve au plan Premium.', 'err');
    return;
  }
  // On exporte ce qui est A L'ECRAN (recherche comprise), pas seulement la
  // page courante : exporter autre chose que ce que l'admin voit est le
  // meilleur moyen de produire un fichier faux sans que personne ne s'en
  // apercoive. Meme regle que l'export des archives.
  const source = viewRows;
  if (!source.length) {
    showMsg('msg-registre', registryCache.length ? 'Aucun client ne correspond a cette recherche.' : 'Aucun client a exporter.', 'err');
    return;
  }
  const rows = registryMatrix(source);
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
  showMsg('msg-registre', source.length + ' client(s) exporte(s) en CSV.', 'ok');
}
