/* =============================================================================
   TRINISETTE — Avatars "Signature" (plan Pro)
   -----------------------------------------------------------------------------
   Un avatar Signature est composé de TROIS COUCHES superposées, jamais d'un
   fichier unique :

     1. le FOND   — généré ici, à la volée, en SVG (aucun fichier)
     2. le SUJET  — un fichier du pack, chargé en <img loading="lazy">
     3. le NUMÉRO — un <svg><text> de surimpression (aucun fichier)

   Pourquoi trois couches et pas un fichier cuit ?
     - 9 styles de fond x 192 sujets = 1728 fichiers, et changer de fond dans les
       réglages rechargerait tout le pack. Fond généré = 192 fichiers, un seul
       jeu à déployer, changement de style instantané et gratuit.
     - le numéro de kart dépend du PILOTE, pas du schéma de couleur. Le cuire
       multiplierait encore les fichiers par le nombre de karts.

   Le numéro n'est PAS posé en texte HTML : il est posé dans un <svg> qui reprend
   à l'identique la viewBox, les coordonnées, la police et la taille que build.py
   utilisait quand le numéro était cuit dans le fichier. C'est le seul moyen
   d'obtenir exactement le même rendu sans dépendre de la hauteur de capitale
   réellement résolue par le navigateur (mesurée à 0.357 em ici, mais elle change
   selon qu'Arial Black est installée ou substituée). Avec un <text> SVG
   identique, la question ne se pose plus.

   Le halo blanc n'entoure jamais le numéro, y compris dans la variante outline :
   dans le fichier cuit le <text> était DANS le groupe filtré, mais comme il est
   entièrement intérieur à la silhouette du kart, dilater l'alpha de l'union ne
   crée aucun halo autour des chiffres.

   CE QUI A ÉTÉ VÉRIFIÉ (ab/ab.py + ab/ab2.py, 12 cas x 3 tailles 64/220/640 px,
   Chromium) : ZÉRO DIFFÉRENCE STRUCTURELLE entre la composition 3 couches et le
   fichier cuit. Mesure : on seuille l'écart pixel à > 24, puis on érode le masque
   de 2 px (deux MinFilter(3) successifs). Une frange d'anti-aliasing de 1 px
   disparaît à l'érosion ; un vrai écart de forme survit. Résultat : 0 pixel
   survivant sur les 36 comparaisons.

   Ce qui subsiste — et qui ne peut pas être supprimé : des franges de 1 px le
   long des contours et sur le bord des chiffres (delta max 225 sur un liseré
   d'un pixel). Cause : la référence cuite rasterise son <text> À L'INTÉRIEUR d'un
   <img>, alors que le runtime le rend en SVG inline vivant — deux chemins de
   rasterisation de police différents dans le même moteur. C'est la forme runtime
   qui part en production, donc c'est la référence qui est l'artefact, pas
   l'inverse. Ne pas réécrire ce paragraphe en « identique au pixel près » : ça
   ne l'est pas, et la nuance est le résultat de la mesure.

   Dépendances : ./kart-avatar.js (mapping numéro -> schéma, et repli classique).
   ========================================================================== */

import { kartAvatarSVG, schemeForKart, AVATAR_SCHEME_COUNT } from './kart-avatar.js';

/* -----------------------------------------------------------------------------
   1. CONSTANTES DU PACK
   Recopiées de pack/manifest.json. Elles sont inlinées et non chargées par fetch
   parce que signatureAvatarHTML() est SYNCHRONE : l'appli injecte son retour
   directement dans innerHTML, il n'y a aucun endroit où attendre une promesse.
   checkmodule.py vérifie à chaque build que ce bloc est identique au manifeste.
   -------------------------------------------------------------------------- */

export const SIGNATURE_PACK_VERSION = 1;
export const SIGNATURE_SCHEME_COUNT = 24;
export const SIGNATURE_KINDS = ['bust', 'helmet', 'kart', 'kartpilot'];

const HUES = {
  1: 0, 2: 210, 3: 40, 4: 145, 5: 275, 6: 190, 7: 20, 8: 320, 9: 95, 10: 255,
  11: 170, 12: 60, 13: 300, 14: 230, 15: 10, 16: 120, 17: 285, 18: 200, 19: 50,
  20: 335, 21: 160, 22: 265, 23: 80, 24: 220
};

const VIEWBOX = {
  bust: [-114, 89, 1354, 1354],
  helmet: [114, 79, 1024, 1024],
  kart: [36, -216, 1465, 1465],
  kartpilot: [13, -243, 1484, 1484]
};

/* Seuls kart et kartpilot portent un numéro : sur le buste et le casque il n'y a
   aucune surface plane où le poser sans inventer un élément de design. Les
   avatars buste/casque s'identifient par leur schéma de couleur seul. */
const NUMBER_ANCHOR = {
  kart: {
    viewBox: '36 -216 1465 1465', x: 929, y: 364, size: 104,
    family: 'Arial Black, Helvetica, sans-serif', weight: '900', fill: 'rgb(16,24,30)'
  },
  kartpilot: {
    viewBox: '13 -243 1484 1484', x: 937.5, y: 464, size: 112,
    family: 'Arial Black, Helvetica, sans-serif', weight: '900', fill: 'rgb(16,24,30)'
  }
};

