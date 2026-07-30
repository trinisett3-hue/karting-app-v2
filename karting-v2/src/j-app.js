// Page d'accueil permanente du circuit (j.html), atteinte par la plaque QR
// imprimée : j.html?c=<tenants.public_venue_token>.
//
// Contrairement aux anciens QR (un par session, jetables, affichés sur un écran
// qu'il fallait retourner), ce lien ne change jamais : il est encodé une fois,
// imprimé, et envoyé par voie postale. C'est la page qui décide quoi proposer.
//
// Elle ne duplique rien : elle redirige vers register.html / results.html avec
// le token de session correspondant, exactement comme les anciens QR le
// faisaient.
import { db } from './lib/supabase.js';

const $ = (id) => document.getElementById(id);

let openSessions = [];
let recentResults = [];

function show(id) {
  ['j-loading', 'j-error', 'j-main'].forEach((k) => $(k).classList.toggle('hidden', k !== id));
}

function fail(msg) {
  if (msg) $('j-error-msg').textContent = msg;
  show('j-error');
}

// "14:30 — Session découverte" : l'heure d'abord, c'est ce que le pilote cherche.
function label(s) {
  const t = s.starts_at ? new Date(s.starts_at) : null;
  const h = t && !isNaN(t) ? t.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }) : null;
  const name = (s.title || s.circuit_name || 'Session').trim();
  return h ? h + ' — ' + name : name;
}

// Les tokens ne transitent jamais dans le DOM : l'option ne porte qu'un index,
// et le token n'est lu qu'au moment de la redirection.
function fillSelect(sel, list) {
  sel.innerHTML = '';
  list.forEach((s, i) => {
    const o = document.createElement('option');
    o.value = String(i);
    o.textContent = label(s);
    sel.appendChild(o);
  });
}

function section(list, wrapId, emptyId) {
  const empty = list.length === 0;
  $(wrapId).classList.toggle('hidden', empty);
  $(emptyId).classList.toggle('hidden', !empty);
}

export function jJoin() {
  const sel = $('j-open-select');
  const s = openSessions[Number(sel.value)];
  if (!s || !s.registration_token) return;
  window.location.href = 'register.html?session=' + encodeURIComponent(s.registration_token);
}

export function jResults() {
  const sel = $('j-res-select');
  const s = recentResults[Number(sel.value)];
  if (!s || !s.results_token) return;
  window.location.href = 'results.html?result=' + encodeURIComponent(s.results_token);
}

async function init() {
  const token = (new URLSearchParams(window.location.search).get('c') || '').trim();
  if (token.length < 16) {
    fail("Lien incomplet. Scanne à nouveau la plaque QR du circuit.");
    return;
  }

  let data = null;
  try {
    const res = await db.rpc('public_venue_sessions', { _venue_token: token });
    if (res.error) throw res.error;
    data = res.data;
  } catch (e) {
    fail('Connexion impossible. Réessaie dans un instant.');
    return;
  }

  if (!data) {
    fail("Ce QR code n'est pas reconnu.");
    return;
  }

  $('j-venue').textContent = data.venue_name || 'Karting';
  document.title = (data.venue_name || 'Karting') + ' – Accueil';
  if (data.logo_url) {
    const img = $('j-logo');
    img.src = data.logo_url;
    img.alt = data.venue_name || '';
    img.classList.remove('hidden');
  }

  openSessions = Array.isArray(data.open_sessions) ? data.open_sessions.filter((s) => s && s.registration_token) : [];
  recentResults = Array.isArray(data.recent_results) ? data.recent_results.filter((s) => s && s.results_token) : [];

  fillSelect($('j-open-select'), openSessions);
  fillSelect($('j-res-select'), recentResults);
  section(openSessions, 'j-open-wrap', 'j-open-empty');
  section(recentResults, 'j-res-wrap', 'j-res-empty');

  show('j-main');
}

Object.assign(window, { jJoin, jResults });
window.addEventListener('DOMContentLoaded', init);
