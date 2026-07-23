// Module d'inscription publique (register.html) — accès par QR code / lien, sans auth.
//
// Reprend à l'identique la logique de l'ancien register.html monofichier :
// résolution de session par public_registration_token, sélection nationalité,
// upload + compression de photo, création du driver (first_name/last_name
// requis sur le nouveau schéma) et de l'inscription (session_registrations).
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
  photoFile: null,
};

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

export function previewPhoto(input) {
  const file = input.files[0];
  if (!file) return;
  regState.photoFile = file;
  const reader = new FileReader();
  reader.onload = (e) => {
    document.getElementById('photo-content').innerHTML =
      '<img src="' + e.target.result + '" class="photo-preview"/><div class="photo-txt">Appuie pour changer</div>';
  };
  reader.readAsDataURL(file);
}

// Compresse et redimensionne l'image avant upload (max 800px, qualité 0.82)
function compressImage(file) {
  return new Promise((resolve) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const MAX = 800;
      let w = img.width, h = img.height;
      if (w > MAX || h > MAX) {
        if (w > h) { h = Math.round((h * MAX) / w); w = MAX; }
        else { w = Math.round((w * MAX) / h); h = MAX; }
      }
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      canvas.getContext('2d').drawImage(img, 0, 0, w, h);
      URL.revokeObjectURL(url);
      canvas.toBlob((blob) => resolve(blob || file), 'image/jpeg', 0.82);
    };
    img.onerror = () => resolve(file);
    img.src = url;
  });
}

export function showMsg(msg, type) {
  const el = document.getElementById('msg');
  if (!el) return;
  el.textContent = msg;
  el.className = 'msg ' + type;
}

export async function submitForm() {
  if (!regState.sessionId) { showMsg('Session invalide.', 'err'); return; }
  const name = document.getElementById('inp-name').value.trim();
  if (!name) { showMsg('Entre ton prénom.', 'err'); return; }
  const btn = document.getElementById('btn-submit');
  btn.disabled = true; btn.textContent = 'Inscription en cours…';
  try {
    let photoUrl = null;
    let driverId = null;
    if (regState.photoFile) {
      btn.textContent = 'Upload photo…';
      try {
        const compressed = await compressImage(regState.photoFile);
        const path = 'photos/' + Date.now() + '.jpg';
        const { error: upErr } = await db.storage
          .from('driver-photos')
          .upload(path, compressed, { upsert: true, contentType: 'image/jpeg' });
        if (upErr) {
          console.warn('Upload photo echoue:', upErr.message);
          showMsg('Photo non sauvegardée (' + upErr.message + ') — inscription sans photo.', 'warn');
          await new Promise((r) => setTimeout(r, 2000));
        } else {
          const { data: urlData } = db.storage.from('driver-photos').getPublicUrl(path);
          photoUrl = urlData.publicUrl;
        }
      } catch (imgErr) {
        console.warn('Erreur compression:', imgErr);
      }
      btn.textContent = 'Inscription en cours…';
    }
    if (photoUrl) {
      // La table drivers exige first_name/last_name (NOT NULL) sur le nouveau schéma.
      // Le formulaire ne collecte qu'un seul champ "nom" — on le découpe simplement.
      const nameParts = name.split(/\s+/);
      const firstName = nameParts[0] || name;
      const lastName = nameParts.slice(1).join(' ') || '';
      const { data: drv, error: drvErr } = await db
        .from('drivers')
        .insert({ first_name: firstName, last_name: lastName, photo_url: photoUrl })
        .select('id')
        .single();
      if (drv) driverId = drv.id;
      else console.warn('Erreur création driver:', drvErr?.message);
    }
    const { error } = await db.from('session_registrations').insert({
      session_id: regState.sessionId,
      display_name: name,
      nationality: regState.selectedNat,
      driver_id: driverId,
      is_unknown: false,
    });
    if (error) throw error;
    document.getElementById('form-card').style.display = 'none';
    document.getElementById('success-card').style.display = 'block';
    document.getElementById('success-name').textContent = 'Bonne course ' + name + ' !';
  } catch (e) {
    showMsg('Erreur: ' + e.message, 'err');
    btn.disabled = false; btn.textContent = "S'inscrire à la course 🏁";
  }
}
