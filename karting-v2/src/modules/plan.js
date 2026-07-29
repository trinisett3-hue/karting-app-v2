// Module Plan — résout le plan payé (Basique/Premium) de l'organisation courante pour
// débloquer les fonctions Premium (ex. plan du circuit). Nouveau fichier, n'écrase rien.
//
// Fonctionne car les policies RLS existantes le permettent déjà :
//   tenants.tenant_select      : id = current_tenant_id()          (l'admin voit son tenant)
//   organizations."Members..." : private.is_org_member(id)         (l'admin voit son org)
//
// À placer dans : karting-v2/src/modules/plan.js

import { db } from '../lib/supabase.js';

const PREMIUM_FEATURES = ['track_map'];

let cachedPlanCode = null;

export async function getCurrentPlanCode() {
if (cachedPlanCode) return cachedPlanCode;
// P0-2 (audit 28/07) : organizations.plan_code n'est qu'un cache d'affichage (voir
// migration document_plan_source_of_verite du 29/07). La vraie source est
// private.tenant_plan_code(), exposee via my_plan_code() -- meme logique que celle
// appliquee cote serveur pour les themes et le plan du circuit.
const { data, error } = await db.rpc('my_plan_code');
if (error || !data) return 'starter';
cachedPlanCode = data;
return cachedPlanCode;
}

export async function hasFeature(feature) {
if (!PREMIUM_FEATURES.includes(feature)) return true;
const plan = await getCurrentPlanCode();
// codes techniques inchangés : "pro" = Premium, "business" = Business (dormant)
return plan === 'pro' || plan === 'business';
}

// Invalide le cache (utile après changement de plan sans recharger la page).
export function resetPlanCache() {
cachedPlanCode = null;
}
