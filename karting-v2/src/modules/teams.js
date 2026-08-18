// Module Écuries — le référentiel partagé du mode Écurie.
//
// POURQUOI CE MODULE EXISTE
// Quatre écrans très éloignés les uns des autres doivent dessiner exactement le
// même logo d'écurie avec exactement les mêmes couleurs : l'admin (choix des
// écuries engagées + correction d'affiliation), la page d'inscription, la page
// publique de résultats, et le PDF. Sans point commun, ces quatre-là divergent
// au premier changement de couleur. Tout ce qui touche à une écurie passe donc
// par ici, et par nulle part ailleurs.
//
// REMPLACER LES LOGOS PLUS TARD
// Une écurie arrive de la base sous la forme { logo_kind, logo_ref } :
//   logo_kind = 'glyph' -> logo_ref est une clé de TEAM_GLYPHS ci-dessous
//   logo_kind = 'url'   -> logo_ref est un chemin de fichier, servi tel quel
// Poser ses propres logos ne demande donc AUCUNE modification de ce fichier :
// une ligne dans public.tenant_teams avec logo_url, et la vue
// v_tenant_team_catalog redescend logo_kind='url'. teamLogoHTML() bascule seule.

import { db } from '../lib/supabase.js';

// Barème par défaut. La session peut le surcharger (sessions.points_scale),
// auquel cas c'est cette valeur-là qui redescend dans les RPC publiques.
export const DEFAULT_POINTS_SCALE = [25, 18, 15, 12, 10, 8, 6, 4, 2, 1];

// Les 12 glyphes, viewBox 64×64, dessinés d'origine : trajectoire idéale et son
// point de corde, goutte de carburant, flèches de couple, piston et bielle,
// bouteille de nitro, enchaînement de chicane, joint de cardan, roue inclinée,
// pneu slick, traces de dérive, étincelle de magnéto, tourbillon aéro.
export const TEAM_GLYPHS = {
  apex:    '<path d="M6 58C6 26 24 8 58 8" fill="none" stroke="currentColor" stroke-width="7" stroke-linecap="round"/><circle cx="21" cy="23" r="6.5"/>',
  octane:  '<path d="M32 4c12 18 18 27 18 34a18 18 0 1 1-36 0c0-7 6-16 18-34z"/><path d="M24 40a8 8 0 0 0 8 8" fill="none" stroke="#000" stroke-opacity=".35" stroke-width="3.5" stroke-linecap="round"/>',
  torque:  '<path d="M32 10a22 22 0 0 1 22 22" fill="none" stroke="currentColor" stroke-width="7" stroke-linecap="round"/><path d="M32 54A22 22 0 0 1 10 32" fill="none" stroke="currentColor" stroke-width="7" stroke-linecap="round"/><path d="M46 4l10 8-10 8z"/><path d="M18 60L8 52l10-8z"/>',
  piston:  '<rect x="16" y="6" width="32" height="20" rx="3"/><rect x="19" y="28" width="26" height="5" rx="2.5" opacity=".55"/><path d="M28 35h8l6 25H22z"/>',
  nitro:   '<rect x="27" y="4" width="10" height="9" rx="2"/><rect x="16" y="13" width="32" height="47" rx="14"/><path d="M32 24c5 7-2 8-2 13a5 5 0 0 0 10 0c0-8-8-9-8-13z" fill="#000" fill-opacity=".33"/>',
  chicane: '<path d="M10 54h14l8-22h8l6-22h8" fill="none" stroke="currentColor" stroke-width="7" stroke-linejoin="round" stroke-linecap="round"/>',
  cardan:  '<circle cx="32" cy="32" r="10"/><rect x="27" y="2" width="10" height="16" rx="3"/><rect x="27" y="46" width="10" height="16" rx="3"/><rect x="2" y="27" width="16" height="10" rx="3"/><rect x="46" y="27" width="16" height="10" rx="3"/>',
  camber:  '<g transform="rotate(-16 32 32)"><ellipse cx="32" cy="32" rx="15" ry="26"/><ellipse cx="32" cy="32" rx="6" ry="11" fill="#000" fill-opacity=".35"/></g>',
  slick:   '<circle cx="32" cy="32" r="27"/><circle cx="32" cy="32" r="13" fill="#000" fill-opacity=".4"/><circle cx="32" cy="32" r="6"/>',
  drift:   '<path d="M8 50C22 50 26 34 40 34s16-16 16-16" fill="none" stroke="currentColor" stroke-width="8" stroke-linecap="round"/><path d="M8 62c14 0 18-16 32-16s16-16 16-16" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" opacity=".45"/>',
  magneto: '<path d="M36 2 16 34h12l-4 28 24-34H34z"/><circle cx="52" cy="10" r="4" opacity=".6"/><circle cx="10" cy="54" r="3" opacity=".5"/>',
  vortex:  '<path d="M32 8a24 24 0 1 1-17 41 18 18 0 1 0 13-31 12 12 0 1 1 8 21" fill="none" stroke="currentColor" stroke-width="7" stroke-linecap="round"/>',
};

