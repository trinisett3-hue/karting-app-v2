// Module Sessions — création, liste, détail d'une session, inscriptions et attribution
// des karts. Repris fonction par fonction depuis l'ancien index.html (lignes 641-984 et
// 745-946 pour les karts), en gardant exactement la même logique et les mêmes requêtes
// Supabase. Volontairement regroupé avec les inscriptions/karts : dans l'app d'origine,
// une session, ses pilotes inscrits et ses karts forment un seul écran indissociable
// (l'onglet "Session active"), les séparer artificiellement aurait cassé ce couplage.
import { db } from '../lib/supabase.js';
import { state } from '../state.js';
import { showMsg, randomCode4, qrSrc, avatarColor, avatarInitial } from './ui.js';
import { APP_CONFIG } from '../config.js';

// --- Liste des sessions actives ---------------------------------------------------

export async function loadActiveSessions() {
  const { data } = await db
    .from('sessions')
    .select('*')
    .eq('status', 'registration_open')
    .is('archived_at', null)
    .order('created_at', { ascending: false });
  state.activeSessions = data || [];
  updateStatusDot();
  await renderActivesGrid();
}

export function updateStatusDot() {
  const dot = document.getElementById('status-dot');
  const txt = document.getElementById('status-txt');
  if (!dot || !txt) return;
  if (state.activeSessions.length) {
    dot.classList.add('on');
    txt.textContent = state.activeSessions.length + ' session(s) active(s)';
  } else {
    dot.classList.remove('on');
    txt.textContent = 'Aucune session';
  }
}

export async function renderActivesGrid() {
  const el = document.getElementById('actives-grid');
  if (!el) return;
  if (!state.activeSessions.length) {
    el.innerHTML = '<div class="empty">Aucune session active. Cree-en une dans l&rsquo;onglet Nouvelle session.</div>';
    return;
  }
  const cards = await Promise.all(
    state.activeSessions.map(async (s) => {
      const { data: regs } = await db.from('session_registrations').select('id,kart_number').eq('session_id', s.id);
      const inscrits = (regs || []).length;
      const occ = (regs || []).filter((r) => r.kart_number != null).length;
      const pub = s.public_results_token ? '<span class="sc-badge pub">Publie</span>' : '<span class="sc-badge">En cours</span>';
      return (
        '<div class="sess-card" onclick="openActiveDetail(\'' + s.id + '\')">' +
        '<div class="flex" style="justify-content:space-between">' + pub + '</div>' +
        '<h3>' + s.title + '</h3>' +
        '<div class="sc-meta">' + s.max_karts + ' karts max' + (s.laps_count ? ' - ' + s.laps_count + ' tours' : '') + '</div>' +
        '<div class="sc-occ">' + occ + '/' + inscrits + ' karts occupes</div>' +
        '</div>'
      );
    })
  );
  el.innerHTML = '<div class="sess-grid">' + cards.join('') + '</div>';
}

export function backToActivesList() {
  state.activeDetailSession = null;
  const list = document.getElementById('actives-list-view');
  const detail = document.getElementById('actives-detail-view');
  if (list) list.style.display = 'block';
  if (detail) detail.style.display = 'none';
}

// --- Création & détail d'une session -----------------------------------------------

// `onDone` permet à l'orchestrateur (app.js) de brancher switchTab/renderResultatsSection
// sans que ce module ait besoin d'importer les modules "results" et "ui" globaux et de
// créer une dépendance circulaire.
export async function createSession({ onCreated } = {}) {
  const title = document.getElementById('s-title').value.trim();
  const time = document.getElementById('s-time').value;
  const karts = state.prefs.karts_locked
    ? state.prefs.default_karts
    : parseInt(document.getElementById('s-karts').value) || state.prefs.default_karts;
  const laps = state.prefs.laps_enabled ? state.prefs.default_laps : null;
  if (!title) {
    showMsg('msg-create', 'Donne un titre.', 'err');
    return;
  }
  const fullTitle = title + ' - ' + time;
  const today = new Date().toISOString().slice(0, 10);
  const { data, error } = await db
    .from('sessions')
    .insert({ title: fullTitle, max_karts: karts, laps_count: laps, session_date: today, status: 'registration_open' })
    .select()
    .single();
  if (error) {
    showMsg('msg-create', error.message, 'err');
    return;
  }
  showMsg('msg-create', 'Session demarree !', 'ok');
  document.getElementById('s-title').value = '';
  await loadActiveSessions();
  if (onCreated) await onCreated(data.id);
}

