/* --------------------------------------------------------------------------
   qr.js — encodeur QR minimal, hors-ligne, sans dépendance.
   Mode octet, niveau de correction M, versions 1 à 9 (jusqu'à 179 octets).
   Suffisant pour une URL de circuit ; au-delà on lève une erreur explicite.
   -------------------------------------------------------------------------- */

/* Tables par version, niveau M : [codewords totaux, ec par bloc, nb de blocs] */
const VER = {
  1: [26, 10, 1],   2: [44, 16, 1],   3: [70, 26, 1],   4: [100, 18, 2],
  5: [134, 24, 2],  6: [172, 16, 4],  7: [196, 18, 4],  8: [242, 22, 4],
  9: [292, 22, 5],
};
const ALIGN = {
  1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34],
  7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46],
};
/* Information de version (BCH 18 bits), obligatoire a partir de la version 7. */
const VINFO = { 7: 0x07c94, 8: 0x085bc, 9: 0x09a99 };

/* --- GF(256), polynôme générateur 0x11d --- */
const EXP = new Uint8Array(512), LOG = new Uint8Array(256);
(function () {
  let x = 1;
  for (let i = 0; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 256) x ^= 0x11d; }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();
const gmul = (a, b) => (a === 0 || b === 0) ? 0 : EXP[LOG[a] + LOG[b]];

function rsGen(n) {
  let p = [1];
  for (let i = 0; i < n; i++) {
    const q = [1, EXP[i]], r = new Array(p.length + 1).fill(0);
    for (let a = 0; a < p.length; a++) for (let b = 0; b < 2; b++) r[a + b] ^= gmul(p[a], q[b]);
    p = r;
  }
  return p;
}

function rsEncode(data, ecLen) {
  const gen = rsGen(ecLen), res = new Array(ecLen).fill(0);
  for (const d of data) {
    const f = d ^ res[0];
    res.shift(); res.push(0);
    if (f !== 0) for (let i = 0; i < ecLen; i++) res[i] ^= gmul(gen[i + 1], f);
  }
  return res;
}

/* --- Encodage des données --- */
function encodeData(bytes, version) {
  const [total, ecPerBlock, blocks] = VER[version];
  const dataCw = total - ecPerBlock * blocks;
  const bits = [];
  const push = (v, n) => { for (let i = n - 1; i >= 0; i--) bits.push((v >> i) & 1); };
  push(4, 4);                                    // mode octet
  push(bytes.length, 8);                         // compteur : 8 bits pour v1-9
  for (const b of bytes) push(b, 8);
  for (let i = 0; i < 4 && bits.length < dataCw * 8; i++) bits.push(0);
  while (bits.length % 8) bits.push(0);
  const cw = [];
  for (let i = 0; i < bits.length; i += 8) {
    let v = 0; for (let j = 0; j < 8; j++) v = (v << 1) | bits[i + j];
    cw.push(v);
  }
  const PAD = [0xec, 0x11];
  let k = 0;
  while (cw.length < dataCw) cw.push(PAD[k++ % 2]);

  /* Decoupage en blocs : les (dataCw % blocks) derniers blocs ont un codeword de plus. */
  const short = Math.floor(dataCw / blocks), nLong = dataCw % blocks;
  const dBlocks = [], eBlocks = [];
  let off = 0;
  for (let i = 0; i < blocks; i++) {
    const len = short + (i >= blocks - nLong ? 1 : 0);
    const d = cw.slice(off, off + len); off += len;
    dBlocks.push(d);
    eBlocks.push(rsEncode(d, ecPerBlock));
  }
  const out = [];
  const maxLen = short + (nLong ? 1 : 0);
  for (let i = 0; i < maxLen; i++) for (const b of dBlocks) if (i < b.length) out.push(b[i]);
  for (let i = 0; i < ecPerBlock; i++) for (const b of eBlocks) out.push(b[i]);
  return out;
}

/* --- Matrice --- */
function buildMatrix(version, codewords) {
  const size = 17 + version * 4;
  const m = Array.from({ length: size }, () => new Array(size).fill(null));
  const set = (r, c, v) => { if (r >= 0 && c >= 0 && r < size && c < size) m[r][c] = v; };

  const finder = (r, c) => {
    for (let dr = -1; dr <= 7; dr++) for (let dc = -1; dc <= 7; dc++) {
      const rr = r + dr, cc = c + dc;
      if (rr < 0 || cc < 0 || rr >= size || cc >= size) continue;
      const inRing = dr >= 0 && dr <= 6 && dc >= 0 && dc <= 6 &&
        (dr === 0 || dr === 6 || dc === 0 || dc === 6 || (dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4));
      set(rr, cc, inRing ? 1 : 0);
    }
  };
  finder(0, 0); finder(0, size - 7); finder(size - 7, 0);

  for (let i = 8; i < size - 8; i++) { set(6, i, i % 2 === 0 ? 1 : 0); set(i, 6, i % 2 === 0 ? 1 : 0); }

  const ap = ALIGN[version];
  for (const r of ap) for (const c of ap) {
    if ((r < 9 && c < 9) || (r < 9 && c > size - 10) || (r > size - 10 && c < 9)) continue;
    for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++)
      set(r + dr, c + dc, (Math.abs(dr) === 2 || Math.abs(dc) === 2 || (dr === 0 && dc === 0)) ? 1 : 0);
  }

  set(size - 8, 8, 1); // module noir permanent

  /* Réserve des zones d'information de format */
  const fmtRes = [];
  for (let i = 0; i <= 8; i++) { if (i !== 6) fmtRes.push([8, i], [i, 8]); }
  for (let i = 0; i < 8; i++) fmtRes.push([8, size - 1 - i]);
  for (let i = 0; i < 7; i++) fmtRes.push([size - 1 - i, 8]);
  for (const [r, c] of fmtRes) if (m[r][c] === null) m[r][c] = 'F';

  /* Information de version (v7+) : deux blocs 6x3 pres des chercheurs. */
  if (VINFO[version] !== undefined) {
    const vi = VINFO[version];
    for (let i = 0; i < 18; i++) {
      const bit = (vi >> i) & 1, a = Math.floor(i / 3), b = size - 11 + (i % 3);
      m[a][b] = bit; m[b][a] = bit;
    }
  }

  /* Placement des données en zigzag */
  const bits = [];
  for (const b of codewords) for (let i = 7; i >= 0; i--) bits.push((b >> i) & 1);
  let idx = 0, up = true;
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col--;
    for (let n = 0; n < size; n++) {
      const row = up ? size - 1 - n : n;
      for (const c of [col, col - 1]) {
        if (m[row][c] === null) m[row][c] = idx < bits.length ? bits[idx++] : 0;
      }
    }
    up = !up;
  }
  for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) if (m[r][c] === 'F') m[r][c] = null;
  return m;
}