/* -----------------------------------------------------------------------------
   2. FONDS — port ES module de bg.js (source unique de vérité partagée avec
   build.py et la page de preview). Le code est recopié à l'identique, y compris
   les .toFixed(), pour que la chaîne produite ici soit octet pour octet celle
   que build.py cuisait : c'est ce qui rend la vérification A/B possible.
   -------------------------------------------------------------------------- */

export const BG_STYLES = [
  { id: 'studio', label: 'Studio', family: 'Sobre', note: 'graphite neutre + halo couleur (recommandé)' },
  { id: 'flat', label: 'Aplat', family: 'Sobre', note: 'aplat teinté, lecture immédiate' },
  { id: 'duo', label: 'Duo', family: 'Sobre', note: 'bicolore diagonale nette, zéro dégradé' },
  { id: 'carbon', label: 'Carbone', family: 'Texture', note: 'tissage carbone très discret' },
  { id: 'halftone', label: 'Trame', family: 'Texture', note: 'trame de points façon affiche sport' },
  { id: 'ring', label: 'Anneau', family: 'Texture', note: 'disque + liseré accent' },
  { id: 'chevron', label: 'Chevron', family: 'Course', note: 'bandes diagonales de livrée' },
  { id: 'speed', label: 'Vitesse', family: 'Course', note: 'radial + rayures de vitesse' }
];

const BG_STYLE_IDS = BG_STYLES.map((s) => s.id);

function rgbOf(h, s, v) {
  h = ((h % 360) + 360) % 360 / 60;
  const c = v * s, x = c * (1 - Math.abs(h % 2 - 1)), m = v - c;
  let r = 0, g = 0, b = 0;
  if (h < 1) { r = c; g = x; } else if (h < 2) { r = x; g = c; }
  else if (h < 3) { g = c; b = x; } else if (h < 4) { g = x; b = c; }
  else if (h < 5) { r = x; b = c; } else { r = c; b = x; }
  return [r + m, g + m, b + m];
}
function hexOf(c) {
  const f = (n) => ('0' + Math.round(Math.max(0, Math.min(1, n)) * 255).toString(16)).slice(-2);
  return '#' + f(c[0]) + f(c[1]) + f(c[2]);
}
function lum(c) { return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; }

/* hsv() perceptuellement égalisée : sans elle le pilote rouge (h=0) rend un fond
   nettement plus sombre que le pilote jaune (h=40) à S/V identiques. On ramène
   chaque teinte à la luminance moyenne du cercle chromatique. */
const _hsvCache = new Map();
export function bgHsv(h, s, v) {
  const key = h + '|' + s + '|' + v;
  const hit = _hsvCache.get(key);
  if (hit !== undefined) return hit;
  let t = 0;
  for (let i = 0; i < 12; i++) t += lum(rgbOf(i * 30, s, v));
  t /= 12;
  let lo = 0, hi = 2.2, m;
  for (let k = 0; k < 20; k++) {
    m = (lo + hi) / 2;
    if (lum(rgbOf(h, s, Math.min(1, v * m))) < t) lo = m; else hi = m;
  }
  const out = hexOf(rgbOf(h, s, Math.min(1, v * (lo + hi) / 2)));
  _hsvCache.set(key, out);
  return out;
}

/* Retourne { defs, body } séparés : les <defs> sont mutualisés dans un <svg>
   caché unique du document (un dégradé par couple style+teinte, pas un par
   avatar), le body est répété dans chaque avatar. Les id sont DÉTERMINISTES
   (bg_<style>_<hue>) et jamais issus d'un compteur : deux appels pour le même
   avatar produisent exactement la même chaîne. */
