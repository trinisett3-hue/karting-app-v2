// Module Paramètres — préférences globales (karts par défaut, tours, unité de temps),
// numéros de karts (flotte), apparence des résultats publics (thème + avatars kart), et
// activation des secteurs.
//
// L'ancien système de "casques" à couleurs aléatoires a été remplacé par les avatars kart
// (module kart-avatar.js) : chaque pilote reçoit automatiquement l'avatar de son kart, le
// numéro affiché est celui du kart et la couleur est propre à chaque numéro — rien à
// configurer manuellement. Cet onglet montre la flotte et un aperçu en direct de la page
// de résultats (thème + avatars).
import { db } from '../lib/supabase.js';
import { state, setPrefs, markPrefsDirty } from '../state.js';
import { showMsg } from './ui.js';
import { toggleSectorsField } from './results.js';
import { kartAvatarSVG } from './kart-avatar.js';

// Couleurs des 3 thèmes (identiques à results.html) — pour l'aperçu en direct, l'admin
// n'étant pas lui-même thémé.
const THEME_COLORS = {
  classic: { bg: '#050608', surf: '#0d0f14', mut: '#7a7d8a', acc: '#ff2a2a', text: '#f4f5f8', p2: 'rgba(255,255,255,.28)', p3: 'rgba(184,134,90,.6)' },
  neon:    { bg: '#060810', surf: '#0b0e18', mut: '#6a7a9a', acc: '#00d4ff', text: '#f0f4ff', p2: 'rgba(255,0,128,.5)',  p3: 'rgba(255,0,128,.3)' },
  carbon:  { bg: '#111214', surf: '#181a1e', mut: '#8a8880', acc: '#c9a84c', text: '#f5f0e8', p2: 'rgba(180,180,180,.35)', p3: 'rgba(150,110,70,.5)' },
};

export function updateDefaultsInfo() {
  const el = document.getElementById('s-defaults-info');
  const kartsWrap = document.getElementById('s-karts-wrap');
  if (!el) return;
  if (state.prefs.karts_locked) {
    kartsWrap.style.display = 'none';
    el.textContent =
      'Valeurs par defaut: ' + state.prefs.default_karts + ' karts max' + (state.prefs.laps_enabled ? ', ' + state.prefs.default_laps + ' tours' : '') + ' (modifiable dans Parametres).';
  } else {
    kartsWrap.style.display = 'block';
    document.getElementById('s-karts').value = state.prefs.default_karts;
    el.textContent = state.prefs.laps_enabled ? state.prefs.default_laps + ' tours par defaut (modifiable dans Parametres).' : '';
  }
}

export async function loadPrefs() {
  try {
    const { data } = await db.from('app_settings').select('*').eq('key', 'global').maybeSingle();
    if (data && data.value) {
      setPrefs(data.value);
    }
  } catch (e) {
    // pas de préférences enregistrées pour l'instant — on garde les valeurs par défaut
  }
  if (!Array.isArray(state.prefs.kart_numbers)) state.prefs.kart_numbers = [];
  state.prefs.sectors_enabled = !!state.prefs.sectors_enabled;
  state.prefs.sector_count = Number(state.prefs.sector_count || 3);
  state.prefs.results_theme = state.prefs.results_theme || 'classic';

  renderLogoPreview();

  document.getElementById('pref-karts').value = state.prefs.default_karts;
  document.getElementById('pref-laps').value = state.prefs.default_laps;
  document.getElementById('pref-time-unit').value = state.prefs.time_unit;
  document.getElementById('pref-laps-enabled').checked = state.prefs.laps_enabled;
  document.getElementById('pref-karts-locked').checked = state.prefs.karts_locked;
  toggleLapsField();
  renderKartNumbersList();

  const sel = document.getElementById('pref-results-theme');
  if (sel) sel.value = state.prefs.results_theme;
  document.querySelectorAll('.theme-option-row').forEach((r) => {
    r.style.borderColor = r.dataset.themeVal === state.prefs.results_theme ? 'var(--acc)' : 'var(--bord)';
  });
  renderResultsPreview();
  renderKartAvatarGallery();

  const on = document.getElementById('pref-sectors-enabled');
  const n = document.getElementById('pref-sector-count');
  if (on) on.checked = state.prefs.sectors_enabled;
  if (n) n.value = String(state.prefs.sector_count);
  toggleSectorsField();
}

