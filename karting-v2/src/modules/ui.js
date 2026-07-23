// Helpers UI génériques — repris à l'identique du comportement de l'ancien index.html.
// Volontairement sans dépendance vers sessions/registrations/results : ce module ne fait
// que du formatage et de l'affichage générique, réutilisable partout.
import { state } from '../state.js';

const AVATAR_COLORS = ['#e74c3c', '#e67e22', '#2ecc71', '#3498db', '#9b59b6', '#1abc9c', '#e91e63', '#00bcd4'];

// Couleur d'avatar déterministe à partir du nom (même algorithme que l'original : avc()).
export function avatarColor(name) {
  let h = 0;
  for (let i = 0; i < (name || '').length; i++) h = name.charCodeAt(i) + ((h << 5) - h);
  return AVATAR_COLORS[Math.abs(h) % AVATAR_COLORS.length];
}

// Initiale affichée dans l'avatar (anciennement avi()).
export function avatarInitial(name) {
  if (!name || name.startsWith('Unknown')) return '?';
  return name.trim()[0].toUpperCase();
}

// Formatage d'un temps en secondes selon la préférence utilisateur (anciennement fmtT()).
export function formatTime(seconds) {
  const n = Number(seconds);
  if (!isFinite(n) || n >= 90000) return '--';
  if (state.prefs.time_unit === 'minutes_ms') {
    const m = Math.floor(n / 60);
    const rem = n % 60;
    const sec = Math.floor(rem);
    const ms = Math.round((rem - sec) * 1000);
    return m + ':' + String(sec).padStart(2, '0') + ':' + String(ms).padStart(3, '0');
  }
  if (state.prefs.time_unit === 'minutes' || n >= 60) {
    const m = Math.floor(n / 60);
    const sc = (n % 60).toFixed(3).padStart(6, '0');
    return m + ':' + sc;
  }
  return n.toFixed(3) + ' s';
}

// Code aléatoire à 4 chiffres pour les participants "Unknown #xxxx" (anciennement rnd4()).
export function randomCode4() {
  return String(Math.floor(1000 + Math.random() * 9000));
}

// Affiche un message temporaire dans un élément (anciennement showMsg()).
export function showMsg(elementId, message, type) {
  const el = document.getElementById(elementId);
  if (!el) return;
  el.textContent = message;
  el.className = 'msg ' + type;
  setTimeout(() => {
    el.className = 'msg';
  }, 5000);
}

// URL d'un QR code pour un lien donné (anciennement qrSrc()).
export function qrSrc(url, size) {
  return 'https://api.qrserver.com/v1/create-qr-code/?size=' + size + 'x' + size + '&data=' + encodeURIComponent(url);
}

// Formatage relatif d'une date ("Aujourd'hui", "Hier", ou date longue en FR) — anciennement fmtDate().
export function formatDate(d) {
  const date = new Date(d + 'T12:00:00');
  const today = new Date();
  today.setHours(12, 0, 0, 0);
  const diff = Math.round((today - date) / (1000 * 60 * 60 * 24));
  if (diff === 0) return "Aujourd'hui";
  if (diff === 1) return 'Hier';
  return date.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });
}