function bgParts(hue, vb, style) {
  style = BG_STYLE_IDS.indexOf(style) >= 0 ? style : 'studio';
  const X = vb[0], Y = vb[1], W = vb[2], H = vb[3];
  const cx = X + W / 2, cy = Y + H / 2;
  const gid = 'bg_' + style + '_' + hue;

  const base = bgHsv(hue, 0.62, 0.20);
  const deep = bgHsv(hue, 0.66, 0.11);
  const light = bgHsv(hue, 0.55, 0.34);
  const accent = bgHsv(hue, 0.82, 0.54);
  const glow = bgHsv(hue, 0.74, 0.44);
  const duoC = bgHsv(hue, 0.55, 0.26);

  const d = ['<defs>'];
  d.push('<radialGradient id="' + gid + 'v" cx="50%" cy="42%" r="72%">' +
    '<stop offset="0%" stop-color="' + light + '"/>' +
    '<stop offset="62%" stop-color="' + base + '"/>' +
    '<stop offset="100%" stop-color="' + deep + '"/></radialGradient>');
  d.push('<linearGradient id="' + gid + 'd" x1="0" y1="0" x2="1" y2="1">' +
    '<stop offset="0%" stop-color="' + light + '"/>' +
    '<stop offset="100%" stop-color="' + deep + '"/></linearGradient>');
  d.push('<radialGradient id="' + gid + 'g" cx="50%" cy="80%" r="66%">' +
    '<stop offset="0%" stop-color="' + glow + '" stop-opacity="0.85"/>' +
    '<stop offset="55%" stop-color="' + glow + '" stop-opacity="0.32"/>' +
    '<stop offset="100%" stop-color="' + glow + '" stop-opacity="0"/></radialGradient>');
  d.push('</defs>');

  const p = [];
  const r = (fill, op) => '<rect x="' + X + '" y="' + Y + '" width="' + W + '" height="' + H +
    '" fill="' + fill + '"' + (op == null ? '' : ' opacity="' + op + '"') + '/>';
  /* Arc centré en bas, tracé sur un cercle de rayon rr*W : reste visible aussi
     bien dans une pastille ronde que dans un carré arrondi. deg = ouverture. */
  const arc = (rr, wd, col, deg) => {
    const R = W * rr, a = (deg || 120) * Math.PI / 360;
    const x1 = cx - R * Math.sin(a), y1 = cy + R * Math.cos(a);
    const x2 = cx + R * Math.sin(a), y2 = cy + R * Math.cos(a);
    return '<path d="M' + x1.toFixed(1) + ' ' + y1.toFixed(1) + ' A' + R.toFixed(1) +
      ' ' + R.toFixed(1) + ' 0 0 0 ' + x2.toFixed(1) + ' ' + y2.toFixed(1) +
      '" fill="none" stroke="' + col + '" stroke-width="' + (W * wd).toFixed(1) +
      '" stroke-linecap="round"/>';
  };

  if (style === 'studio') {
    // Graphite neutre : la couleur pilote n'arrive que par en dessous, comme un
    // éclairage de plateau TV. Aucun effet "généré", très lisible en petit.
    p.push(r('#191d24'));
    p.push('<rect x="' + X + '" y="' + Y + '" width="' + W + '" height="' + H +
      '" fill="url(#' + gid + 'g)"/>');
    /* Liseré bas : un arc tracé sur le cercle inscrit, PAS une barre en bas du
       carré (une barre à y=0.955H tombe hors de la pastille ronde et disparaît). */
    p.push(arc(0.455, 0.052, accent, 118));
  } else if (style === 'flat') {
    p.push(r(base));
    p.push('<ellipse cx="' + cx.toFixed(0) + '" cy="' + (cy - H * 0.06).toFixed(0) +
      '" rx="' + (W * 0.52).toFixed(0) + '" ry="' + (H * 0.52).toFixed(0) +
      '" fill="' + light + '" opacity="0.55"/>');
    p.push('<rect x="' + X + '" y="' + Y + '" width="' + W + '" height="' + H +
      '" fill="url(#' + gid + 'v)" opacity="0.35"/>');
  } else if (style === 'duo') {
    // Bicolore à arête franche : graphique, imprimable, zéro dégradé.
    p.push(r('#1a1f26'));
    p.push('<path d="M' + X + ' ' + (Y + H) + ' L' + (X + W * 0.02) + ' ' + (Y + H * 0.42) +
      ' L' + (X + W) + ' ' + (Y + H * 0.80) + ' L' + (X + W) + ' ' + (Y + H) +
      ' Z" fill="' + duoC + '"/>');
    p.push('<path d="M' + (X + W * 0.02) + ' ' + (Y + H * 0.42) + ' L' + (X + W) + ' ' +
      (Y + H * 0.80) + '" fill="none" stroke="' + accent + '" stroke-width="' +
      (W * 0.014).toFixed(1) + '"/>');
  } else if (style === 'carbon') {
    p.push(r(deep));
    p.push('<rect x="' + X + '" y="' + Y + '" width="' + W + '" height="' + H +
      '" fill="url(#' + gid + 'd)" opacity="0.75"/>');
    // tissage fin : à W/26 le damier se lisait comme un motif "échiquier"
    const s = W / 46, n = Math.floor(W / s) + 2;
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        if ((i + j) % 2) continue;
        p.push('<rect x="' + (X + i * s).toFixed(1) + '" y="' + (Y + j * s).toFixed(1) +
          '" width="' + s.toFixed(1) + '" height="' + s.toFixed(1) +
          '" fill="#ffffff" opacity="0.028"/>');
      }
    }
  } else if (style === 'halftone') {
    // Trame d'affiche : dense en bas, disparaît vers le sujet.
    p.push(r(base));
    p.push('<rect x="' + X + '" y="' + Y + '" width="' + W + '" height="' + H +
      '" fill="url(#' + gid + 'v)" opacity="0.5"/>');
    const st = W / 22, rows = 22;
    for (let jj = 0; jj < rows; jj++) {
      const t = jj / (rows - 1);
      const rad = st * 0.10 + st * 0.20 * t;
      const op = (0.05 + 0.16 * t).toFixed(3);
      for (let ii = 0; ii < 23; ii++) {
        const ox = (jj % 2) ? st / 2 : 0;
        p.push('<circle cx="' + (X + ox + ii * st).toFixed(1) + '" cy="' +
          (Y + st / 2 + jj * st).toFixed(1) + '" r="' + rad.toFixed(1) +
          '" fill="#000000" opacity="' + op + '"/>');
      }
    }
  } else if (style === 'ring') {
    // liseré ramené à l'intérieur : à r=0.455 il collait au bord de la pastille
    p.push(r(deep));
    p.push('<circle cx="' + cx.toFixed(0) + '" cy="' + cy.toFixed(0) + '" r="' +
      (W * 0.445).toFixed(0) + '" fill="' + base + '"/>');
    p.push('<circle cx="' + cx.toFixed(0) + '" cy="' + cy.toFixed(0) + '" r="' +
      (W * 0.425).toFixed(0) + '" fill="none" stroke="' + accent + '" stroke-width="' +
      (W * 0.014).toFixed(0) + '" opacity="0.9"/>');
  } else if (style === 'chevron') {
    p.push(r(deep));
    p.push('<path d="M' + X + ' ' + (Y + H) + ' L' + (X + W * 0.62) + ' ' + Y +
      ' L' + (X + W) + ' ' + Y + ' L' + (X + W * 0.38) + ' ' + (Y + H) +
      ' Z" fill="' + base + '"/>');
    p.push('<path d="M' + (X + W * 0.66) + ' ' + (Y + H) + ' L' + (X + W * 1.28) + ' ' + Y +
      ' L' + (X + W * 1.40) + ' ' + Y + ' L' + (X + W * 0.78) + ' ' + (Y + H) +
      ' Z" fill="' + accent + '" opacity="0.9"/>');
  } else if (style === 'speed') {
    p.push('<rect x="' + X + '" y="' + Y + '" width="' + W + '" height="' + H +
      '" fill="url(#' + gid + 'v)"/>');
    const step = W / 9;
    for (let k = 0; k < 11; k++) {
      const x = X - H + k * step * 1.35;
      p.push('<rect x="' + x.toFixed(0) + '" y="' + (Y - H).toFixed(0) + '" width="' +
        (step * 0.28).toFixed(0) + '" height="' + (H * 3).toFixed(0) +
        '" fill="#ffffff" opacity="0.05" transform="rotate(22 ' + cx.toFixed(0) + ' ' +
        cy.toFixed(0) + ')"/>');
    }
  }

  return { id: gid, defs: d.join(''), body: p.join('') };
}

