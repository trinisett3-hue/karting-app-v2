import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";

// provision-organization
// ------------------------------------------------------------------
// Point de jonction entre la FACADE (Kartex / Lovable, inscription client)
// et l'ATELIER (karting-app-v2, l'outil de gestion en production).
//
// v3 (28/07) -- deux corrections structurelles :
//
//  1. ATOMICITE. Les 4 INSERT (organizations, organization_memberships,
//     tenants, tenant_users) etaient sequentiels et non transactionnels :
//     un echec au milieu laissait une organisation orpheline sans membre
//     (cas observe en base). Ils sont desormais executes par la fonction
//     SQL public.admin_provision_organization() dont le corps plpgsql est
//     atomique : tout passe, ou rien ne passe.
//
//  2. RECONCILIATION. Le test d'idempotence retournait tot des qu'un
//     membership existait, sans jamais consommer la ligne
//     pending_provisionings posee par le webhook Stripe. Consequence :
//     un client qui s'inscrivait (starter) puis payait (pro) restait
//     bloque sur starter. Le chemin "deja existant" appelle maintenant
//     public.admin_reconcile_pending_provisioning() avant de repondre.
//
// v4 (03/08, audit) : ATELIER_URL pointait encore sur
// https://karting-app-v2.pages.dev/admin.html — l'ancien domaine Pages ET
// l'extension .html (redirection 308 a chaque fois). C'est cette URL que
// la reponse renvoie a un client tout juste provisionne pour qu'il rejoigne
// son espace de gestion ; elle vit desormais dans APP_ADMIN_URL (secret),
// avec repli sur https://app.trinisette.fr/admin si le secret est absent
// plutot que de retomber sur l'ancien domaine par defaut.
//
// Contrainte de securite inchangee : ne touche jamais aux tables sessions,
// laps, session_registrations, drivers, app_settings, venues,
// results_snapshots.

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
};

const ATELIER_URL = Deno.env.get("APP_ADMIN_URL") ?? "https://app.trinisette.fr/admin";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function slugify(input: string): string {
  const base = input
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)+/g, "");
  const suffix = crypto.randomUUID().slice(0, 6);
  return `${base || "circuit"}-${suffix}`;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const authHeader = req.headers.get("Authorization") ?? "";
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: userData, error: userErr } = await userClient.auth.getUser();
    if (userErr || !userData.user) return json({ error: "Non authentifié" }, 401);
    const user = userData.user;

    const admin = createClient(supabaseUrl, serviceRoleKey);

    // --- Corps de la requete (lu une seule fois, avant tout branchement) ---
    let orgName = "Mon circuit";
    let explicitPlanCode: string | null = null;
    const body = await req.json().catch(() => ({} as Record<string, unknown>));
    if (typeof body?.organizationName === "string" && body.organizationName.trim()) {
      orgName = body.organizationName.trim().slice(0, 120);
    } else if (user.user_metadata?.full_name) {
      orgName = `Circuit de ${String(user.user_metadata.full_name).split(" ")[0]}`;
    }
    if (typeof body?.planCode === "string" && body.planCode.trim()) {
      explicitPlanCode = body.planCode.trim();
    }

    // --- Idempotence : l'utilisateur a-t-il deja une organisation ? ---
    const { data: existingMembership, error: memLookupErr } = await admin
      .from("organization_memberships")
      .select("organization_id, role")
      .eq("user_id", user.id)
      .limit(1)
      .maybeSingle();
    if (memLookupErr) {
      console.error("[provision-organization] membership lookup failed", memLookupErr);
      return json({ error: memLookupErr.message }, 500);
    }

    if (existingMembership) {
      // Ne PAS retourner aveuglement : un paiement a pu arriver depuis.
      const { data: reconciled, error: recErr } = await admin.rpc(
        "admin_reconcile_pending_provisioning",
        { _user_id: user.id },
      );
      if (recErr) {
        console.error("[provision-organization] reconciliation failed", recErr);
      }

      const { data: org, error: orgErr } = await admin
        .from("organizations")
        .select("id, name, slug, plan_code, status")
        .eq("id", existingMembership.organization_id)
        .maybeSingle();
      if (orgErr) {
        console.error("[provision-organization] org lookup failed", orgErr);
        return json({ error: orgErr.message }, 500);
      }

      const { data: tenant } = await admin
        .from("tenants")
        .select("id, name")
        .eq("organization_id", existingMembership.organization_id)
        .limit(1)
        .maybeSingle();

      return json({
        organization: org,
        tenant,
        alreadyExisted: true,
        reconciliation: reconciled ?? null,
        atelierUrl: ATELIER_URL,
      });
    }

    // --- Resolution du plan reellement paye ---
    let resolvedPlanCode = explicitPlanCode;
    let pendingId: string | null = null;
    {
      const { data: pending } = await admin
        .from("pending_provisionings")
        .select("id, plan_code")
        .eq("user_id", user.id)
        .eq("provisioned", false)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (pending) {
        pendingId = pending.id as string;
        if (!resolvedPlanCode && pending.plan_code) {
          resolvedPlanCode = pending.plan_code as string;
        }
      }
    }
    if (!resolvedPlanCode) resolvedPlanCode = "starter";

    // --- Creation atomique (organizations + membership + tenant + tenant_user) ---
    const { data: created, error: provErr } = await admin.rpc("admin_provision_organization", {
      _user_id: user.id,
      _email: user.email,
      _org_name: orgName,
      _slug: slugify(orgName),
      _plan_code: resolvedPlanCode,
    });
    if (provErr) {
      console.error("[provision-organization] atomic provisioning failed", provErr);
      if (pendingId) {
        await admin
          .from("pending_provisionings")
          .update({ last_error: provErr.message, updated_at: new Date().toISOString() })
          .eq("id", pendingId);
      }
      return json({ error: provErr.message }, 500);
    }

    const orgId = (created as Record<string, string>)?.organization_id;
    const tenantId = (created as Record<string, string>)?.tenant_id;

    if (pendingId) {
      const { error: pendErr } = await admin
        .from("pending_provisionings")
        .update({
          provisioned: true,
          provisioned_at: new Date().toISOString(),
          organization_id: orgId,
          tenant_id: tenantId,
          atelier_url: ATELIER_URL,
          last_error: null,
          updated_at: new Date().toISOString(),
        })
        .eq("id", pendingId);
      if (pendErr) console.error("[provision-organization] pending update failed", pendErr);
    }

    const { data: org } = await admin
      .from("organizations")
      .select("id, name, slug, plan_code, status")
      .eq("id", orgId)
      .maybeSingle();

    return json({
      organization: org,
      tenant: { id: tenantId, name: orgName },
      alreadyExisted: false,
      atelierUrl: ATELIER_URL,
    });
  } catch (e) {
    console.error("[provision-organization] handler error", e);
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