const MASKS = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

function isFunction(version, size, r, c) {
  if (r < 9 && c < 9) return true;
  if (r < 9 && c >= size - 8) return true;
  if (r >= size - 8 && c < 9) return true;
  if (r === 6 || c === 6) return true;
  if (VINFO[version] !== undefined &&
      ((r < 6 && c >= size - 11 && c < size - 8) || (c < 6 && r >= size - 11 && r < size - 8))) return true;
  const ap = ALIGN[version];
  for (const ar of ap) for (const ac of ap) {
    if ((ar < 9 && ac < 9) || (ar < 9 && ac > size - 10) || (ar > size - 10 && ac < 9)) continue;
    if (Math.abs(r - ar) <= 2 && Math.abs(c - ac) <= 2) return true;
  }
  return false;
}

function fmtBits(mask) {
  const ec = 0b00; // niveau M
  let v = (ec << 3) | mask;
  let d = v << 10;
  for (let i = 14; i >= 10; i--) if ((d >> i) & 1) d ^= 0b10100110111 << (i - 10);
  return ((v << 10) | d) ^ 0b101010000010010;
}

function penalty(m) {
  const n = m.length; let p = 0;
  const run = (get) => {
    for (let a = 0; a < n; a++) {
      let last = -1, len = 0;
      for (let b = 0; b < n; b++) {
        const v = get(a, b);
        if (v === last) { len++; if (len === 5) p += 3; else if (len > 5) p += 1; }
        else { last = v; len = 1; }
      }
    }
  };
  run((a, b) => m[a][b]); run((a, b) => m[b][a]);
  for (let r = 0; r < n - 1; r++) for (let c = 0; c < n - 1; c++)
    if (m[r][c] === m[r][c + 1] && m[r][c] === m[r + 1][c] && m[r][c] === m[r + 1][c + 1]) p += 3;
  let dark = 0;
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) dark += m[r][c];
  p += Math.floor(Math.abs(dark * 100 / (n * n) - 50) / 5) * 10;
  return p;
}