/** Équivalent exact de bgDefs() de bg.js : defs + formes dans un seul <g>. */
export function bgGroup(hue, vb, style) {
  const b = bgParts(hue, vb, style);
  return '<g class="avatar-bg">' + b.defs + b.body + '</g>';
}

/* -----------------------------------------------------------------------------
   3. CONFIGURATION
   Alimentée par private.avatar_config(tenant) côté admin, et par
   public_site_config(token).avatars côté page publique de résultats.
   -------------------------------------------------------------------------- */

const DEFAULTS = {
  pack: 'classic',        // 'classic' | 'signature'
  type: 'kartpilot',      // grand format (fiche pilote, podium)
  small_type: 'helmet',   // petit format (classement, Top 10)
  background: 'studio',   // id de style, ou false/null/'none' = fond désactivé
  outline: true,          // halo blanc autour du sujet quand le fond est actif
  shape: 'round',         // 'round' | 'square'
  entitled: false,        // le tenant a-t-il le droit au pack (plan Pro)
  plan: 'free',
  base_url: '/avatars/signature/'
};

let cfg = Object.assign({}, DEFAULTS);
let packBroken = false;   // passe à true dès qu'un fichier du pack renvoie 404

/** Applique la config renvoyée par la base. Tolère les champs manquants. */
export function configureSignatureAvatars(next) {
  cfg = Object.assign({}, DEFAULTS, next || {});
  if (SIGNATURE_KINDS.indexOf(cfg.type) < 0) cfg.type = DEFAULTS.type;
  // 'same' = « comme le grand format ». C'est la SEULE valeur que la base
  // accepte pour obtenir un petit avatar numéroté : la contrainte SQL sur
  // avatar_small_type n'admet que ('same','helmet','bust'), et ni 'helmet' ni
  // 'bust' ne portent de numéro de course. Sans cette ligne, 'same' n'étant
  // pas un kind connu tombait dans le repli ci-dessous et redevenait
  // silencieusement 'helmet' — le numéro disparaissait du Top 10 sans qu'aucun
  // réglage ne permette de le récupérer.
  if (cfg.small_type === 'same') cfg.small_type = cfg.type;
  if (SIGNATURE_KINDS.indexOf(cfg.small_type) < 0) cfg.small_type = DEFAULTS.small_type;
  // La base nomme cette forme 'squircle', le CSS d'ici l'appelle 'square'
  // (border-radius 12 %, ce qui est bien un squircle et pas un carré). Sans ce
  // synonyme, un 'squircle' venu de la base ne correspondait à rien et
  // retombait sur 'round' : l'option était inatteignable depuis les réglages.
  if (cfg.shape === 'squircle') cfg.shape = 'square';
  if (cfg.shape !== 'square') cfg.shape = 'round';
  if (!cfg.base_url) cfg.base_url = DEFAULTS.base_url;
  if (cfg.base_url.slice(-1) !== '/') cfg.base_url += '/';
  packBroken = false;
  return cfg;
}

export function signatureAvatarConfig() { return Object.assign({}, cfg); }

/** Vrai seulement si le tenant a le droit au pack ET l'a sélectionné. Toute la
    cloison commerciale tient dans cette ligne : si elle est fausse, aucune URL
    du pack n'est jamais émise dans le HTML. */
export function signatureAvatarsActive() {
  return !packBroken && cfg.pack === 'signature' && cfg.entitled === true;
}

/* Contour : anneau blanc dessiné SUR le bord de la pastille.
   Historiquement l'option « contour » chargeait les SVG de la variante outline,
   dont le halo blanc « sticker » entoure le sujet lui-même : à 110 px sur mobile
   ce halo devient énorme et ses filets internes se lisent comme des traits
   blancs parasites. On n'utilise donc plus que la variante plain, et le contour
   est un anneau tracé au bord du cadran — même intention visuelle, propre à
   toutes les tailles, et réversible sans changer d'asset.
   Tracé dans l'espace de la viewBox pour être identique à l'écran et en PDF. */
