// Module Écuries — partie admin.
//
// Séparé de teams.js volontairement : teams.js est chargé par la page publique
// de résultats et par la page d'inscription, il ne doit contenir que du
// référentiel et du calcul. Tout ce qui touche au DOM de l'admin vit ici.
//
// Deux écrans utilisent exactement le même bloc de réglage, avec deux préfixes
// d'identifiants différents ('s-' à la création, 'det-' dans le détail) :
// mountTeamBlock() est écrite une fois et branchée deux fois.

import { db } from '../lib/supabase.js';
import { loadTeamCatalog, teamLogoHTML } from './teams.js';
import { hasFeature } from './plan.js';

const blocks = {}; // prefix -> { teams, selected:Set, entitled }

// --- Rendu -----------------------------------------------------------------------------

function pickerHTML(prefix, teams, selected, sizeMax, taken) {
  return teams.map((t) => {
    const on = selected.has(t.id);
    const used = taken ? (taken[t.id] || 0) : 0;
    // Une écurie qui compte déjà des pilotes ne peut plus être retirée de la
    // session : on la verrouille cochée plutôt que de laisser l'organisateur
    // créer des inscriptions orphelines sans s'en rendre compte.
    const locked = used > 0;
    return (
      '<button type="button" class="team-chip' + (on ? ' on' : '') + (locked ? ' locked' : '') + '"' +
      ' data-prefix="' + prefix + '" data-team="' + t.id + '"' +
      (locked ? ' title="' + used + ' pilote(s) déjà inscrit(s) dans cette écurie"' : '') +
      ' style="--tc:' + t.color + '">' +
      teamLogoHTML(t, 22) +
      '<span class="tc-name">' + t.name + '</span>' +
      (used ? '<span class="tc-count">' + used + '/' + sizeMax + '</span>' : '') +
      '</button>'
    );
  }).join('');
}

function refreshPicker(prefix) {
  const b = blocks[prefix];
  const el = document.getElementById(prefix + '-team-picker');
  if (!b || !el) return;
  el.innerHTML = pickerHTML(prefix, b.teams, b.selected, b.sizeMax, b.taken);
  el.querySelectorAll('.team-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      if (chip.classList.contains('locked')) return;
      const id = chip.dataset.team;
      if (b.selected.has(id)) b.selected.delete(id); else b.selected.add(id);
      chip.classList.toggle('on');
      updateSummary(prefix);
      if (b.onChange) b.onChange();
    });
  });
  updateSummary(prefix);
}

function updateSummary(prefix) {
  const b = blocks[prefix];
  const el = document.getElementById(prefix + '-team-summary');
  if (!b || !el) return;
  const n = b.selected.size || b.teams.length;
  const size = b.sizeMax || 2;
  el.textContent = n + ' écurie(s) engagée(s) · ' + (n * size) + ' places pilotes' +
    (b.selected.size ? '' : ' (aucune sélection = les ' + b.teams.length + ' écuries sont ouvertes)');
}

function setEnabled(prefix, on) {
  const wrap = document.getElementById(prefix + '-team-config');
  if (wrap) wrap.style.display = on ? 'block' : 'none';
}

// --- Montage ---------------------------------------------------------------------------
//
// `session` peut être null (panneau de création). `onChange` est appelée à
// chaque modification pour que le détail puisse afficher son bouton Enregistrer.
export async function mountTeamBlock(prefix, { session = null, taken = null, onChange = null } = {}) {
  const root = document.getElementById(prefix + '-team-block');
  if (!root) return;

  const entitled = await hasFeature('team_mode');
  if (!entitled) {
    // Aucun réglage n'est déposé dans le DOM quand le plan ne l'autorise pas :
    // même règle que renderPremiumLock() dans stats.js, on ne laisse pas
    // traîner un formulaire désactivé qu'un curieux pourrait réactiver.
    root.innerHTML =
      '<div class="ctitle">Mode Écurie</div>' +
      '<div style="font-size:12px;color:var(--mut);background:var(--surf2);border:1px solid var(--bord);' +
      'border-radius:8px;padding:12px;text-align:center">🔒 Championnat par écuries — réservé au plan ' +
      '<strong>Premium</strong>.</div>';
    blocks[prefix] = { entitled: false, teams: [], selected: new Set() };
    return;
  }

  const teams = await loadTeamCatalog();
  const selected = new Set();
  if (session) {
    const { data } = await db.from('session_teams').select('team_id').eq('session_id', session.id);
    (data || []).forEach((r) => selected.add(r.team_id));
  }

  blocks[prefix] = {
    entitled: true,
    teams,
    selected,
    sizeMax: (session && session.team_size_max) || 2,
    taken: taken || null,
    onChange,
  };

  const on = !!(session && session.team_mode);
  root.innerHTML =
    '<div class="flex" style="align-items:center;gap:10px;margin-bottom:2px">' +
      '<label class="team-switch">' +
        '<input type="checkbox" id="' + prefix + '-team-mode"' + (on ? ' checked' : '') + '>' +
        '<span>Mode Écurie</span>' +
      '</label>' +
      '<span style="font-size:11px;color:var(--mut)">Championnat constructeur en plus du classement pilote</span>' +
    '</div>' +
    '<div id="' + prefix + '-team-config" style="display:' + (on ? 'block' : 'none') + ';margin-top:10px">' +
      '<div class="flex" style="align-items:flex-end;gap:12px;margin-bottom:10px">' +
        '<div style="width:150px">' +
          '<label>Pilotes par écurie</label>' +
          '<input type="number" id="' + prefix + '-team-size" min="1" max="6" value="' +
            ((session && session.team_size_max) || 2) + '">' +
        '</div>' +
        '<div style="flex:1;font-size:11px;color:var(--mut)" id="' + prefix + '-team-summary"></div>' +
      '</div>' +
      '<label style="display:block;margin-bottom:6px">Écuries engagées</label>' +
      '<div class="team-picker" id="' + prefix + '-team-picker"></div>' +
    '</div>';

  document.getElementById(prefix + '-team-mode').addEventListener('change', (e) => {
    setEnabled(prefix, e.target.checked);
    if (onChange) onChange();
  });
  const sizeEl = document.getElementById(prefix + '-team-size');
  sizeEl.addEventListener('input', () => {
    blocks[prefix].sizeMax = Math.min(6, Math.max(1, parseInt(sizeEl.value) || 2));
    refreshPicker(prefix);
    if (onChange) onChange();
  });

  refreshPicker(prefix);
}