export async function openActiveDetail(id, { onOpened } = {}) {
  const cached = state.activeSessions.find((x) => x.id === id);
  const s = cached || (await db.from('sessions').select('*').eq('id', id).single()).data;
  if (!s) return;
  state.activeDetailSession = s;
  const list = document.getElementById('actives-list-view');
  const detail = document.getElementById('actives-detail-view');
  if (list) list.style.display = 'none';
  if (detail) detail.style.display = 'block';
  document.getElementById('det-title-input').value = s.title;
  document.getElementById('det-karts-input').value = s.max_karts;
  document.getElementById('det-laps-input').value = s.laps_count || state.prefs.default_laps;
  document.getElementById('det-laps-wrap').style.display = state.prefs.laps_enabled ? 'block' : 'none';
  document.getElementById('det-save-btn').style.display = 'none';
  updateQRReg();
  await loadInscrits();
  await refreshOccupation();
  if (onOpened) await onOpened(s);
}

export function markDetailDirty() {
  const btn = document.getElementById('det-save-btn');
  if (btn) btn.style.display = 'inline-flex';
}

export async function saveDetailMeta() {
  if (!state.activeDetailSession) return;
  const title = document.getElementById('det-title-input').value.trim();
  const karts = parseInt(document.getElementById('det-karts-input').value) || state.activeDetailSession.max_karts;
  const laps = parseInt(document.getElementById('det-laps-input').value) || state.activeDetailSession.laps_count;
  if (!title) return;
  await db.from('sessions').update({ title, max_karts: karts, laps_count: laps }).eq('id', state.activeDetailSession.id);
  state.activeDetailSession.title = title;
  state.activeDetailSession.max_karts = karts;
  state.activeDetailSession.laps_count = laps;
  document.getElementById('det-save-btn').style.display = 'none';
  showMsg('msg-ins', 'Informations mises a jour.', 'ok');
  await loadActiveSessions();
  await refreshOccupation();
}

export async function refreshOccupation() {
  if (!state.activeDetailSession) return;
  const { data: regs } = await db.from('session_registrations').select('id,kart_number').eq('session_id', state.activeDetailSession.id);
  const inscrits = (regs || []).length;
  const occ = (regs || []).filter((r) => r.kart_number != null).length;
  document.getElementById('det-occ-main').textContent = occ + '/' + inscrits;
  const remaining = Math.max(0, (state.activeDetailSession.max_karts || 0) - inscrits);
  document.getElementById('det-remaining').textContent = remaining + ' restant(s) a ajouter';
}

export async function deleteActiveSession({ afterDelete } = {}) {
  if (!state.activeDetailSession) return;
  if (
    !confirm(
      'Supprimer definitivement la session "' + state.activeDetailSession.title + '" et toutes ses donnees (inscrits, chronos) ? Cette action est irreversible.'
    )
  )
    return;
  const id = state.activeDetailSession.id;
  try {
    await db.from('laps').delete().eq('session_id', id);
    await db.from('session_registrations').delete().eq('session_id', id);
    const { error } = await db.from('sessions').delete().eq('id', id);
    if (error) {
      showMsg('msg-ins', 'Erreur: ' + error.message, 'err');
      return;
    }
  } catch (e) {
    showMsg('msg-ins', 'Erreur: ' + e.message, 'err');
    return;
  }
  state.activeDetailSession = null;
  state.inscritsData = [];
  await loadActiveSessions();
  if (afterDelete) afterDelete();
  showMsg('msg-create', 'Session supprimee.', 'ok');
}