function ringLayerRaw(vb, shape, cls) {
  const [x, y, w] = vb;
  const sw = w * 0.028;
  /* L'anneau doit affleurer le bord de la pastille : son bord EXTERIEUR se pose
     sur le cercle de découpe. Avec inset = sw le trait rentrait d'une demi-
     épaisseur vers l'intérieur et laissait une couronne de fond visible
     au-delà — c'est ce liseré coloré qui donnait l'impression que « l'arrondi
     blanc ne prend pas tout le cercle ». 0.55 (et non 0.5 pile) garde un
     cheveu de marge pour l'anticrénelage du clip. */
  const inset = sw * 0.55;
  const attr = 'fill="none" stroke="#fff" stroke-opacity=".92" stroke-width="' + sw + '"';
  const body = shape === 'square'
    ? '<rect x="' + (x + inset) + '" y="' + (y + inset) + '" width="' + (w - 2 * inset) +
      '" height="' + (w - 2 * inset) + '" rx="' + (w * 0.12) + '" ' + attr + '/>'
    : '<circle cx="' + (x + w / 2) + '" cy="' + (y + w / 2) + '" r="' + (w / 2 - inset) +
      '" ' + attr + '/>';
  /* x/y/width/height explicites : imbriqué dans un <svg> parent (cas PDF), un
     <svg> sans position se place à 0,0 — or nos viewBox ont une origine négative
     (bust : -114). L'anneau était donc décalé et sortait de la pastille. */
  return '<svg' + (cls ? ' class="' + cls + '"' : '') + ' x="' + x + '" y="' + y +
    '" width="' + w + '" height="' + w + '" viewBox="' + vb.join(' ') +
    '" aria-hidden="true" preserveAspectRatio="xMidYMid meet">' + body + '</svg>';
}

/* Découpe de la pastille FAITE DANS LE SVG et non par le CSS du conteneur.
   iOS Safari n'applique pas de façon fiable border-radius / clip-path sur des
   enfants en position:absolute (nos couches .sigav__l) : le fond restait carré
   sur iPhone. Comme le fond est la seule couche qui atteint les bords (le sujet
   est en object-fit:contain), il suffit de le découper à la source. Bonus : la
   forme est alors identique à l'écran, en PDF (html2canvas ne gère pas non plus
   clip-path) et dans n'importe quel autre moteur de rendu. */
function bgClip(vb, shape) {
  const [x, y, w] = vb;
  const id = 'sigclip_' + shape + '_' + Math.round(w) + '_' + Math.round(x) + '_' + Math.round(y);
  const inner = shape === 'square'
    ? '<rect x="' + x + '" y="' + y + '" width="' + w + '" height="' + w +
      '" rx="' + (w * 0.12) + '"/>'
    : '<circle cx="' + (x + w / 2) + '" cy="' + (y + w / 2) + '" r="' + (w / 2) + '"/>';
  return {
    defs: '<clipPath id="' + id + '">' + inner + '</clipPath>',
    open: '<g clip-path="url(#' + id + ')">',
    close: '</g>'
  };
}

function bgStyleOf(o) {
  const raw = (o && o.background !== undefined) ? o.background : cfg.background;
  if (raw === false || raw === null || raw === '' || raw === 'none' || raw === 'off') return null;
  return BG_STYLE_IDS.indexOf(raw) >= 0 ? raw : 'studio';
}

/* -----------------------------------------------------------------------------
   4. CSS (injecté une seule fois)
   .sigav impose aspect-ratio:1 : dans le conteneur haut du podium, la pastille
   doit rester un cercle, pas devenir une ellipse.
   -------------------------------------------------------------------------- */

const CSS = `
.sigav{position:relative;display:block;aspect-ratio:1;width:100%;max-width:100%;max-height:100%;margin:auto;overflow:hidden;isolation:isolate;transform:translateZ(0);background:transparent}
.sigav--round{border-radius:50%;-webkit-clip-path:circle(50% at 50% 50%);clip-path:circle(50% at 50% 50%)}
.sigav--square{border-radius:12%;-webkit-clip-path:inset(0 round 12%);clip-path:inset(0 round 12%)}
.sigav__l{position:absolute;inset:0;width:100%;height:100%;display:block;pointer-events:none}
/* Ceinture + bretelles : chaque couche porte SON propre arrondi. Un élément
   clippe toujours son propre contenu par son border-radius, y compris sur iOS —
   contrairement au clip du parent, ignoré sur les enfants absolus. */
.sigav--round .sigav__l{border-radius:50%;overflow:hidden}
.sigav--square .sigav__l{border-radius:12%;overflow:hidden}
.sigav__sub{object-fit:contain}
/* Podium : la zone photo est courte (surtout sur mobile, .podium-card height:84%).
   Une pastille en width:100% + aspect-ratio:1 débordait donc en hauteur et se
   faisait trancher par la bande du nom. On la fait tenir EN HAUTEUR dans la zone
   disponible, centrée, et on la plafonne en largeur pour dégager le chiffre de
   position posé en haut à gauche. */
.pilot-photo-wrap{display:flex;align-items:center;justify-content:center;min-height:0;overflow:hidden}
.pilot-photo-wrap .sigav{width:84%;max-width:84%;height:auto;max-height:none;margin:0;flex:0 0 auto}
#sigav-defs{position:absolute;width:0;height:0;overflow:hidden}
`;

