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
// 02/08 — Le bouton de confirmation non destructif etait bleu #2563eb en dur :
// il ignorait le theme de Parametres > Apparence. Il prend desormais l'accent
// du theme. Seule exception : quand cet accent est lui-meme un rouge, un
// bouton plein serait confondu avec le bouton destructif — on bascule alors
// sur une variante en contour. Le bouton destructif, lui, reste rouge quel que
// soit le theme : c'est une couleur de sens, pas une couleur de marque.
function themeAccent() {
  try {
    const cs = getComputedStyle(document.documentElement);
    const v = (cs.getPropertyValue('--acc') || cs.getPropertyValue('--c-accent') || '').trim();
    return v || null;
  } catch (e) { return null; }
}

function themeBg() {
  try {
    const cs = getComputedStyle(document.documentElement);
    const v = (cs.getPropertyValue('--bg') || cs.getPropertyValue('--c-bg') || '').trim();
    return v || '#0b0b0f';
  } catch (e) { return '#0b0b0f'; }
}

// true si la couleur donnee est un rouge franc (teinte < 18 deg ou > 345 deg,
// saturation suffisante) — auquel cas on evite le bouton plein.
function isReddish(color) {
  if (!color) return false;
  let r, g, b;
  const hex = color.replace('#', '');
  if (/^[0-9a-f]{6}$/i.test(hex)) {
    r = parseInt(hex.slice(0, 2), 16); g = parseInt(hex.slice(2, 4), 16); b = parseInt(hex.slice(4, 6), 16);
  } else if (/^[0-9a-f]{3}$/i.test(hex)) {
    r = parseInt(hex[0] + hex[0], 16); g = parseInt(hex[1] + hex[1], 16); b = parseInt(hex[2] + hex[2], 16);
  } else {
    const m = color.match(/rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/i);
    if (!m) return false;
    r = +m[1]; g = +m[2]; b = +m[3];
  }
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  if (!d || mx < 60) return false;
  const sat = d / mx;
  if (sat < 0.35) return false;
  let h;
  if (mx === r) h = 60 * (((g - b) / d) % 6);
  else if (mx === g) h = 60 * ((b - r) / d + 2);
  else h = 60 * ((r - g) / d + 4);
  if (h < 0) h += 360;
  return h < 18 || h > 345;
}

export function confirmModal(opts) {
  const title = (opts && opts.title) || 'Confirmer';
  const message = (opts && opts.message) || '';
  const confirmLabel = (opts && opts.confirmLabel) || 'Confirmer';
  const danger = !opts || opts.danger !== false;
  const okStyle = () => {
    if (danger) return 'border:none;background:#dc2626;color:#fff';
    const acc = themeAccent();
    if (!acc) return 'border:none;background:#2563eb;color:#fff';
    if (isReddish(acc)) return 'border:1px solid ' + acc + ';background:transparent;color:' + acc;
    return 'border:none;background:' + acc + ';color:' + themeBg();
  };
  return new Promise((resolve) => {
    const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
    // 01/08 (client) : en mode clair la boite etait illisible (fond #181818 en dur sur
    // une page blanche). On passe par les memes tokens de theme que le reste de l'app
    // (--surf / --txt / --bord / --mut), avec les anciennes valeurs sombres en fallback
    // pour les pages qui ne definiraient pas ces variables. Les classes cm-* permettent
    // en plus a admin.html d'affiner le rendu sans toucher a ce module.
    const overlay = document.createElement('div');
    overlay.className = 'cm-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(6,8,14,.62);backdrop-filter:blur(6px);z-index:9999;display:flex;align-items:center;justify-content:center;padding:16px;';
    const box = document.createElement('div');
    box.className = 'cm-box';
    box.style.cssText = 'background:var(--surf,#181818);border:1px solid var(--bord,#333);border-radius:16px;padding:24px;max-width:420px;width:100%;color:var(--txt,#eee);font-family:inherit;box-shadow:0 26px 70px -18px rgba(0,0,0,.55);';
    box.innerHTML =
      '<div style="font-weight:800;font-size:16px;margin-bottom:10px;color:var(--txt,#eee)">' + esc(title) + '</div>' +
      '<div style="font-size:14px;color:var(--mut,#ccc);margin-bottom:20px;white-space:pre-line;line-height:1.5">' + esc(message) + '</div>' +
      '<div style="display:flex;gap:10px;justify-content:flex-end">' +
      '<button type="button" class="cm-cancel" data-act="cancel" style="padding:9px 16px;border-radius:9px;border:1px solid var(--bord,#444);background:var(--surf2,transparent);color:var(--txt,#eee);cursor:pointer;font-weight:600">Annuler</button>' +
      '<button type="button" class="cm-ok" data-act="ok" style="padding:9px 16px;border-radius:9px;font-weight:700;cursor:pointer;' + okStyle() + '">' + esc(confirmLabel) + '</button>' +
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
