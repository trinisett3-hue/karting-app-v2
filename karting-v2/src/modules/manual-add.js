// Ajout manuel d'un participant à une session active (admin).
//
// Pourquoi : tous les pilotes n'ont pas de téléphone, et certains refusent
// simplement de scanner. Jusqu'ici l'admin n'avait qu'un bouton « + Ajouter »
// qui créait un « Unknown #1234 » : pas d'e-mail, donc aucun résultat envoyé.
// Trois chemins sont désormais proposés, dans l'ordre où l'accueil les
// rencontre :
//
//   1. « Déjà venu »  — recherche partielle (admin_search_pilots, v24) sur les
//      pilotes ayant déjà couru sur CE circuit. On réutilise le profil : le
//      trigger fill_registration_from_pilot recopie nom/prénom/e-mail, donc
//      le pilote recevra ses résultats sans rien retaper.
//   2. « Première fois » — même procédure que register.html, via la RPC
//      register_new_pilot() existante, avec le jeton d'inscription de la
//      session en cours. E-MAIL OBLIGATOIRE : c'est lui qui déclenche l'envoi.
//   3. « Anonyme » — is_unknown = true, aucun e-mail. Choix assumé : ce pilote
//      court et apparaît au classement, mais ne recevra rien (rappelé à
//      l'écran pour que ce ne soit pas une surprise).
//
// Le pseudo reste le seul identifiant affiché publiquement — jamais le nom
// civil (contrainte métier constante du projet).
import { db } from '../lib/supabase.js';
import { state } from '../state.js';
import { showMsg } from './ui.js';
import { NATS } from './countries.js';
import { loadInscrits, refreshOccupation, renderActivesGrid } from './sessions.js';

