// Module Paramètres — préférences globales (karts par défaut, tours, unité de temps),
// numéros de karts personnalisés, apparence des résultats publics (thème + casque), et
// activation des secteurs. Repris depuis index.html (lignes 462-624 + le correctif
// "Trinisette" des lignes 1305-1320 qui ajoutait secteurs/thème à loadPrefs).
//
// Contrairement à l'original qui faisait un monkey-patch (`const __x = loadPrefs;
// loadPrefs = async function(){...}`), la logique secteurs/thème est ici fusionnée
// directement dans loadPrefs() — même résultat, plus lisible et sans piège d'ordre de
// chargement des scripts.
import { db } from '../lib/supabase.js';
import { state, setPrefs, markPrefsDirty } from '../state.js';
import { showMsg } from './ui.js';
import { toggleSectorsField } from './results.js';

let helmetColors = null;

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
  // Normalisation secteurs/thème (anciennement le patch "Trinisette" par-dessus loadPrefs).
  state.prefs.sectors_enabled = !!state.prefs.sectors_enabled;
  state.prefs.sector_count = Number(state.prefs.sector_count || 3);
  state.prefs.results_theme = state.prefs.results_theme || 'classic';

  document.getElementById('pref-karts').value = state.prefs.default_karts;
  document.getElementById('pref-laps').value = state.prefs.default_laps;
  document.getElementById('pref-time-unit').value = state.prefs.time_unit;
  document.getElementById('pref-laps-enabled').checked = state.prefs.laps_enabled;
  document.getElementById('pref-karts-locked').checked = state.prefs.karts_locked;
  toggleLapsField();
  renderKartNumbersList();

  const sel = document.getElementById('pref-results-theme');
  if (sel) {
    sel.value = state.prefs.results_theme;
    applyThemePreview(sel.value);
  }
  if (state.prefs.helmet_colors && Array.isArray(state.prefs.helmet_colors)) helmetColors = state.prefs.helmet_colors;
  const hc = document.getElementById('pref-helmet-choice');
  if (hc) hc.value = state.prefs.helmet_choice || 1;
  renderHelmetChoices();

  const on = document.getElementById('pref-sectors-enabled');
  const n = document.getElementById('pref-sector-count');
  const theme = document.getElementById('pref-results-theme');
  if (on) on.checked = state.prefs.sectors_enabled;
  if (n) n.value = String(state.prefs.sector_count);
  if (theme) theme.value = state.prefs.results_theme;
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
  markPrefsDirty();
  showMsg('msg-kart-numbers', 'Numero ' + v + ' ajoute. Clique Enregistrer pour sauvegarder.', 'ok');
}

export function removeKartNumber(n) {
  state.prefs.kart_numbers = (state.prefs.kart_numbers || []).filter((x) => x !== n);
  renderKartNumbersList();
  markPrefsDirty();
  showMsg('msg-kart-numbers', 'Numero ' + n + ' retire. Clique Enregistrer pour sauvegarder.', 'ok');
}

export function autoFillKartNumbers() {
  const max = parseInt(document.getElementById('pref-karts').value) || state.prefs.default_karts || 12;
  state.prefs.kart_numbers = Array.from({ length: max }, (_, i) => i + 1);
  renderKartNumbersList();
  markPrefsDirty();
  showMsg('msg-kart-numbers', 'Numeros 1 a ' + max + ' generes. Clique Enregistrer pour sauvegarder.', 'ok');
}

export function toggleLapsField() {
  const enabled = document.getElementById('pref-laps-enabled').checked;
  document.getElementById('pref-laps-wrap').style.display = enabled ? 'block' : 'none';
}

export function switchAppearanceSubtab(tab) {
  document.querySelectorAll('.subtab-btn').forEach((b) => {
    const on = b.dataset.subtab === tab;
    b.classList.toggle('active', on);
    b.style.color = on ? 'var(--txt)' : 'var(--mut)';
    b.style.borderBottomColor = on ? 'var(--acc)' : 'transparent';
  });
  const t = document.getElementById('appearance-subtab-theme');
  const c = document.getElementById('appearance-subtab-casque');
  if (t) t.style.display = tab === 'theme' ? 'flex' : 'none';
  if (c) c.style.display = tab === 'casque' ? 'flex' : 'none';
  if (tab === 'casque' && !helmetColors) regenerateHelmetColors();
}

export function selectResultsTheme(val) {
  const sel = document.getElementById('pref-results-theme');
  if (sel) sel.value = val;
  document.querySelectorAll('.theme-option-row').forEach((r) => {
    r.style.borderColor = r.dataset.themeVal === val ? 'var(--acc)' : 'var(--bord)';
  });
  applyThemePreview(val);
  markPrefsDirty();
}