export function renderKartNumbersList() {
  const el = document.getElementById('kart-numbers-list');
  if (!el) return;
  const nums = (state.prefs.kart_numbers || []).slice().sort((a, b) => a - b);
  if (!nums.length) {
    el.innerHTML = '<div class="empty" style="grid-column:1/-1;padding:14px">Aucun numero defini. Utilise "Generer 1 a N" ou ajoute-les un par un.</div>';
    return;
  }
  el.innerHTML = nums.map((n) => '<div class="kart-pastille free" style="cursor:pointer" title="Retirer" onclick="removeKartNumber(' + n + ')">' + n + '</div>').join('');
}

export function addKartNumber() {
  const inp = document.getElementById('pref-kart-num-input');
  const v = parseInt(inp.value);
  if (isNaN(v) || v < 1) {
    showMsg('msg-kart-numbers', 'Numero invalide.', 'err');
    return;
  }
  if (!Array.isArray(state.prefs.kart_numbers)) state.prefs.kart_numbers = [];
  if (state.prefs.kart_numbers.includes(v)) {
    showMsg('msg-kart-numbers', 'Ce numero existe deja.', 'err');
    return;
  }
  state.prefs.kart_numbers.push(v);
  inp.value = '';
  renderKartNumbersList();
  renderKartAvatarGallery();
  markPrefsDirty();
  showMsg('msg-kart-numbers', 'Numero ' + v + ' ajoute. Clique Enregistrer pour sauvegarder.', 'ok');
}

export function removeKartNumber(n) {
  state.prefs.kart_numbers = (state.prefs.kart_numbers || []).filter((x) => x !== n);
  renderKartNumbersList();
  renderKartAvatarGallery();
  markPrefsDirty();
  showMsg('msg-kart-numbers', 'Numero ' + n + ' retire. Clique Enregistrer pour sauvegarder.', 'ok');
}

export function autoFillKartNumbers() {
  const max = parseInt(document.getElementById('pref-karts').value) || state.prefs.default_karts || 12;
  state.prefs.kart_numbers = Array.from({ length: max }, (_, i) => i + 1);
  renderKartNumbersList();
  renderKartAvatarGallery();
  markPrefsDirty();
  showMsg('msg-kart-numbers', 'Numeros 1 a ' + max + ' generes. Clique Enregistrer pour sauvegarder.', 'ok');
}

export function toggleLapsField() {
  const enabled = document.getElementById('pref-laps-enabled').checked;
  document.getElementById('pref-laps-wrap').style.display = enabled ? 'block' : 'none';
}

// --- Logo du circuit ------------------------------------------------------------------------
// Un seul logo par organisation pour l'instant (colonne app_settings.value.logo_url,
// bucket Storage "org-logos", upload réservé à l'admin connecté). Affiché sur
// results.html (voir public-results.js > initTheme). Redimensionné côté client en PNG
// (garde la transparence) avant upload, comme les photos pilotes sur register.html.
function compressLogo(file) {
  return new Promise((resolve) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const MAX = 400;
      let w = img.width, h = img.height;
      if (w > MAX || h > MAX) {
        if (w > h) { h = Math.round((h * MAX) / w); w = MAX; }
        else { w = Math.round((w * MAX) / h); h = MAX; }
      }
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      canvas.getContext('2d').drawImage(img, 0, 0, w, h);
      URL.revokeObjectURL(url);
      canvas.toBlob((blob) => resolve(blob || file), 'image/png');
    };
    img.onerror = () => resolve(file);
    img.src = url;
  });
}

export function renderLogoPreview() {
  const wrap = document.getElementById('pref-logo-preview-wrap');
  const img = document.getElementById('pref-logo-preview');
  const removeBtn = document.getElementById('pref-logo-remove-btn');
  if (!wrap || !img) return;
  if (state.prefs.logo_url) {
    img.src = state.prefs.logo_url;
    wrap.style.display = 'flex';
    if (removeBtn) removeBtn.style.display = 'inline-flex';
  } else {
    wrap.style.display = 'none';
    if (removeBtn) removeBtn.style.display = 'none';
  }
}

export async function uploadLogo(input) {
  const file = input.files && input.files[0];
  if (!file) return;
  const msgId = 'msg-logo';
  try {
    showMsg(msgId, 'Upload du logo…', 'ok');
    const compressed = await compressLogo(file);
    const path = 'logos/' + Date.now() + '.png';
    const { error: upErr } = await db.storage.from('org-logos').upload(path, compressed, {
      upsert: true,
      contentType: 'image/png',
    });
    if (upErr) {
      showMsg(msgId, 'Upload échoué (' + upErr.message + ').', 'err');
      return;
    }
    const { data: urlData } = db.storage.from('org-logos').getPublicUrl(path);
    state.prefs.logo_url = urlData.publicUrl;
    renderLogoPreview();
    markPrefsDirty();
    showMsg(msgId, 'Logo uploadé. Clique Enregistrer pour le publier.', 'ok');
  } catch (e) {
    showMsg(msgId, 'Erreur: ' + e.message, 'err');
  } finally {
    input.value = '';
  }
}

