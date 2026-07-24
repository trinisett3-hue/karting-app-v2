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
const { data: tenantRow, error: tenantErr } = await db
.from('tenants')
.select('id, organization_id')
.limit(1)
.maybeSingle();
if (tenantErr || !tenantRow?.organization_id) return null;
const { data: org, error: orgErr } = await db
.from('organizations')
.select('plan_code, status')
.eq('id', tenantRow.organization_id)
.maybeSingle();
if (orgErr || !org) return null;
cachedPlanCode = org.plan_code || 'starter';
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