export function applyThemePreview(val) {
  const box = document.getElementById('theme-preview-box');
  if (!box) return;
  const map = {
    classic: { bg: '#050608', surface: '#0d0f14', mut: '#7a7d8a', acc: '#ff2a2a', text: '#f4f5f8' },
    neon: { bg: '#060810', surface: '#0b0e18', mut: '#6a7a9a', acc: '#00d4ff', text: '#f0f4ff' },
    carbon: { bg: '#111214', surface: '#181a1e', mut: '#8a8880', acc: '#c9a84c', text: '#f5f0e8' },
  };
  const t = map[val] || map.classic;
  box.style.cssText = `flex:1;min-width:320px;min-height:310px;border-radius:12px;padding:14px;background:${t.bg};border:1px solid ${t.acc}55;position:relative;overflow:hidden;box-shadow:inset 0 0 32px ${t.acc}18;`;
  const inner = document.getElementById('theme-preview-inner');
  if (!inner) return;
  inner.innerHTML = `<div style="font-family:'Segoe UI',sans-serif;color:${t.text};height:100%;display:flex;flex-direction:column;gap:10px"><div style="display:flex;justify-content:space-between;align-items:center;border:1px solid ${t.acc}66;padding:9px 10px;background:${t.surface}"><div><div style="font-weight:900;font-size:15px;text-transform:uppercase">Circuit de Trinisette</div><div style="font-size:9px;color:${t.mut};margin-top:2px">21 JUILLET 2026 · SESSION DU JOUR</div></div><div style="color:${t.acc};font-size:20px;font-weight:900;font-style:italic">PODIUM</div></div><div style="display:grid;grid-template-columns:1fr 1.16fr 1fr;gap:7px;height:126px;align-items:end"><div style="height:84%;background:${t.surface};border:1px solid ${t.text}44;padding:8px;display:flex;flex-direction:column;justify-content:flex-end"><strong style="font-size:24px;color:${t.text}bb">2</strong><strong style="font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">PILOTE 2</strong><span style="font-size:9px;color:${t.mut}">KART 04</span></div><div style="height:100%;background:${t.surface};border:1px solid ${t.acc};box-shadow:0 0 18px ${t.acc}44;padding:8px;display:flex;flex-direction:column;justify-content:flex-end"><strong style="font-size:32px;color:${t.acc}">1</strong><strong style="font-size:14px">PILOTE 1</strong><span style="font-size:9px;color:${t.mut}">KART 12 · <b style="color:${t.acc}">1:02.345</b></span></div><div style="height:84%;background:${t.surface};border:1px solid ${t.acc}77;padding:8px;display:flex;flex-direction:column;justify-content:flex-end"><strong style="font-size:24px;color:#b8865a">3</strong><strong style="font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">PILOTE 3</strong><span style="font-size:9px;color:${t.mut}">KART 07</span></div></div><div style="background:${t.surface};border:1px solid ${t.text}22;overflow:hidden"><div style="display:grid;grid-template-columns:28px 1fr auto;gap:8px;align-items:center;padding:5px 8px;border-bottom:1px solid ${t.text}18;font-size:10px"><b style="color:${t.acc}">4</b><span>PILOTE 4 · KART 09</span><b style="color:${t.acc}">+0.842</b></div><div style="display:grid;grid-template-columns:28px 1fr auto;gap:8px;align-items:center;padding:5px 8px;font-size:10px"><b>5</b><span>PILOTE 5 · KART 02</span><b style="color:${t.mut}">+1.203</b></div></div><div style="margin-top:auto;font-size:9px;color:${t.mut};letter-spacing:.08em;text-transform:uppercase">Aperçu fidèle - podium et classement mobile</div></div>`;
}

function randColor() {
  const h = Math.floor(Math.random() * 360);
  const s = 60 + Math.floor(Math.random() * 30);
  const l = 45 + Math.floor(Math.random() * 15);
  return `hsl(${h} ${s}% ${l}%)`;
}

export function regenerateHelmetColors() {
  helmetColors = [
    [randColor(), randColor(), randColor()],
    [randColor(), randColor(), randColor()],
    [randColor(), randColor(), randColor()],
  ];
  renderHelmetChoices();
  markPrefsDirty();
}

export function renderHelmetChoices() {
  const wrap = document.getElementById('helmet-choices');
  if (!wrap) return;
  if (!helmetColors)
    helmetColors = [
      [randColor(), randColor(), randColor()],
      [randColor(), randColor(), randColor()],
      [randColor(), randColor(), randColor()],
    ];
  const selected = parseInt(document.getElementById('pref-helmet-choice')?.value || '1');
  wrap.innerHTML = helmetColors
    .map((cols, i) => {
      const n = i + 1;
      const sel = n === selected;
      return `<div onclick="chooseHelmet(${n})" style="cursor:pointer;padding:10px;border-radius:10px;border:2px solid ${sel ? 'var(--acc)' : 'var(--bord)'};text-align:center;width:100px">
      <svg viewBox="0 0 64 64" width="56" height="56"><path d="M32 4C16 4 8 20 8 34c0 14 8 22 24 22s24-8 24-22C56 20 48 4 32 4z" fill="${cols[0]}"/><path d="M8 34h48v8H8z" fill="${cols[1]}"/><circle cx="32" cy="36" r="12" fill="${cols[2]}"/></svg>
      <div style="font-size:11px;font-weight:700;margin-top:6px">Casque ${n}</div>
    </div>`;
    })
    .join('');
}

export function chooseHelmet(n) {
  document.getElementById('pref-helmet-choice').value = n;
  renderHelmetChoices();
  markPrefsDirty();
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
    helmet_choice: parseInt(document.getElementById('pref-helmet-choice')?.value || '1'),
    helmet_colors: helmetColors || state.prefs.helmet_colors || null,
  });
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