export async function terminerSession({ afterEnd } = {}) {
  if (!state.activeDetailSession) return;
  if (!confirm('Terminer et archiver "' + state.activeDetailSession.title + '" ?')) return;
  const id = state.activeDetailSession.id;
  try {
    const { error } = await db
      .from('sessions')
      .update({ archived_at: new Date().toISOString(), status: 'results_published' })
      .eq('id', id);
    if (error) {
      showMsg('msg-res', 'Erreur: ' + error.message, 'err');
      return;
    }
  } catch (e) {
    showMsg('msg-res', 'Erreur: ' + e.message, 'err');
    return;
  }
  state.activeDetailSession = null;
  state.inscritsData = [];
  await loadActiveSessions();
  if (afterEnd) afterEnd();
  showMsg('msg-create', 'Session archivee.', 'ok');
}

// --- QR code d'inscription -----------------------------------------------------------

export function updateQRReg() {
  if (!state.activeDetailSession) return;
  const url = APP_CONFIG.baseUrl + '/register.html?session=' + state.activeDetailSession.public_registration_token;
  const wrap = document.getElementById('qr-reg-wrap');
  if (wrap) wrap.innerHTML = '<img src="' + qrSrc(url, 160) + '" alt="QR"/>';
}

// --- Inscriptions (pilotes) -----------------------------------------------------------

export async function loadInscrits() {
  if (!state.activeDetailSession) return;
  const { data } = await db
    .from('session_registrations')
    .select('*,drivers(id,photo_url)')
    .eq('session_id', state.activeDetailSession.id)
    .order('created_at', { ascending: true });
  state.inscritsData = data || [];
  renderInscritsTable();
}

export async function addUnknownParticipant() {
  if (!state.activeDetailSession) return;
  const { data: regs } = await db.from('session_registrations').select('id,kart_number').eq('session_id', state.activeDetailSession.id);
  if ((regs || []).length >= state.activeDetailSession.max_karts) {
    showMsg('msg-ins', 'Nombre de karts max atteint.', 'err');
    return;
  }
  const uname = 'Unknown #' + randomCode4();
  const { error } = await db
    .from('session_registrations')
    .insert({ session_id: state.activeDetailSession.id, display_name: uname, kart_number: null, is_unknown: true, nationality: 'FR' });
  if (error) {
    showMsg('msg-ins', 'Erreur: ' + error.message, 'err');
    return;
  }
  showMsg('msg-ins', 'Participant ajoute. Attribuez-lui un kart.', 'ok');
  await loadInscrits();
  await refreshOccupation();
  await renderActivesGrid();
}

export async function deleteReg(rid, name, { onDeleted } = {}) {
  if (!confirm('Supprimer ' + name + ' de la session ?')) return;
  await db.from('laps').delete().eq('registration_id', rid);
  await db.from('session_registrations').delete().eq('id', rid);
  await loadInscrits();
  await refreshOccupation();
  renderKartGrid();
  if (onDeleted) onDeleted();
}

export async function saveNameInline(inputEl) {
  const v = inputEl.value.trim();
  if (!v) return;
  await db.from('session_registrations').update({ display_name: v }).eq('id', inputEl.dataset.rid);
  showMsg('msg-ins', 'Nom mis a jour.', 'ok');
  await loadInscrits();
}

export function selectPilotForKart(rid, evt) {
  if (evt) evt.stopPropagation();
  state.selectedPilotId = state.selectedPilotId === rid ? null : rid;
  renderInscritsTable();
}