export function removeLogo() {
  state.prefs.logo_url = null;
  renderLogoPreview();
  markPrefsDirty();
  showMsg('msg-logo', 'Logo retiré. Clique Enregistrer pour confirmer.', 'ok');
}

export function switchAppearanceSubtab(tab) {
  document.querySelectorAll('.subtab-btn').forEach((b) => {
    const on = b.dataset.subtab === tab;
    b.classList.toggle('active', on);
    b.style.color = on ? 'var(--txt)' : 'var(--mut)';
    b.style.borderBottomColor = on ? 'var(--acc)' : 'transparent';
  });
  const t = document.getElementById('appearance-subtab-theme');
  const a = document.getElementById('appearance-subtab-avatars');
  if (t) t.style.display = tab === 'theme' ? 'block' : 'none';
  if (a) a.style.display = tab === 'avatars' ? 'block' : 'none';
  if (tab === 'avatars') renderKartAvatarGallery();
}

export function selectResultsTheme(val) {
  const sel = document.getElementById('pref-results-theme');
  if (sel) sel.value = val;
  document.querySelectorAll('.theme-option-row').forEach((r) => {
    r.style.borderColor = r.dataset.themeVal === val ? 'var(--acc)' : 'var(--bord)';
  });
  renderResultsPreview(val);
  markPrefsDirty();
}

// Aperçu en direct de la PAGE 1 des résultats (podium + top) avec le thème choisi et les
// vrais avatars kart — rendu dans la zone de droite des Paramètres.
export function renderResultsPreview(theme) {
  const box = document.getElementById('results-live-preview');
  if (!box) return;
  const t = THEME_COLORS[theme || document.getElementById('pref-results-theme')?.value || state.prefs.results_theme || 'classic'] || THEME_COLORS.classic;
  const podium = [
    { pos: 2, kart: 4, name: 'PILOTE 2', gap: '+2.197', border: t.p2 },
    { pos: 1, kart: 1, name: 'PILOTE 1', gap: '1:02.345', border: t.acc, first: true },
    { pos: 3, kart: 7, name: 'PILOTE 3', gap: '+7.131', border: t.p3 },
  ];
  const rows = [
    { pos: 4, kart: 9, name: 'PILOTE 4', gap: '+9.4' },
    { pos: 5, kart: 2, name: 'PILOTE 5', gap: '+12.1' },
  ];
  const av = (k) => `<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center">${kartAvatarSVG(k)}</div>`;
  const podHTML = podium.map((d) => `
    <div style="display:flex;flex-direction:column;background:${t.surf};border:1px solid ${d.border};border-radius:8px;overflow:hidden;${d.first ? 'box-shadow:0 0 16px ' + t.acc + '55;' : 'margin-top:14px;'}">
      <div style="position:relative;flex:1;min-height:${d.first ? '92' : '74'}px;display:flex;align-items:center;justify-content:center;padding:6px">
        <span style="position:absolute;top:2px;left:5px;font-weight:900;font-style:italic;font-size:${d.first ? 26 : 20}px;color:${d.first ? t.acc : t.mut}">${d.pos}</span>
        ${av(d.kart)}
      </div>
      <div style="background:linear-gradient(to top,rgba(0,0,0,.85),transparent);padding:5px 6px">
        <div style="font-weight:900;font-style:italic;font-size:11px;color:${t.text}">${d.name}</div>
        <div style="display:flex;justify-content:space-between;align-items:center;margin-top:2px">
          <span style="font-size:8px;color:${t.mut}">KART ${d.kart}</span>
          <span style="font-size:8px;font-weight:800;color:#fff;background:${t.acc};padding:1px 5px;border-radius:4px">${d.gap}</span>
        </div>
      </div>
    </div>`).join('');
  const rowsHTML = rows.map((d) => `
    <div style="display:grid;grid-template-columns:20px 26px 1fr auto;gap:7px;align-items:center;padding:5px 8px;border-top:1px solid rgba(255,255,255,.06)">
      <span style="font-weight:900;font-style:italic;font-size:13px;color:${t.mut}">${d.pos}</span>
      <div style="width:26px;height:26px;border-radius:50%;overflow:hidden;background:${t.bg};display:flex;align-items:center;justify-content:center">${kartAvatarSVG(d.kart)}</div>
      <div><div style="font-weight:800;font-style:italic;font-size:11px;color:${t.text}">${d.name}</div><div style="font-size:8px;color:${t.mut}">KART ${d.kart}</div></div>
      <span style="font-size:9px;font-weight:800;color:${t.text};background:rgba(255,255,255,.08);padding:2px 6px;border-radius:4px">${d.gap}</span>
    </div>`).join('');
  box.style.cssText = `background:${t.bg};border:1px solid ${t.acc}44;border-radius:12px;padding:12px;box-shadow:inset 0 0 40px ${t.acc}14`;
  box.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;border:1px solid ${t.acc}66;background:${t.surf};padding:8px 10px;border-radius:6px;margin-bottom:10px">
      <div><div style="font-weight:900;font-size:14px;text-transform:uppercase;color:${t.text}">Circuit de Trinisette</div><div style="font-size:8px;color:${t.mut};margin-top:1px">SESSION DU JOUR · APERÇU</div></div>
      <div style="color:${t.acc};font-size:18px;font-weight:900;font-style:italic">PODIUM</div>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1.15fr 1fr;gap:6px;align-items:end;margin-bottom:10px">${podHTML}</div>
    <div style="background:${t.surf};border:1px solid rgba(255,255,255,.08);border-radius:6px;overflow:hidden">${rowsHTML}</div>
    <div style="margin-top:8px;font-size:8px;color:${t.mut};text-transform:uppercase;letter-spacing:.08em">Aperçu fidèle — chaque pilote affiche l'avatar de son kart</div>`;
}