let cssDone = false;
export function signatureAvatarCSSOnce() {
  if (cssDone || typeof document === 'undefined') return;
  if (document.getElementById('sigav-css')) { cssDone = true; return; }
  const st = document.createElement('style');
  st.id = 'sigav-css';
  st.textContent = CSS;
  document.head.appendChild(st);
  cssDone = true;
}

/* -----------------------------------------------------------------------------
   5. <defs> mutualisés
   Un seul <svg id="sigav-defs"> caché porte tous les dégradés. Sur un classement
   de 30 pilotes en style studio on écrit 30 fonds mais UN SEUL jeu de dégradés
   par teinte, et les id restent uniques dans le document (donc valides).
   -------------------------------------------------------------------------- */

const defsSeen = new Set();
let defsHost = null;

function ensureDefs(part) {
  if (typeof document === 'undefined') return false;   // pas de DOM : on inline
  if (defsSeen.has(part.id)) return true;
  if (!defsHost || !defsHost.isConnected) {
    defsHost = document.getElementById('sigav-defs');
    if (!defsHost) {
      defsHost = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      defsHost.setAttribute('id', 'sigav-defs');
      defsHost.setAttribute('aria-hidden', 'true');
      defsHost.setAttribute('focusable', 'false');
      document.body.appendChild(defsHost);
    }
  }
  defsHost.insertAdjacentHTML('beforeend', part.defs);
  defsSeen.add(part.id);
  return true;
}

/* -----------------------------------------------------------------------------
   6. COMPOSITION
   -------------------------------------------------------------------------- */

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** pid 1..24 — c'est le numéro de fichier du pack. schemeForKart() rend 0..23. */
export function pilotIdForKart(kartNumber) {
  return schemeForKart(kartNumber) + 1;
}

/* pid (1..24) pour un appel donné : si opts.scheme est fourni (0..23, comme
 * l'API déjà supportée par kartAvatarSVG), il prend le pas sur le numéro de
 * kart — c'est ce qui permet de rendre un avatar Signature par INDEX BRUT
 * plutôt que par numéro de kart (carrousel d'inscription register.html,
 * session_registrations.avatar_scheme choisi explicitement par le pilote),
 * sans dupliquer de fonction : signatureAvatarHTML(null, { scheme: i }) rend
 * l'avatar #i indépendamment de tout numéro de kart. Repli identique à
 * kartAvatarSVG : un index hors 0..23 est ramené dans l'intervalle par modulo. */
function pidForOpts(kartNumber, o) {
  if (o && o.scheme != null) {
    return ((Math.round(o.scheme) % AVATAR_SCHEME_COUNT) + AVATAR_SCHEME_COUNT) % AVATAR_SCHEME_COUNT + 1;
  }
  return pilotIdForKart(kartNumber);
}

export function signatureAvatarURL(kartNumber, kind, variant, opts) {
  const pid = pidForOpts(kartNumber, opts);
  return cfg.base_url + variant + '/pilot_' + (pid < 10 ? '0' + pid : pid) + '_' + kind + '.svg';
}

function numberLayer(kind, num) {
  const a = NUMBER_ANCHOR[kind];
  if (!a || num == null || num === '') return '';
  return '<svg class="sigav__l sigav__num" viewBox="' + a.viewBox + '" aria-hidden="true" ' +
    'preserveAspectRatio="xMidYMid meet"><text x="' + a.x + '" y="' + a.y +
    '" text-anchor="middle" font-family="' + a.family + '" font-weight="' + a.weight +
    '" font-size="' + a.size + '" fill="' + a.fill + '">' + esc(num) + '</text></svg>';
}

/**
 * Retourne le HTML d'un avatar Signature. SYNCHRONE : le retour part directement
 * dans innerHTML, exactement comme kartAvatarSVG().
 *
 * opts : { small, kind, title, size, background, shape, number, inlineDefs }
 *   small       -> utilise cfg.small_type au lieu de cfg.type
 *   kind        -> force le type, ignore small/cfg
 *   number      -> numéro affiché (défaut : kartNumber). null = pas de numéro.
 *   background  -> force le style, ou false pour désactiver le fond
 *   inlineDefs  -> place les <defs> dans l'avatar plutôt que dans le <svg> partagé
 *                  (nécessaire si le HTML est sérialisé hors du document courant)
 */
