import Stripe from "https://esm.sh/stripe@17.7.0?target=deno";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";
import { corsHeaders } from "../_shared/cors.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const { organizationId, returnUrl } = await req.json();
    if (!organizationId) return json({ error: "organizationId requis" }, 400);

    const authHeader = req.headers.get("Authorization") ?? "";
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } },
    );
    const { data: userData, error: userErr } = await supabase.auth.getUser();
    if (userErr || !userData.user) return json({ error: "Non authentifié" }, 401);

    const { data: membership } = await supabase
      .from("organization_memberships")
      .select("id")
      .eq("user_id", userData.user.id)
      .eq("organization_id", organizationId)
      .maybeSingle();
    if (!membership) return json({ error: "Accès refusé" }, 403);

    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );
    const { data: sub } = await admin
      .from("subscriptions")
      .select("provider_customer_id")
      .eq("organization_id", organizationId)
      .eq("provider", "stripe")
      .not("provider_customer_id", "is", null)
      .limit(1)
      .maybeSingle();

    if (!sub?.provider_customer_id) {
      return json({ error: "Aucun abonnement Stripe pour cette organisation" }, 404);
    }

    const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY")!, {
      apiVersion: "2024-11-20.acacia",
    });

    const portal = await stripe.billingPortal.sessions.create({
      customer: sub.provider_customer_id,
      return_url: returnUrl ?? `${req.headers.get("origin") ?? ""}/dashboard/billing`,
    });

    return json({ url: portal.url });
  } catch (e) {
    console.error("[billing-portal]", e);
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