/* Renvoie une matrice booléenne (true = module sombre). */
export function qrMatrix(text) {
  const bytes = Array.from(new TextEncoder().encode(String(text)));
  let version = 0;
  for (let v = 1; v <= 9; v++) {
    const [total, ec, blocks] = VER[v];
    const overhead = 2;   // 4 bits de mode + compteur 8 bits, arrondi a l'octet
    if (bytes.length + overhead <= total - ec * blocks) { version = v; break; }
  }
  if (!version) throw new Error('QR : URL trop longue (179 caracteres maximum).');

  const cw = encodeData(bytes, version);
  const base = buildMatrix(version, cw);
  const size = base.length;

  let best = null, bestP = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    const m = base.map(row => row.slice());
    for (let r = 0; r < size; r++) for (let c = 0; c < size; c++)
      if (!isFunction(version, size, r, c) && MASKS[mask](r, c)) m[r][c] ^= 1;
    const f = fmtBits(mask);
    for (let i = 0; i < 15; i++) {
      const bit = (f >> i) & 1;
      if (i < 6) m[i][8] = bit;
      else if (i < 8) m[i + 1][8] = bit;
      else m[size - 15 + i][8] = bit;
      if (i < 8) m[8][size - 1 - i] = bit;
      else if (i < 9) m[8][15 - i] = bit;
      else m[8][14 - i] = bit;
    }
    m[size - 8][8] = 1;
    const p = penalty(m);
    if (p < bestP) { bestP = p; best = m; }
  }
  return best;
}

/* SVG carré, quiet zone de 4 modules, fond blanc — scannable. */
export function qrSVG(text, fg = '#0a0a0a', bg = '#ffffff') {
  const m = qrMatrix(text), n = m.length, q = 4, T = n + q * 2;
  let d = '';
  for (let r = 0; r < n; r++) {
    let c = 0;
    while (c < n) {
      if (!m[r][c]) { c++; continue; }
      let w = 0;
      while (c + w < n && m[r][c + w]) w++;
      d += `M${c + q} ${r + q}h${w}v1h-${w}z`;
      c += w;
    }
  }
  return `<svg viewBox="0 0 ${T} ${T}" width="100%" height="100%" preserveAspectRatio="xMidYMid meet" shape-rendering="crispEdges">` +
    `<rect width="${T}" height="${T}" fill="${bg}"/><path d="${d}" fill="${fg}"/></svg>`;
}

/* Rendu canvas — necessaire pour produire un PNG telechargeable et imprimable.
   Le SVG precedent portait width/height="100%" : ouvert seul (hors page HTML) il
   n'avait aucune dimension intrinseque et s'affichait vide dans l'Apercu macOS,
   Photos ou Word. Un PNG s'ouvre, s'imprime et se colle partout.
   L'echelle est un entier : sans cela les modules tombent entre deux pixels et
   le QR devient flou, donc plus lent voire impossible a scanner. */
export function qrCanvas(text, px = 1024, fg = '#000000', bg = '#ffffff') {
  const m = qrMatrix(text), n = m.length, q = 4, T = n + q * 2;
  const scale = Math.max(1, Math.round(px / T));
  const size = T * scale;
  const cv = document.createElement('canvas');
  cv.width = size; cv.height = size;
  const ctx = cv.getContext('2d');
  ctx.fillStyle = bg; ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = fg;
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (m[r][c]) ctx.fillRect((c + q) * scale, (r + q) * scale, scale, scale);
    }
  }
  return cv;
}