// Repli neutre : si la base référence un glyphe qu'on ne connaît pas (logo
// ajouté côté SQL avant déploiement du front), on dessine un disque plutôt que
// de laisser un trou.
const FALLBACK_GLYPH = '<circle cx="32" cy="32" r="24"/>';

// Les <linearGradient> vivent dans un espace de noms global au document : deux
// logos de la même écurie à deux tailles différentes se piétineraient sans ce
// compteur. C'est aussi ce qui permet de rasteriser une carte avec html2canvas
// sans récupérer le dégradé d'un autre logo.
let gradSeq = 0;

export function teamLogoHTML(team, size) {
  if (!team) return '';
  const px = size || 40;
  if (team.logo_kind === 'url') {
    return '<img class="team-logo" src="' + team.logo_ref + '" alt="' + escapeAttr(team.name) +
           '" width="' + px + '" height="' + px + '" style="width:' + px + 'px;height:' + px + 'px;object-fit:contain">';
  }
  const glyph = TEAM_GLYPHS[team.logo_ref] || FALLBACK_GLYPH;
  const gid = 'tg' + (++gradSeq);
  return '<svg class="team-logo" viewBox="0 0 64 64" width="' + px + '" height="' + px +
         '" role="img" aria-label="' + escapeAttr(team.name) + '">' +
         '<defs><linearGradient id="' + gid + '" x1="0" y1="0" x2="1" y2="1">' +
         '<stop offset="0" stop-color="' + team.color + '"/>' +
         '<stop offset="1" stop-color="' + (team.color_2 || team.color) + '"/></linearGradient></defs>' +
         '<g fill="url(#' + gid + ')" color="' + team.color + '">' + glyph + '</g></svg>';
}

function escapeAttr(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

// --- Catalogue côté admin ------------------------------------------------------------
//
// L'admin est authentifié : il lit directement la vue résolue (catalogue global
// + surcharge de son circuit), là où les pages publiques reçoivent le catalogue
// déjà cuit dans le JSON des RPC. Une seule requête, mise en cache pour la durée
// de la session d'admin — le catalogue ne bouge pas en cours de route.
let catalogCache = null;

export async function loadTeamCatalog({ force = false } = {}) {
  if (catalogCache && !force) return catalogCache;
  const { data, error } = await db
    .from('v_tenant_team_catalog')
    .select('team_id,name,short,color,color_2,logo_kind,logo_ref,sort_order,is_active')
    .eq('is_active', true)
    .order('sort_order', { ascending: true });
  if (error || !data) return catalogCache || [];
  catalogCache = data.map((t) => ({ ...t, id: t.team_id }));
  return catalogCache;
}

export function resetTeamCatalogCache() {
  catalogCache = null;
}

// Indexe une liste d'écuries par id. Utilisé partout où on a un team_id sur une
// ligne et où il faut retrouver ses couleurs sans reparcourir le tableau.
export function indexTeams(teams) {
  const map = {};
  (teams || []).forEach((t) => { map[t.id || t.team_id] = t; });
  return map;
}

// --- Classement constructeur ---------------------------------------------------------
//
// Volontairement une fonction pure, sans accès réseau ni DOM : c'est la même
// qui sert la page publique, la carte partageable et le PDF. Une seule logique
// de tri, un seul endroit où la corriger.
//
// `rows` : [{ registration_id, team_id, position, ... }] déjà classées, position
// commençant à 1. `scale` : tableau de points par position (index 0 = P1).
//
// Règles validées : somme des points des pilotes de l'écurie ; à égalité, la
// moyenne des positions la plus basse gagne ; une écurie à un seul pilote
// concourt normalement, avec les points de ce seul pilote.
export function pointsForPosition(position, scale) {
  const s = (scale && scale.length) ? scale : DEFAULT_POINTS_SCALE;
  const i = Number(position) - 1;
  return (i >= 0 && i < s.length) ? Number(s[i]) || 0 : 0;
}

export function computeTeamStandings(rows, scale) {
  const byTeam = new Map();
  (rows || []).forEach((r) => {
    if (!r || !r.team_id) return;
    if (!byTeam.has(r.team_id)) {
      byTeam.set(r.team_id, { team_id: r.team_id, points: 0, posSum: 0, count: 0, members: [] });
    }
    const t = byTeam.get(r.team_id);
    const pts = pointsForPosition(r.position, scale);
    t.points += pts;
    t.posSum += Number(r.position) || 0;
    t.count += 1;
    t.members.push({ ...r, points: pts });
  });

  const list = Array.from(byTeam.values()).map((t) => ({
    ...t,
    avgPosition: t.count ? t.posSum / t.count : Infinity,
    members: t.members.sort((a, b) => a.position - b.position),
  }));

  list.sort((a, b) => (b.points - a.points) || (a.avgPosition - b.avgPosition));
  list.forEach((t, i) => { t.rank = i + 1; });

  // Signale une égalité réellement départagée aux positions : la page publique
  // et la carte s'en servent pour l'annoncer plutôt que de la laisser passer
  // pour une victoire nette.
  list.forEach((t, i) => {
    const prev = list[i - 1], next = list[i + 1];
    t.tiebroken = !!((prev && prev.points === t.points) || (next && next.points === t.points));
  });

  return list;
}
