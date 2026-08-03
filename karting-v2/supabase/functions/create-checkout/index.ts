import Stripe from "https://esm.sh/stripe@17.7.0?target=deno";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";
import { corsHeaders } from "../_shared/cors.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const { planCode, organizationId, successUrl, cancelUrl } = await req.json();
    if (!planCode || !organizationId) {
      return json({ error: "planCode et organizationId requis" }, 400);
    }

    // Price ID par plan (stocké en secret)
    const priceMap: Record<string, string | undefined> = {
      starter: Deno.env.get("STRIPE_PRICE_STARTER"),
      pro: Deno.env.get("STRIPE_PRICE_PRO"),
      business: Deno.env.get("STRIPE_PRICE_BUSINESS"),
    };
    const priceId = priceMap[planCode];
    if (!priceId) return json({ error: `Prix Stripe manquant pour ${planCode}` }, 400);

    // Auth utilisateur
    const authHeader = req.headers.get("Authorization") ?? "";
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } },
    );
    const { data: userData, error: userErr } = await supabase.auth.getUser();
    if (userErr || !userData.user) return json({ error: "Non authentifié" }, 401);

    // Vérifie que l'utilisateur est membre de l'organisation
    const { data: membership } = await supabase
      .from("organization_memberships")
      .select("id, role")
      .eq("user_id", userData.user.id)
      .eq("organization_id", organizationId)
      .maybeSingle();
    if (!membership) return json({ error: "Accès refusé à cette organisation" }, 403);

    const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY")!, {
      apiVersion: "2024-11-20.acacia",
    });

    // Réutilise le customer si présent
    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );
    const { data: existingSub } = await admin
      .from("subscriptions")
      .select("provider_customer_id")
      .eq("organization_id", organizationId)
      .eq("provider", "stripe")
      .not("provider_customer_id", "is", null)
      .limit(1)
      .maybeSingle();

    const email = userData.user.email ?? undefined;
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      line_items: [{ price: priceId, quantity: 1 }],
      client_reference_id: organizationId,
      customer: existingSub?.provider_customer_id ?? undefined,
      customer_email: existingSub?.provider_customer_id ? undefined : email,
      allow_promotion_codes: true,
      metadata: { organization_id: organizationId, plan_code: planCode },
      subscription_data: {
        metadata: { organization_id: organizationId, plan_code: planCode },
      },
      success_url: successUrl ?? `${req.headers.get("origin") ?? ""}/dashboard/billing?checkout=success`,
      cancel_url: cancelUrl ?? `${req.headers.get("origin") ?? ""}/dashboard/billing?checkout=cancel`,
    });

    return json({ url: session.url });
  } catch (e) {
    console.error("[create-checkout]", e);
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
