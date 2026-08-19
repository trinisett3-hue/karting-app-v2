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
import { teamLogoHTML } from './teams.js';
import { hasFeature } from './plan.js';

const blocks = {}; // prefix -> { entitled }

// Taille d'écurie : ce n'est pas un réglage — une écurie, c'est 2 pilotes,
// jamais plus, jamais moins. Aucune configuration ne l'expose, nulle part
// (ni en nombre modifiable, ni même affiché comme texte côté admin).
const TEAM_SIZE_FIXED = 2;

// --- Montage ---------------------------------------------------------------------------
//
// `session` peut être null (panneau de création). `onChange` est appelée à
// chaque modification pour que le détail puisse afficher son bouton
// Enregistrer.
//
// L'organisateur n'a plus qu'une case à cocher : quelles écuries s'affrontent
// et qui en fait partie n'est pas un choix admin, c'est le résultat des choix
// des pilotes à l'inscription (voir renderTeamPicker() dans register.js). Il
// n'y a donc plus de sélection d'écuries engagées ici, ni à la création ni
// dans le détail d'une session — toutes les écuries du catalogue sont
// toujours ouvertes aux pilotes.
export async function mountTeamBlock(prefix, { session = null, onChange = null } = {}) {
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
    blocks[prefix] = { entitled: false };
    return;
  }

  blocks[prefix] = { entitled: true };

  const on = !!(session && session.team_mode);
  root.innerHTML =
    '<div class="flex" style="align-items:center;gap:10px;margin-bottom:2px">' +
      '<label class="team-switch">' +
        '<input type="checkbox" id="' + prefix + '-team-mode"' + (on ? ' checked' : '') + '>' +
        '<span>Mode Écurie</span>' +
      '</label>' +
      '<span style="font-size:11px;color:var(--mut)">Championnat constructeur en plus du classement pilote — les pilotes choisissent leur écurie à l\'inscription.</span>' +
    '</div>';

  document.getElementById(prefix + '-team-mode').addEventListener('change', () => {
    if (onChange) onChange();
  });
}

// Lit l'état du bloc. Retourne toujours un objet exploitable, même quand le
// plan ne donne pas le droit au mode : dans ce cas team_mode est false, et
// l'appelant n'a aucun cas particulier à traiter.
export function readTeamBlock(prefix) {
  const b = blocks[prefix];
  if (!b || !b.entitled) return { team_mode: false, team_size_max: TEAM_SIZE_FIXED, teams: [] };
  const modeEl = document.getElementById(prefix + '-team-mode');
  return {
    team_mode: !!(modeEl && modeEl.checked),
    team_size_max: TEAM_SIZE_FIXED,
    // Toujours vide : plus de restriction d'écuries engagées côté admin, donc
    // toujours « aucune sélection = toutes les écuries sont ouvertes » côté
    // syncSessionTeams (voir sa docstring plus bas) — c'est désormais le seul
    // mode de fonctionnement, pas un cas particulier.
    teams: [],
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
    // Une écurie qui compte encore des pilotes n'est jamais retirée : la
    // règle est re-vérifiée ici parce que l'écran de création et l'écran de
    // détail n'ont pas le même contexte.
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
// la colonne Écurie du registre et à verrouiller les écuries déjà pleines.
export function countByTeam(registrations) {
  const out = {};
  (registrations || []).forEach((r) => {
    if (r && r.team_id) out[r.team_id] = (out[r.team_id] || 0) + 1;
  });
  return out;
}

// --- Correction de l'affiliation depuis le registre de la session ----------------------
//
// Le <select> de la colonne Écurie du tableau des inscrits (sessions.js >
// renderInscritsTable()). C'est ici — et seulement ici — que l'admin peut
// voir et corriger l'écurie de chaque pilote inscrit, qu'il se soit inscrit
// lui-même en choisissant son écurie, ou qu'il ait été ajouté manuellement
// par le staff (manual-add.js, qui n'assigne aucune écurie à la création :
// l'admin l'affecte ensuite depuis cette même colonne).
//
// Les écuries pleines sont désactivées, sauf celle du pilote lui-même (sinon
// sa propre valeur disparaîtrait de la liste et le navigateur choisirait la
// première option à sa place — un pilote changerait d'écurie tout seul au
// premier rendu).
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