// `onRowActions` reçoit (rid, name) pour brancher l'historique des chronos, géré par le
// module results.js — ce module sessions.js n'a pas besoin de connaître results.js.
export function renderInscritsTable(onRowActions = {}) {
  const el = document.getElementById('ins-table');
  if (!el) return;
  if (!state.inscritsData.length) {
    el.innerHTML = '<div class="empty">Aucun inscrit pour l\'instant.</div>';
    renderKartGrid();
    return;
  }
  el.innerHTML =
    '<table class="tbl"><thead><tr><th>Photo</th><th>Nom</th><th>Nat.</th><th>Kart</th><th></th><th></th></tr></thead><tbody>' +
    state.inscritsData
      .map((r) => {
        const drv = r.drivers;
        const photo = drv && drv.photo_url
          ? '<img src="' + drv.photo_url + '" class="av" onerror="this.style.display:none">'
          : '<div class="av-ph" style="background:' + avatarColor(r.display_name || '?') + '">' + avatarInitial(r.display_name || '?') + '</div>';
        const isSelected = state.selectedPilotId === r.id;
        const kartBadge = r.kart_number
          ? '<span class="kart-badge assigned">' + r.kart_number + '</span>'
          : '<span class="kart-badge empty">--</span>';
        return (
          '<tr class="pilot-row-select' + (isSelected ? ' selected' : '') + ' " data-rid="' + r.id + '">' +
          '<td>' + photo + '</td>' +
          '<td><input class="input-inline" value="' + (r.display_name || '') + '" data-rid="' + r.id + '" placeholder="Nom" onchange="saveNameInline(this)"/></td>' +
          '<td>' + (r.nationality || '--') + '</td>' +
          '<td>' + kartBadge + '</td>' +
          '<td><button class="btn btn-ghost btn-sm icon-btn hist-btn" data-rid="' + r.id + '" data-name="' + (r.display_name || '') + '"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg></button></td>' +
          '<td><button class="btn btn-ghost btn-sm icon-btn del-btn" style="color:#f04040" data-rid="' + r.id + '" data-name="' + (r.display_name || '') + '"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/></svg></button></td>' +
          '</tr>'
        );
      })
      .join('') +
    '</tbody></table>';

  el.querySelectorAll('tr.pilot-row-select').forEach((tr) => {
    tr.addEventListener('click', function (e) {
      if (e.target.closest('.del-btn') || e.target.closest('.hist-btn') || e.target.closest('input')) return;
      selectPilotForKart(tr.dataset.rid, e);
    });
  });
  el.querySelectorAll('.del-btn').forEach((btn) => {
    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      deleteReg(btn.dataset.rid, btn.dataset.name);
    });
  });
  el.querySelectorAll('.hist-btn').forEach((btn) => {
    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      if (onRowActions.onHistory) onRowActions.onHistory(btn.dataset.rid, btn.dataset.name);
    });
  });
  renderKartGrid();
}

// --- Attribution des karts -----------------------------------------------------------

export function nextFreeKart(regs) {
  const used = new Set((regs || []).map((r) => Number(r.kart_number)).filter((n) => !isNaN(n)));
  const available = getKartNumbersForSession();
  for (const k of available) {
    if (!used.has(k)) return k;
  }
  return null;
}

export function getKartNumbersForSession() {
  const max = state.activeDetailSession ? state.activeDetailSession.max_karts || 0 : 0;
  const defined = (state.prefs.kart_numbers || []).slice().sort((a, b) => a - b);
  if (defined.length) return defined.slice(0, max > 0 ? Math.max(max, defined.length) : defined.length);
  return Array.from({ length: max }, (_, i) => i + 1);
}

