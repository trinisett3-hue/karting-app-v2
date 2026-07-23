// Module avatars kart — dessin SVG paramétrique d'un pilote dans un kart, vu de face,
// avec roues visibles. Le NUMÉRO affiché sur la carrosserie est celui du kart utilisé
// (injecté dynamiquement), et la COULEUR (casque + carrosserie) dépend d'un schéma déduit
// du numéro de kart : chaque kart de la flotte a donc un avatar distinct et reconnaissable,
// réutilisé à l'identique d'une session à l'autre.
//
// Utilisé par :
//   - results.html (podium, classement, détail) via public-results.js
//   - les exports PDF (global + fiche pilote)
//   - l'onglet Paramètres de l'admin (galerie + aperçu)
//
// 24 schémas de couleurs : au-delà de 24 karts, les schémas se répètent (le numéro, lui,
// reste toujours le vrai numéro de kart).

export const AVATAR_SCHEME_COUNT = 24;

// Génère 24 schémas vifs et contrastés sur fond sombre. Casque et carrosserie ont des
// teintes bien séparées sur la roue chromatique pour rester lisibles côte à côte.
function buildSchemes() {
  const out = [];
  for (let i = 0; i < AVATAR_SCHEME_COUNT; i++) {
    const h = (i * 15) % 360;              // 24 teintes réparties sur 360°
    const helmet = `hsl(${h} 85% 56%)`;
    const body = `hsl(${(h + 165) % 360} 78% 52%)`;   // teinte quasi-complémentaire
    out.push({ helmet, body });
  }
  return out;
}
const SCHEMES = buildSchemes();

// Schéma (0-23) associé à un numéro de kart. Déterministe → même kart = même avatar.
export function schemeForKart(kartNumber) {
  const n = Number(kartNumber);
  if (!Number.isFinite(n)) return 0;
  return ((Math.round(n) - 1) % AVATAR_SCHEME_COUNT + AVATAR_SCHEME_COUNT) % AVATAR_SCHEME_COUNT;
}

// Couleurs d'un schéma donné (pour aperçus / légendes éventuelles).
export function schemeColors(index) {
  return SCHEMES[((index % AVATAR_SCHEME_COUNT) + AVATAR_SCHEME_COUNT) % AVATAR_SCHEME_COUNT];
}