// Lit l'état du bloc. Retourne toujours un objet exploitable, même quand le
// plan ne donne pas le droit au mode : dans ce cas team_mode est false, et
// l'appelant n'a aucun cas particulier à traiter.
export function readTeamBlock(prefix) {
  const b = blocks[prefix];
  if (!b || !b.entitled) return { team_mode: false, team_size_max: 2, teams: [] };
  const modeEl = document.getElementById(prefix + '-team-mode');
  const sizeEl = document.getElementById(prefix + '-team-size');
  return {
    team_mode: !!(modeEl && modeEl.checked),
    team_size_max: Math.min(6, Math.max(1, parseInt(sizeEl && sizeEl.value) || 2)),
    teams: Array.from(b.selected),
  };
}

// Aligne public.session_teams sur la sélection. On calcule le différentiel
// plutôt que de vider-recréer : un DELETE global casserait les FK le temps
// d'une transaction et ferait clignoter la table pour rien.
export async function syncSessionTeams(sessionId, teamIds) {
  const { data: current } = await db.from('session_teams').select('team_id').eq('session_id', sessionId);
  const have = new Set((current || []).map((r) => r.team_id));
  const want = new Set(teamIds || []);

  const toAdd = Array.from(want).filter((id) => !have.has(id));
  const toDrop = Array.from(have).filter((id) => !want.has(id));

  if (toAdd.length) {
    await db.from('session_teams').insert(toAdd.map((id) => ({ session_id: sessionId, team_id: id })));
  }
  if (toDrop.length) {
    // Une écurie qui compte encore des pilotes n'est jamais retirée : le chip
    // est verrouillé côté UI, mais la règle est re-vérifiée ici parce que
    // l'écran de création et l'écran de détail n'ont pas le même contexte.
    const { data: used } = await db
      .from('session_registrations')
      .select('team_id')
      .eq('session_id', sessionId)
      .in('team_id', toDrop);
    const busy = new Set((used || []).map((r) => r.team_id));
    const safe = toDrop.filter((id) => !busy.has(id));
    if (safe.length) {
      await db.from('session_teams').delete().eq('session_id', sessionId).in('team_id', safe);
    }
  }
}

// Compte les pilotes par écurie sur une session. Sert à afficher « 2/2 » sur
// les chips et à verrouiller celles qui sont occupées.
export function countByTeam(registrations) {
  const out = {};
  (registrations || []).forEach((r) => {
    if (r && r.team_id) out[r.team_id] = (out[r.team_id] || 0) + 1;
  });
  return out;
}

// --- Correction de l'affiliation depuis le registre de la session ----------------------
//
// Le <select> de la colonne Écurie. Les écuries pleines sont désactivées, sauf
// celle du pilote lui-même (sinon sa propre valeur disparaîtrait de la liste et
// le navigateur choisirait la première option à sa place — un pilote changerait
// d'écurie tout seul au premier rendu).
export function teamSelectHTML(reg, teams, taken, sizeMax) {
  const cur = reg.team_id || '';
  const opts = ['<option value="">— aucune —</option>'].concat(
    (teams || []).map((t) => {
      const used = taken[t.id] || 0;
      const isMine = cur === t.id;
      const full = used >= sizeMax && !isMine;
      return '<option value="' + t.id + '"' + (isMine ? ' selected' : '') + (full ? ' disabled' : '') + '>' +
             t.name + (used ? ' (' + used + '/' + sizeMax + ')' : '') + '</option>';
    })
  ).join('');
  const team = (teams || []).find((t) => t.id === cur);
  return '<div class="team-cell" style="--tc:' + (team ? team.color : 'transparent') + '">' +
         (team ? teamLogoHTML(team, 18) : '') +
         '<select class="input-inline team-select" data-rid="' + reg.id + '">' + opts + '</select></div>';
}
