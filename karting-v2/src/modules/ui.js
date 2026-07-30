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

// Formatage numerique d'une date selon la preference pref-date-format (Parametres >
// Sessions), developpee le 30/07 (client) : jusque-la le champ n'etait que visuel.
// Meme mecanisme que les autres prefs (app_settings.value.date_format, 'dmy' | 'mdy').
// Utilise par formatDate() ci-dessous des que la date n'est plus "Aujourd'hui"/"Hier",
// et directement partout ou un format exact est necessaire (PDF, exports CSV).
export function formatDateNumeric(d) {
  const date = new Date(d + 'T12:00:00');
  const dd = String(date.getDate()).padStart(2, '0');
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const yyyy = date.getFullYear();
  return state.prefs.date_format === 'mdy' ? mm + '-' + dd + '-' + yyyy : dd + '/' + mm + '/' + yyyy;
}

// Formatage relatif d'une date ("Aujourd'hui", "Hier", ou date au format numerique
// choisi dans Parametres > Sessions) — anciennement fmtDate(), qui rendait une date
// longue en FR fixe. Centralise ici : tout appelant (archives, sessions, registre,
// statistiques, PDF via buildSessionPDF()) beneficie automatiquement du reglage
// pref-date-format sans modification a chaque site d'appel.
export function formatDate(d) {
  const date = new Date(d + 'T12:00:00');
  const today = new Date();
  today.setHours(12, 0, 0, 0);
  const diff = Math.round((today - date) / (1000 * 60 * 60 * 24));
  if (diff === 0) return "Aujourd'hui";
  if (diff === 1) return 'Hier';
  return formatDateNumeric(d);
}


// Confirmation destructive avec rappel du contexte (audit 28/07, section 4.1) —
// remplace les confirm() natifs qui se valident par reflexe et n'affichent aucun
// detail. Retourne une Promise<boolean> : true si l'utilisateur a confirme.
export function confirmModal(opts) {
  const title = (opts && opts.title) || 'Confirmer';
  const message = (opts && opts.message) || '';
  const confirmLabel = (opts && opts.confirmLabel) || 'Confirmer';
  const danger = !opts || opts.danger !== false;
  return new Promise((resolve) => {
    const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:9999;display:flex;align-items:center;justify-content:center;padding:16px;';
    const box = document.createElement('div');
    box.style.cssText = 'background:#181818;border:1px solid #333;border-radius:12px;padding:24px;max-width:420px;width:100%;color:#eee;font-family:inherit;';
    box.innerHTML =
      '<div style="font-weight:700;font-size:16px;margin-bottom:10px">' + esc(title) + '</div>' +
      '<div style="font-size:14px;color:#ccc;margin-bottom:20px;white-space:pre-line">' + esc(message) + '</div>' +
      '<div style="display:flex;gap:10px;justify-content:flex-end">' +
      '<button type="button" data-act="cancel" style="padding:8px 16px;border-radius:8px;border:1px solid #444;background:transparent;color:#eee;cursor:pointer">Annuler</button>' +
      '<button type="button" data-act="ok" style="padding:8px 16px;border-radius:8px;border:none;background:' + (danger ? '#dc2626' : '#2563eb') + ';color:#fff;cursor:pointer;font-weight:600">' + esc(confirmLabel) + '</button>' +
      '</div>';
    overlay.appendChild(box);
    document.body.appendChild(overlay);
    function close(result) {
      document.body.removeChild(overlay);
      resolve(result);
    }
    box.querySelector('[data-act="cancel"]').addEventListener('click', () => close(false));
    box.querySelector('[data-act="ok"]').addEventListener('click', () => close(true));
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(false); });
    document.addEventListener('keydown', function onKey(e) {
      if (e.key === 'Escape') { document.removeEventListener('keydown', onKey); close(false); }
    });
  });
}