// Dessin SVG (chaîne) d'un avatar kart.
//   kartNumber : numéro affiché sur la plaque (null/undefined -> pas de numéro)
//   opts.scheme : forcer un schéma de couleur (sinon déduit du numéro de kart)
//   opts.size   : largeur/hauteur en px (défaut : 100% du conteneur)
//   opts.title  : texte accessible
export function kartAvatarSVG(kartNumber, opts = {}) {
  const scheme = SCHEMES[opts.scheme != null ? ((opts.scheme % 24) + 24) % 24 : schemeForKart(kartNumber)];
  const helmet = scheme.helmet;
  const body = scheme.body;
  const suit = '#242732';
  const tire = '#15171d';
  const rim = '#3a3f4c';
  const num = (kartNumber == null || kartNumber === '') ? '' : String(kartNumber);
  const dims = opts.size ? `width="${opts.size}" height="${opts.size}"` : 'width="100%" height="100%"';
  const title = opts.title ? `<title>${opts.title}</title>` : '';
  // taille de police de la plaque selon le nombre de chiffres — calibrée pour
  // rester DANS la plaque (rect 38,82 24x17) sans jamais déborder au-dessus/en dessous.
  const fs = num.length >= 3 ? 11 : num.length === 2 ? 14 : 17;

  return `<svg viewBox="0 0 100 104" ${dims} xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Kart ${num}">${title}
    <!-- roues arrière (derrière le pilote) -->
    <rect x="11" y="34" width="16" height="30" rx="7" fill="${tire}"/>
    <rect x="73" y="34" width="16" height="30" rx="7" fill="${tire}"/>
    <ellipse cx="19" cy="45" rx="4" ry="5.5" fill="${rim}"/>
    <ellipse cx="81" cy="45" rx="4" ry="5.5" fill="${rim}"/>

    <!-- pontons latéraux colorés (relient l'arrière à l'avant) -->
    <path d="M22 66 L34 62 L36 92 L20 92 Z" fill="${body}"/>
    <path d="M78 66 L66 62 L64 92 L80 92 Z" fill="${body}"/>

    <!-- combinaison / épaules -->
    <path d="M24 88 Q28 56 50 54 Q72 56 76 88 Z" fill="${suit}"/>
    <!-- bras vers le volant -->
    <path d="M31 68 Q21 75 25 88 L39 88 Q35 75 41 69 Z" fill="${suit}"/>
    <path d="M69 68 Q79 75 75 88 L61 88 Q65 75 59 69 Z" fill="${suit}"/>

    <!-- casque -->
    <path d="M50 10 C33 10 29 29 31 44 L69 44 C71 29 67 10 50 10 Z" fill="${helmet}"/>
    <path d="M50 10 C40 10 34 19 33 32 L45 32 C45 20 47 13 52 12 Z" fill="#ffffff" opacity="0.22"/>
    <!-- visière -->
    <path d="M32 40 L68 40 L66 54 Q50 60 34 54 Z" fill="#2b2f3a"/>
    <path d="M40 42 L36 53" stroke="#4a4f5c" stroke-width="2.4" stroke-linecap="round"/>
    <!-- mentonnière -->
    <path d="M34 53 Q50 60 66 53 L64 63 Q50 68 36 63 Z" fill="${helmet}"/>

    <!-- volant -->
    <path d="M33 74 Q50 65 67 74" fill="none" stroke="#1c1f27" stroke-width="5.5" stroke-linecap="round"/>
    <circle cx="33" cy="74" r="4.2" fill="#c8ccd6"/>
    <circle cx="67" cy="74" r="4.2" fill="#c8ccd6"/>

    <!-- châssis / plancher sombre sous le nez -->
    <rect x="22" y="90" width="56" height="12" rx="5" fill="#1a1d25"/>

    <!-- carrosserie / nez avec plaque numéro -->
    <path d="M35 79 Q50 73 65 79 L69 99 L31 99 Z" fill="${body}"/>
    <rect x="37" y="81" width="26" height="18" rx="3.5" fill="#f4f5f8"/>
    ${num ? `<text x="50" y="94.5" text-anchor="middle" dominant-baseline="middle" font-family="'Arial Narrow',Arial,sans-serif" font-weight="900" font-size="${fs}" fill="#15171d">${num}</text>` : ''}

    <!-- roues avant (grosses, au premier plan) -->
    <rect x="3"  y="70" width="20" height="32" rx="8" fill="${tire}"/>
    <rect x="77" y="70" width="20" height="32" rx="8" fill="${tire}"/>
    <rect x="7"  y="76" width="12" height="20" rx="6" fill="none" stroke="#2c313d" stroke-width="2"/>
    <rect x="81" y="76" width="12" height="20" rx="6" fill="none" stroke="#2c313d" stroke-width="2"/>
    <ellipse cx="13" cy="86" rx="5" ry="7" fill="${rim}"/>
    <ellipse cx="87" cy="86" rx="5" ry="7" fill="${rim}"/>
    <ellipse cx="13" cy="86" rx="2" ry="3" fill="#5b6270"/>
    <ellipse cx="87" cy="86" rx="2" ry="3" fill="#5b6270"/>

    <!-- pare-chocs -->
    <rect x="27" y="97" width="46" height="6" rx="3" fill="${body}"/>
  </svg>`;
}

// Même dessin encodé en data URL — pour l'utiliser dans un <img> (exports PDF via
// html2canvas, qui gère mieux une image qu'un SVG inline complexe).
export function kartAvatarDataURL(kartNumber, opts = {}) {
  const svg = kartAvatarSVG(kartNumber, { ...opts, size: opts.size || 100 });
  return 'data:image/svg+xml,' + encodeURIComponent(svg);
}