export function signatureAvatarHTML(kartNumber, opts) {
  const o = opts || {};
  if (!signatureAvatarsActive()) return kartAvatarSVG(kartNumber, o);

  signatureAvatarCSSOnce();

  const kind = SIGNATURE_KINDS.indexOf(o.kind) >= 0
    ? o.kind : (o.small ? cfg.small_type : cfg.type);
  const style = bgStyleOf(o);
  const outline = (o.outline !== undefined ? o.outline : cfg.outline) !== false;
  // Toujours la variante plain : le contour est désormais un anneau (ringLayerRaw)
  // et n'a de sens que sur un fond, sinon il flotterait sur la page.
  const variant = 'plain';
  const ring = (style && outline);
  const rawShape = o.shape || cfg.shape;
  const shape = (rawShape === 'square' || rawShape === 'squircle') ? 'square' : 'round';

  const pid = pidForOpts(kartNumber, o);
  const hue = HUES[pid];
  const vb = VIEWBOX[kind];
  const num = (o.number !== undefined) ? o.number : kartNumber;

  let bg = '';
  if (style) {
    const part = bgParts(hue, vb, style);
    const shared = !o.inlineDefs && ensureDefs(part);
    const clip = bgClip(vb, shape);
    bg = '<svg class="sigav__l sigav__bg" viewBox="' + vb.join(' ') + '" aria-hidden="true" ' +
      'preserveAspectRatio="xMidYMid meet"><defs>' + clip.defs + '</defs>' +
      (shared ? '' : part.defs) + clip.open + part.body + clip.close + '</svg>';
  }

  const label = o.title || o.alt || (o.scheme != null ? ('Avatar ' + (pid)) : ('Kart ' + kartNumber));
  const sizeCss = o.size ? ' style="width:' + o.size + 'px;height:' + o.size + 'px"' : '';

  return '<div class="sigav sigav--' + shape + '" role="img" aria-label="' + esc(label) + '"' +
    sizeCss + ' data-kart="' + esc(kartNumber) + '" data-kind="' + kind + '">' +
    bg +
    '<img class="sigav__l sigav__sub" src="' + esc(signatureAvatarURL(kartNumber, kind, variant, o)) +
    '" alt="" loading="lazy" decoding="async" draggable="false">' +
    (ring ? ringLayerRaw(vb, shape, 'sigav__l sigav__ring') : '') +
    numberLayer(kind, num) +
    '</div>';
}

/* -----------------------------------------------------------------------------
   7. REPLI AUTOMATIQUE
   Si le pack n'est pas déployé (404), l'appli ne doit pas afficher des cadres
   vides : on rebascule sur l'avatar classique. L'événement "error" d'une <img>
   ne remonte pas, il faut donc l'écouter en phase de CAPTURE sur le document.
   -------------------------------------------------------------------------- */

let fallbackWired = false;
export function wireSignatureAvatarFallback() {
  if (fallbackWired || typeof document === 'undefined') return;
  fallbackWired = true;
  document.addEventListener('error', (e) => {
    const img = e.target;
    if (!img || img.tagName !== 'IMG' || !img.classList ||
        !img.classList.contains('sigav__sub')) return;
    const box = img.closest('.sigav');
    if (!box || box.dataset.sigavFailed === '1') return;
    box.dataset.sigavFailed = '1';
    // Le pack est absent : on cesse d'en émettre pour le reste de la session,
    // sinon chaque avatar déclenche sa propre requête 404.
    packBroken = true;
    const kart = box.getAttribute('data-kart');
    const label = box.getAttribute('aria-label') || '';
    box.outerHTML = kartAvatarSVG(kart, { title: label });
  }, true);
}

/* -----------------------------------------------------------------------------
   8. EXPORT PDF (html2canvas)
   html2canvas rasterise un clone du DOM : les <defs> partagés et le lazy loading
   n'y survivent pas de façon fiable. Pour le PDF on produit donc un SVG unique
   entièrement autonome (fond + sujet + numéro), rendu en data URL.
   Le sujet est imbriqué tel quel dans un <svg> interne : sa viewBox et celle du
   conteneur sont identiques, la transformation est donc l'identité — aucun
   redimensionnement, aucune reprise du fichier.
   -------------------------------------------------------------------------- */

const subjectCache = new Map();

async function fetchSubject(url) {
  if (subjectCache.has(url)) return subjectCache.get(url);
  const p = fetch(url, { credentials: 'omit' }).then((r) => {
    if (!r.ok) throw new Error('pack ' + r.status + ' ' + url);
    return r.text();
  });
  subjectCache.set(url, p);
  p.catch(() => subjectCache.delete(url));
  return p;
}

export async function signatureAvatarDataURL(kartNumber, opts) {
  const o = opts || {};
  if (!signatureAvatarsActive()) return null;

  const kind = SIGNATURE_KINDS.indexOf(o.kind) >= 0
    ? o.kind : (o.small ? cfg.small_type : cfg.type);
  const style = bgStyleOf(o);
  const outline = (o.outline !== undefined ? o.outline : cfg.outline) !== false;
  const variant = 'plain';
  const ring = (style && outline);
  const rawShapeD = o.shape || cfg.shape;
  const shapeD = (rawShapeD === 'square' || rawShapeD === 'squircle') ? 'square' : 'round';
  const vb = VIEWBOX[kind];
  const pidD = pidForOpts(kartNumber, o);
  const hue = HUES[pidD];
  const num = (o.number !== undefined) ? o.number : kartNumber;
  /* 1024 et non 512 : html2canvas rastérise le data URL à sa taille intrinsèque
     avant de l'agrandir dans la fiche pilote — à 512 l'avatar sortait flou. */
  const size = o.size || 1024;

  let inner;
  try {
    inner = await fetchSubject(signatureAvatarURL(kartNumber, kind, variant, o));
  } catch (err) {
    packBroken = true;
    return null;
  }

  // On donne au <svg> du sujet une position explicite dans l'espace du parent.
  // Il a déjà width/height/viewBox = la viewBox du type, donc x=X y=Y suffit.
  const nested = inner.replace(/^\s*<svg\b/, '<svg x="' + vb[0] + '" y="' + vb[1] + '"');

  const clipD = bgClip(vb, shapeD);
  const bg = style
    ? '<defs>' + clipD.defs + '</defs>' + clipD.open + bgGroup(hue, vb, style) + clipD.close
    : '';
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="' + size + '" height="' + size +
    '" viewBox="' + vb.join(' ') + '">' + bg + nested +
    (ring ? ringLayerRaw(vb, shapeD, '') : '') + numberLayerRaw(kind, num) + '</svg>';

  return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
}

