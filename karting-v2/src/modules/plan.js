// Module Plan — résout le plan payé (Basique/Premium) de l'organisation courante pour
// débloquer les fonctions Premium (ex. statistiques avancées). Nouveau fichier, n'écrase rien.
//
// Fonctionne car les policies RLS existantes le permettent déjà :
//   tenants.tenant_select      : id = current_tenant_id()          (l'admin voit son tenant)
//   organizations."Members..." : private.is_org_member(id)         (l'admin voit son org)
//
// À placer dans : karting-v2/src/modules/plan.js

import { db } from '../lib/supabase.js';

// Repartition Basique/Premium plus fine (30/07) — chaque flag ci-dessous verrouille un
// perimetre precis, plutot qu'un seul gros flag "advanced_stats" pour tout l'onglet
// Statistiques comme avant :
//  - 'advanced_stats'    : sous-onglets Statistiques > Performance sportive et Usage
//                          avance & saisonnalite (voir stats.js > loadPremiumStatsBlocks()).
//                          Fidelisation n'est PLUS concernee par ce flag : elle reste
//                          Basique et se calcule desormais toujours.
//  - 'session_occupancy' : dans le sous-onglet Statistiques > Vue d'ensemble, les deux
//                          blocs "Exploitation de la piste" et "Frequentation" (voir
//                          stats.js > loadStatsTab()). Le reste de la Vue d'ensemble
//                          (KPIs globaux) et le Hall of Fame restent Basique.
//  - 'archive_detail'    : dans la fiche d'une archive, les blocs Classement / Inscrits /
//                          Imports chrono (voir results.js > openArchiveDetail()). La liste
//                          des archives, les notes internes et republier/copier le lien
//                          restent Basique.
//  - 'registry_export'   : le bouton "Exporter en CSV" de l'onglet Registre (voir
//                          registry.js > exportRegistryCSV()). Le registre lui-meme
//                          (total, pagination, recherche) reste Basique.
//  - 'archive_export'    : les boutons "Export CSV" / "Export PDF" d'une archive
//                          INDIVIDUELLE, depuis sa fiche (voir app.js > exportArchiveCSV()/
//                          exportArchivePDF()). Ne concerne pas l'export GLOBAL CSV/XLSX de
//                          la liste des archives (archives-export.js), qui reste Basique.
//  - 'team_mode'        : le mode Ecurie (championnat constructeur) — case a cocher a la
//                          creation de session, choix des ecuries engagees, colonne Ecurie
//                          dans le registre de session (voir teams-admin.js). Le droit est
//                          re-verifie cote serveur par private.tenant_has_team_mode() : les
//                          RPC publiques redescendent team_mode:false pour un plan Basique,
//                          meme si la colonne sessions.team_mode vaut true.
//  - 'full_history'      : dans l'onglet Statistiques, l'acces aux plages Mois / Annee /
//                          Personnalise / Depuis le debut du filtre de periode (voir
//                          stats.js > applyHistoryPlanLimits()). Le Basique reste borne aux
//                          plages courtes (Jour / Semaine / 30 derniers jours) -- decision
//                          du 19/08 : donner un declencheur d'achat simple ("tu veux
//                          comparer sur l'annee ? il te faut Pro") plutot que de laisser le
//                          Basique consulter tout l'historique comme avant.
const PREMIUM_FEATURES = ['advanced_stats', 'session_occupancy', 'archive_detail', 'registry_export', 'archive_export', 'team_mode', 'full_history'];

let cachedPlanCode = null;

export async function getCurrentPlanCode() {
if (cachedPlanCode) return cachedPlanCode;
// P0-2 (audit 28/07) : organizations.plan_code n'est qu'un cache d'affichage (voir
// migration document_plan_source_of_verite du 29/07). La vraie source est
// private.tenant_plan_code(), exposee via my_plan_code() -- meme logique que celle
// appliquee cote serveur pour les themes.
const { data, error } = await db.rpc('my_plan_code');
if (error || !data) return 'starter';
cachedPlanCode = data;
return cachedPlanCode;
}

export async function hasFeature(feature) {
if (!PREMIUM_FEATURES.includes(feature)) return true;
const plan = await getCurrentPlanCode();
// codes techniques inchangés : "pro" = Premium (nom commercial actuel, potentiellement
// ajustable plus tard), "business" = plan dormant, pas encore vendu / nommé commercialement
return plan === 'pro' || plan === 'business';
}

// Invalide le cache (utile après changement de plan sans recharger la page).
export function resetPlanCache() {
cachedPlanCode = null;
}

// Encart de verrouillage partage — meme rendu visuel que celui deja utilise pour
// advanced_stats (stats.js > renderLockedStatsPanel()).
// Centralise ici pour que tous les nouveaux flags (session_occupancy, archive_detail,
// registry_export, archive_export...) affichent le meme encart, quel que soit le module
// appelant. IMPORTANT (repris de stats.js) : cette fonction doit toujours etre appelee
// AVANT tout calcul/fetch du bloc concerne, jamais apres — aucune donnee ne doit etre
// deposee dans le DOM (meme cache) si le plan ne l'autorise pas.
export function renderPremiumLock(elId, message) {
const el = document.getElementById(elId);
if (!el) return;
el.innerHTML =
'<div style="font-size:13px;color:var(--mut);background:var(--surf2);border:1px solid var(--bord);border-radius:8px;padding:16px;text-align:center">' +
'<div style="font-size:22px;margin-bottom:6px">🔒</div>' +
'<div>' + (message || 'Reserve au plan <strong>Premium</strong>. Passe au plan superieur pour debloquer cette fonctionnalite.') + '</div>' +
'</div>';
}