// Échappement local (results.js fait de même) : ces chaînes viennent de la
// base et sont réinjectées en innerHTML.
function escapeHTML(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
          '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PSEUDO_RE = /^[A-Za-z0-9_.-]+$/;

const $ = (id) => document.getElementById(id);

let searchTimer = null;
let foundList = [];

function overlay() {
    return $('manual-add-overlay');
}

// Capacité : même garde-fou que addUnknownParticipant(), vérifiée à
// l'ouverture ET à l'insertion (une autre inscription peut arriver entre les
// deux via le QR).
async function seatsLeft() {
    if (!state.activeDetailSession) return 0;
    const { count } = await db
      .from('session_registrations')
      .select('id', { count: 'exact', head: true })
      .eq('session_id', state.activeDetailSession.id);
    return Math.max(0, (state.activeDetailSession.max_karts || 0) - (count || 0));
}

function setMode(mode) {
    ['search', 'new', 'anon'].forEach((m) => {
          const pane = $('ma-pane-' + m);
          if (pane) pane.classList.toggle('hidden', m !== mode);
          const tab = $('ma-tab-' + m);
          if (tab) tab.classList.toggle('active', m === mode);
    });
    $('ma-msg').textContent = '';
    if (mode === 'search') {
          const q = $('ma-search-input');
          if (q) q.focus();
    }
}

export function manualAddSetMode(mode) {
    setMode(mode);
}

export async function openManualAdd() {
    if (!state.activeDetailSession) return;
    const left = await seatsLeft();
    if (left <= 0) {
          showMsg('msg-ins', 'Nombre de karts max atteint.', 'err');
          return;
    }
    // Nationalités : même liste que l'inscription publique, aucune divergence.
  const natSel = $('ma-new-nat');
    if (natSel && !natSel.options.length) {
          natSel.innerHTML = NATS.map((n) => '<option value="' + n.code + '">' + n.flag + ' ' + escapeHTML(n.label) + '</option>').join('');
          natSel.value = 'FR';
    }
    ['ma-search-input', 'ma-new-first', 'ma-new-last', 'ma-new-email', 'ma-new-pseudo', 'ma-new-birth'].forEach((id) => {
          const el = $(id);
          if (el) el.value = '';
    });
    foundList = [];
    $('ma-search-result').innerHTML = '<div class="empty">Tape au moins 2 caractères (pseudo, nom ou e-mail).</div>';
    $('ma-seats').textContent = left + ' place(s) restante(s)';
    setMode('search');
    overlay().classList.add('show');
}

export function closeManualAdd() {
    overlay().classList.remove('show');
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = null;
}

function maMsg(text, kind) {
    const el = $('ma-msg');
    if (!el) return;
    el.textContent = text || '';
    el.style.color = kind === 'err' ? 'var(--red, #f04040)' : 'var(--grn, #33d17a)';
}

// --- 1. Pilote déjà venu ------------------------------------------------------

export function manualAddSearch() {
    const q = ($('ma-search-input').value || '').trim();
    if (searchTimer) clearTimeout(searchTimer);
    if (q.length < 2) {
          foundList = [];
          $('ma-search-result').innerHTML = '<div class="empty">Tape au moins 2 caractères (pseudo, nom ou e-mail).</div>';
          return;
    }
    // Anti-rafale : une requête par pause de frappe, pas une par caractère.
  searchTimer = setTimeout(async () => {
        const { data, error } = await db.rpc('admin_search_pilots', { _query: q });
        if (error) {
                $('ma-search-result').innerHTML = '<div class="empty">Recherche indisponible : ' + escapeHTML(error.message) + '</div>';
                return;
        }
        foundList = Array.isArray(data) ? data : [];
        if (!foundList.length) {
                $('ma-search-result').innerHTML =
                          '<div class="empty">Aucun pilote trouvé. Utilise « Première fois » pour le créer.</div>';
                return;
        }
        $('ma-search-result').innerHTML =
                '<table class="tbl"><thead><tr><th>Pseudo</th><th>Nom</th><th>Sessions</th><th></th></tr></thead><tbody>' +
                foundList
            .map(
                        (p, i) =>
                                      '<tr><td><strong>' + escapeHTML(p.pseudo || '--') + '</strong></td>' +
                                      '<td>' + escapeHTML(((p.first_name || '') + ' ' + (p.last_name || '')).trim() || '--') + '</td>' +
                                      '<td>' + (p.sessions_count || 0) + '</td>' +
                                      '<td><button class="btn btn-primary btn-sm" data-idx="' + i + '">Ajouter</button></td></tr>'
                      )
            .join('') +
                '</tbody></table>';
        $('ma-search-result')
          .querySelectorAll('button[data-idx]')
          .forEach((b) => b.addEventListener('click', () => addExistingPilot(foundList[Number(b.dataset.idx)])));
  }, 280);
}

async function insertRegistration(row) {
    const left = await seatsLeft();
    if (left <= 0) {
          maMsg('Nombre de karts max atteint entre-temps.', 'err');
          return false;
    }
    const { error } = await db.from('session_registrations').insert(row);
    if (error) {
          // Filet de sécurité serveur en plus du contrôle local `already` :
      // deux admins (ou un admin + le QR public) peuvent ajouter le même
      // pilote au même instant. La contrainte session_registrations_session_pilot_uidx
      // (ajoutée le 30/07, correctif bug A4/B28) l'empêche ; ici on transforme
      // juste l'erreur brute en message compréhensible.
      if (error.code === '23505' && (error.details || error.message || '').indexOf('session_pilot_uidx') !== -1) {
              maMsg('Ce pilote vient d\'être inscrit à cette session (par un autre écran ou le QR) — pas besoin de le rajouter.', 'err');
              return false;
      }
          maMsg('Erreur : ' + error.message, 'err');
          return false;
    }
    return true;
}

async function afterAdd(message) {
    closeManualAdd();
    showMsg('msg-ins', message, 'ok');
    await loadInscrits();
    await refreshOccupation();
    await renderActivesGrid();
}

async function addExistingPilot(p) {
    if (!p || !p.id || !state.activeDetailSession) return;
    const already = (state.inscritsData || []).some((r) => r.pilot_id === p.id);
    if (already) {
          maMsg('Ce pilote est déjà inscrit à cette session.', 'err');
          return;
    }
    // display_name = pseudo, jamais le nom civil. first_name/last_name/email
  // sont remplis côté serveur par fill_registration_from_pilot.
  const ok = await insertRegistration({
        session_id: state.activeDetailSession.id,
        pilot_id: p.id,
        display_name: p.pseudo || p.first_name || 'Pilote',
        nationality: p.nationality || 'FR',
        kart_number: null,
        is_unknown: false,
  });
    if (ok) await afterAdd('Pilote ajouté. Attribuez-lui un kart.');
}

// --- 2. Première fois --------------------------------------------------------

export async function manualAddCreate() {
    if (!state.activeDetailSession) return;
    const token = state.activeDetailSession.public_registration_token;
    if (!token) {
          maMsg("Cette session n'a pas de jeton d'inscription : impossible de créer un profil.", 'err');
          return;
    }
    const first = ($('ma-new-first').value || '').trim();
    const last = ($('ma-new-last').value || '').trim();
    const email = ($('ma-new-email').value || '').trim();
    const pseudo = ($('ma-new-pseudo').value || '').trim();
    const birth = ($('ma-new-birth').value || '').trim();
    const nat = $('ma-new-nat').value || 'FR';

  if (!first || !last) { maMsg('Prénom et nom sont obligatoires.', 'err'); return; }
    // E-mail obligatoire : sans lui, aucun résultat ne peut partir. Le seul cas
  // sans e-mail est le chemin « Anonyme », explicitement choisi.
  if (!EMAIL_RE.test(email)) { maMsg("E-mail invalide — il est obligatoire pour recevoir les résultats. Sinon, utilise « Anonyme ».", 'err'); return; }
    if (!pseudo) { maMsg('Le pseudo est obligatoire (c\'est le nom affiché publiquement).', 'err'); return; }
    if (!PSEUDO_RE.test(pseudo)) { maMsg('Pseudo invalide : pas d\'accents ni d\'espaces (lettres, chiffres, - _ .).', 'err'); return; }

  const btn = $('ma-new-btn');
    if (btn) btn.disabled = true;
    try {
          const { data: pilotId, error } = await db.rpc('register_new_pilot', {
                  _first_name: first,
                  _last_name: last,
                  _email: email,
                  _pseudo: pseudo,
                  _birth_date: birth || null,
                  _nationality: nat,
                  _registration_token: token,
          });
          if (error) throw error;
          const ok = await insertRegistration({
                  session_id: state.activeDetailSession.id,
                  pilot_id: pilotId,
                  display_name: pseudo,
                  nationality: nat,
                  kart_number: null,
                  is_unknown: false,
          });
          if (ok) await afterAdd('Pilote créé et inscrit. Attribuez-lui un kart.');
    } catch (e) {
          maMsg(e.message || 'Création impossible.', 'err');
    } finally {
          if (btn) btn.disabled = false;
    }
}

// --- 3. Anonyme --------------------------------------------------------------

export async function manualAddAnonymous() {
    if (!state.activeDetailSession) return;
    const uname = 'Unknown #' + String(Math.floor(1000 + Math.random() * 9000));
    const ok = await insertRegistration({
          session_id: state.activeDetailSession.id,
          display_name: uname,
          kart_number: null,
          is_unknown: true,
          nationality: 'FR',
    });
    if (ok) await afterAdd('Participant anonyme ajouté (aucun résultat ne lui sera envoyé).');
}