/* -----------------------------------------------------------------------------
   8bis. EXPORT PDF — cache synchrone
   Les constructeurs de markup du PDF (pdfxAvatarImg, etc.) sont synchrones et
   html2canvas ne sait pas attendre une promesse. On préchauffe donc les data
   URLs en amont (downloadFullPDF / downloadPilotPDF sont async), puis les
   builders lisent le cache de façon synchrone.
   La clé englobe toutes les options qui changent le rendu.
   -------------------------------------------------------------------------- */
const dataUrlCache = new Map();

function dataUrlKey(kartNumber, opts) {
  const o = opts || {};
  const kind = SIGNATURE_KINDS.indexOf(o.kind) >= 0
    ? o.kind : (o.small ? cfg.small_type : cfg.type);
  const style = bgStyleOf(o);
  const outline = (o.outline !== undefined ? o.outline : cfg.outline) !== false;
  const num = (o.number !== undefined) ? o.number : kartNumber;
  const shape = (o.shape || cfg.shape) === 'square' ? 'square' : 'round';
  // La clé doit distinguer deux avatars qui partagent le même kartNumber mais
  // pas le même avatar_scheme (pilote inscrit via le nouveau parcours, scheme
  // choisi explicitement) — sinon le second écraserait/lirait le cache du
  // premier. o.scheme fait donc partie de la clé, jamais kartNumber seul.
  const schemePart = o.scheme != null ? 'sch' + (((Math.round(o.scheme) % 24) + 24) % 24) : 'kart' + kartNumber;
  return [schemePart, kind, style || '-', outline ? 1 : 0, shape, o.size || 512, num].join('|');
}

/** Précharge (async) les data URLs Signature pour une liste de karts.
 *  À appeler et await AVANT de construire le markup PDF.
 *  `items` accepte soit une liste de numéros de kart (API historique, repli
 *  sur le schéma déduit du numéro), soit une liste d'objets { kart, scheme }
 *  quand l'avatar de certains inscrits a été choisi explicitement
 *  (session_registrations.avatar_scheme) — chaque objet reçoit alors la
 *  priorité sur le schéma déduit du kart, exactement comme signatureAvatarHTML. */
export async function prewarmSignatureAvatarDataURLs(items, opts) {
  if (!signatureAvatarsActive()) return;
  const norm = (items || [])
    .map((it) => (it && typeof it === 'object') ? it : { kart: it })
    .filter((it) => it.kart != null && it.kart !== '');
  const seen = new Set();
  const list = [];
  for (const it of norm) {
    const itemOpts = it.scheme != null ? { ...opts, scheme: it.scheme } : opts;
    const key = dataUrlKey(it.kart, itemOpts);
    if (seen.has(key)) continue;
    seen.add(key);
    list.push({ it, itemOpts, key });
  }
  await Promise.all(list.map(async ({ it, itemOpts, key }) => {
    if (dataUrlCache.has(key)) return;
    const url = await signatureAvatarDataURL(it.kart, itemOpts);
    if (url) dataUrlCache.set(key, url);
  }));
}

/** Lecture synchrone du cache. Renvoie null si non préchauffé (l'appelant
 *  retombe alors sur l'avatar classique — jamais de PDF vide). */
export function signatureAvatarDataURLSync(kartNumber, opts) {
  if (!signatureAvatarsActive()) return null;
  return dataUrlCache.get(dataUrlKey(kartNumber, opts)) || null;
}

/* même <text> que numberLayer(), mais sans le <svg> conteneur : dans l'export
   on est déjà dans l'espace utilisateur de la bonne viewBox. */
function numberLayerRaw(kind, num) {
  const a = NUMBER_ANCHOR[kind];
  if (!a || num == null || num === '') return '';
  return '<text x="' + a.x + '" y="' + a.y + '" text-anchor="middle" font-family="' +
    a.family + '" font-weight="' + a.weight + '" font-size="' + a.size + '" fill="' +
    a.fill + '">' + esc(num) + '</text>';
}

/* -----------------------------------------------------------------------------
   9. PRÉCHARGEMENT (optionnel)
   Le podium affiche 3 grands avatars au-dessus de la ligne de flottaison :
   loading="lazy" les chargerait quand même immédiatement, mais un <link rel=
   preload> évite l'attente du layout. À n'appeler que pour quelques karts.
   -------------------------------------------------------------------------- */
export function preloadSignatureAvatars(kartNumbers, opts) {
  if (!signatureAvatarsActive() || typeof document === 'undefined') return;
  const o = opts || {};
  const kind = SIGNATURE_KINDS.indexOf(o.kind) >= 0
    ? o.kind : (o.small ? cfg.small_type : cfg.type);
  const style = bgStyleOf(o);
  const variant = 'plain';
  const seen = new Set();
  (kartNumbers || []).slice(0, 8).forEach((n) => {
    const url = signatureAvatarURL(n, kind, variant);
    if (seen.has(url)) return;
    seen.add(url);
    const l = document.createElement('link');
    l.rel = 'preload'; l.as = 'image'; l.type = 'image/svg+xml'; l.href = url;
    document.head.appendChild(l);
  });
}

export { schemeForKart, AVATAR_SCHEME_COUNT };