export function renderKartGrid() {
  const grid = document.getElementById('kart-grid');
  const hint = document.getElementById('kart-select-hint');
  if (!grid || !state.activeDetailSession) return;
  const kartNums = getKartNumbersForSession();
  const takenBy = new Map();
  state.inscritsData.forEach((r) => {
    if (r.kart_number) takenBy.set(Number(r.kart_number), r);
  });
  if (state.selectedPilotId) {
    const pilot = state.inscritsData.find((r) => r.id === state.selectedPilotId);
    hint.style.display = 'block';
    hint.textContent = 'Selectionne un kart libre pour ' + (pilot ? pilot.display_name : 'ce pilote') + '.';
  } else {
    hint.style.display = 'none';
  }
  let html = '';
  kartNums.forEach((k) => {
    const occ = takenBy.get(k);
    if (occ) {
      const isCurrentPilot = state.selectedPilotId === occ.id;
      html +=
        '<div class="kart-pastille taken" title="' + (occ.display_name || '') + '" onclick="' +
        (state.selectedPilotId ? 'reassignKart(' + k + ')' : '') + '" style="' + (isCurrentPilot ? 'outline:2px solid var(--acc)' : '') + '">' +
        '<div>' + k + '</div><div class="kp-name">' + (occ.display_name || '').slice(0, 8) + '</div></div>';
    } else {
      html += '<div class="kart-pastille free' + (state.selectedPilotId ? ' awaiting-select' : '') + '" onclick="assignKartToPilot(' + k + ')">' + k + '</div>';
    }
  });
  grid.innerHTML = html || '<div class="empty">Definis un nombre de karts max ou une liste de numeros dans Parametres.</div>';
}

export async function assignKartToPilot(kartNum) {
  if (!state.selectedPilotId) {
    showMsg('msg-ins', 'Selectionne dabord un pilote dans la liste ci-dessous.', 'err');
    return;
  }
  const { error } = await db.from('session_registrations').update({ kart_number: kartNum }).eq('id', state.selectedPilotId);
  if (error) {
    showMsg('msg-ins', 'Erreur: ' + error.message, 'err');
    return;
  }
  showMsg('msg-ins', 'Kart ' + kartNum + ' attribue !', 'ok');
  state.selectedPilotId = null;
  await loadInscrits();
  await refreshOccupation();
  await renderActivesGrid();
}

export async function reassignKart(kartNum) {
  if (!state.selectedPilotId) return;
  const occ = state.inscritsData.find((r) => Number(r.kart_number) === kartNum);
  if (occ && occ.id === state.selectedPilotId) return;
  const ok = confirm('Le kart ' + kartNum + " est deja attribue a " + (occ ? occ.display_name : "quelqu'un") + '. Le reattribuer ?');
  if (!ok) return;
  await assignKartToPilot(kartNum);
}

export async function assignMissingKarts() {
  const missing = state.inscritsData.filter((r) => !r.kart_number);
  if (!missing.length) {
    showMsg('msg-ins', 'Tous les pilotes ont deja un kart.', 'ok');
    return;
  }
  const { data: regs } = await db.from('session_registrations').select('id,kart_number').eq('session_id', state.activeDetailSession.id);
  let workingRegs = regs || [];
  for (const r of missing) {
    const kart = nextFreeKart(workingRegs);
    if (!kart) break;
    await db.from('session_registrations').update({ kart_number: kart }).eq('id', r.id);
    workingRegs.push({ id: r.id, kart_number: kart });
  }
  showMsg('msg-ins', 'Karts manquants attribues !', 'ok');
  await loadInscrits();
  await refreshOccupation();
  await renderActivesGrid();
}

export async function autoKarts() {
  if (!state.inscritsData.length) {
    showMsg('msg-ins', 'Aucun pilote inscrit.', 'err');
    return;
  }
  const available = getKartNumbersForSession();
  const nums = available.slice().sort(() => Math.random() - 0.5);
  for (let i = 0; i < state.inscritsData.length && i < nums.length; i++) {
    await db.from('session_registrations').update({ kart_number: nums[i] }).eq('id', state.inscritsData[i].id);
  }
  showMsg('msg-ins', 'Karts attribues aleatoirement !', 'ok');
  state.selectedPilotId = null;
  await loadInscrits();
  await refreshOccupation();
  await renderActivesGrid();
}

// --- Archives --------------------------------------------------------------------------

export async function loadArchives() {
  const { data } = await db
    .from('sessions')
    .select('*')
    .not('archived_at', 'is', null)
    .order('archived_at', { ascending: false });
  return data || [];
}
