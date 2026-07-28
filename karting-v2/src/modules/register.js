// Module d'inscription publique (register.html) — accès par QR code / lien, sans auth.
//
// Reprend à l'identique la logique de l'ancien register.html monofichier pour la
// résolution de session (public_registration_token) et la sélection nationalité.
//
// 🔧 v13 : formulaire à une seule étape, étape photo retirée (réservée à une
// offre future Compétition/Séminaires — voir session_type). Plus d'upload vers
// le bucket driver-photos ni de création de fiche `drivers` : driver_id reste
// null sur session_registrations (déjà géré ailleurs, cf. avatarHTML() dans
// public-results.js qui affiche un avatar de substitution par numéro de kart).
//
// 🆕 v13 + demande client post-v13 : le champ "nom" du formulaire devient le
// PSEUDO du pilote — c'est lui qui alimente display_name (déjà le cas
// aujourd'hui, donc aucune régression côté podium/classement/PDF, qui lisent
// tous display_name). Prénom/nom réel et email sont des champs séparés,
// stockés sur session_registrations (email) — aucune fiche `drivers` n'étant
// plus créée par cette page, c'est le seul endroit qui garantit de les capturer.
import { db } from '../lib/supabase.js';

const NATS = [
  { code: 'FR', flag: '🇫🇷', label: 'France' },
  { code: 'BE', flag: '🇧🇪', label: 'Belgique' },
  { code: 'DE', flag: '🇩🇪', label: 'Allemagne' },
  { code: 'IT', flag: '🇮🇹', label: 'Italie' },
  { code: 'ES', flag: '🇪🇸', label: 'Espagne' },
  { code: 'GB', flag: '🇬🇧', label: 'Angleterre' },
  { code: 'NL', flag: '🇳🇱', label: 'Pays-Bas' },
  { code: 'OTHER', flag: '🌍', label: 'Autre' },
];

const regState = {
  selectedNat: 'FR',
  sessionId: null,
};

// Validation email basique — suffisante pour un formulaire mobile, pas une
// vérification RFC complète (pas de vérification de délivrabilité côté front).
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function renderNats() {
  const grid = document.getElementById('nat-grid');
  if (!grid) return;
  grid.innerHTML = NATS.map(
    (n) =>
      '<div class="nat-btn ' + (n.code === 'FR' ? 'selected' : '') + '" onclick="selectNat(\'' + n.code + '\',this)">' +
      n.flag + ' ' + n.label + '</div>'
  ).join('');
}

export async function initRegisterPage() {
  const params = new URLSearchParams(window.location.search);
  const token = params.get('session');
  if (!token) {
    document.getElementById('session-name').textContent = 'Lien invalide';
    return;
  }
  const { data: sess } = await db.from('sessions').select('id,title').eq('public_registration_token', token).single();
  if (!sess) {
    document.getElementById('session-name').textContent = 'Session introuvable';
    return;
  }
  regState.sessionId = sess.id;
  document.getElementById('session-name').textContent = sess.title;
}

export function selectNat(code, el) {
  regState.selectedNat = code;
  document.querySelectorAll('.nat-btn').forEach((b) => b.classList.remove('selected'));
  el.classList.add('selected');
}

export function showMsg(msg, type) {
  const el = document.getElementById('msg');
  if (!el) return;
  el.textContent = msg;
  el.className = 'msg ' + type;
}

export async function submitForm() {
  if (!regState.sessionId) { showMsg('Session invalide.', 'err'); return; }
  // Le pseudo est ce qui alimente display_name — donc ce qui s'affiche
  // réellement sur le kart, le podium, le classement et les PDF (comme
  // aujourd'hui : c'était déjà le seul champ "nom" du formulaire).
  const pseudo = document.getElementById('inp-name').value.trim();
  const firstName = document.getElementById('inp-firstname').value.trim();
  const lastName = document.getElementById('inp-lastname').value.trim();
  const email = document.getElementById('inp-email').value.trim();
  if (!pseudo) { showMsg('Entre ton pseudo.', 'err'); return; }
  if (!email) { showMsg('Entre ton email.', 'err'); return; }
  if (!EMAIL_RE.test(email)) { showMsg('Email invalide.', 'err'); return; }
  const btn = document.getElementById('btn-submit');
  btn.disabled = true; btn.textContent = 'Inscription en cours…';
  try {
    const { error } = await db.from('session_registrations').insert({
      session_id: regState.sessionId,
      display_name: pseudo,
      nationality: regState.selectedNat,
      email,
      first_name: firstName || null,
      last_name: lastName || null,
      driver_id: null,
      is_unknown: false,
    });
    if (error) throw error;
    document.getElementById('form-card').style.display = 'none';
    document.getElementById('success-card').style.display = 'block';
    document.getElementById('success-name').textContent = 'Bonne course ' + pseudo + ' !';
  } catch (e) {
    showMsg('Erreur: ' + e.message, 'err');
    btn.disabled = false; btn.textContent = "S'inscrire à la course 🏁";
  }
}