// Galerie des avatars de la flotte (numéros de karts configurés, sinon 1→défaut).
export function renderKartAvatarGallery() {
  const wrap = document.getElementById('kart-avatars-gallery');
  if (!wrap) return;
  let nums = (state.prefs.kart_numbers || []).slice().sort((a, b) => a - b);
  if (!nums.length) {
    const max = Math.min(24, Number(state.prefs.default_karts) || 12);
    nums = Array.from({ length: max }, (_, i) => i + 1);
  }
  wrap.innerHTML = nums.map((n) => `
    <div style="background:var(--surf2);border:1px solid var(--bord);border-radius:10px;padding:8px 4px;text-align:center">
      <div style="width:52px;height:54px;margin:0 auto">${kartAvatarSVG(n)}</div>
      <div style="font-size:10px;font-weight:700;color:var(--mut);margin-top:4px">KART ${n}</div>
    </div>`).join('');
}

export async function savePrefs() {
  const karts = parseInt(document.getElementById('pref-karts').value) || 12;
  const laps = parseInt(document.getElementById('pref-laps').value) || 5;
  const unit = document.getElementById('pref-time-unit').value;
  const lapsEnabled = document.getElementById('pref-laps-enabled').checked;
  const kartsLocked = document.getElementById('pref-karts-locked').checked;
  setPrefs({
    default_karts: karts,
    default_laps: laps,
    time_unit: unit,
    laps_enabled: lapsEnabled,
    karts_locked: kartsLocked,
    kart_numbers: state.prefs.kart_numbers || [],
    sectors_enabled: !!document.getElementById('pref-sectors-enabled')?.checked,
    sector_count: Number(document.getElementById('pref-sector-count')?.value || 3),
    results_theme: document.getElementById('pref-results-theme')?.value || 'classic',
    logo_url: state.prefs.logo_url || null,
  });
  // Nettoyage de l'ancien système d'avatars (casques) s'il traîne encore dans les prefs.
  delete state.prefs.helmet_choice;
  delete state.prefs.helmet_colors;
  try {
    await db.from('app_settings').upsert({ key: 'global', value: state.prefs });
    showMsg('msg-prefs', 'Parametres enregistres !', 'ok');
    showMsg('msg-kart-numbers', 'Numeros de karts enregistres !', 'ok');
    updateDefaultsInfo();
    state.prefsDirty = false;
  } catch (e) {
    showMsg('msg-prefs', 'Erreur: ' + e.message, 'err');
  }
}

export function populateTimeSelect() {
  const sel = document.getElementById('s-time');
  let opts = '';
  for (let h = 8; h <= 22; h++) {
    for (let m = 0; m < 60; m += 30) {
      const hh = String(h).padStart(2, '0');
      const mm = String(m).padStart(2, '0');
      opts += '<option value="' + hh + ':' + mm + '">' + hh + 'h' + mm + '</option>';
    }
  }
  sel.innerHTML = opts;
  const now = new Date();
  const roundedMin = now.getMinutes() < 30 ? '00' : '30';
  const cur = String(now.getHours()).padStart(2, '0') + ':' + roundedMin;
  sel.value = cur;
}
