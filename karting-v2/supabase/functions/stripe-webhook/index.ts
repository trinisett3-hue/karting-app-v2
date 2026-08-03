import Stripe from "https://esm.sh/stripe@17.7.0?target=deno";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";

const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY")!, {
  apiVersion: "2024-11-20.acacia",
});
const webhookSecret = Deno.env.get("STRIPE_WEBHOOK_SECRET")!;

const admin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

type UpsertResult = {
  organizationId: string | null;
  subscriptionId: string | null;
  planCode: string | null;
};

const EMPTY: UpsertResult = { organizationId: null, subscriptionId: null, planCode: null };

Deno.serve(async (req) => {
  const signature = req.headers.get("stripe-signature");
  if (!signature) return new Response("Missing signature", { status: 400 });

  const raw = await req.text();
  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(raw, signature, webhookSecret);
  } catch (err) {
    console.error("[stripe-webhook] signature verification failed", err);
    return new Response(`Webhook Error: ${err instanceof Error ? err.message : "unknown"}`, {
      status: 400,
    });
  }

  let ctx: UpsertResult = EMPTY;

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object as Stripe.Checkout.Session;
        if (session.mode === "subscription" && session.subscription) {
          const sub = await stripe.subscriptions.retrieve(session.subscription as string);
          ctx = await upsertSubscription(sub, session.client_reference_id ?? undefined);
          await hydratePendingProvisioning(session, sub, ctx);
        }
        break;
      }
      case "customer.subscription.updated":
      case "customer.subscription.created": {
        const sub = event.data.object as Stripe.Subscription;
        ctx = await upsertSubscription(sub);
        break;
      }
      case "customer.subscription.deleted": {
        const sub = event.data.object as Stripe.Subscription;
        ctx = await upsertSubscription(sub, undefined, "canceled");
        break;
      }
      case "invoice.paid": {
        const invoice = event.data.object as Stripe.Invoice;
        if (invoice.subscription) {
          const sub = await stripe.subscriptions.retrieve(invoice.subscription as string);
          ctx = await upsertSubscription(sub);
        }
        break;
      }
      default:
        break;
    }

    await logBillingEvent(event, ctx);

    return new Response(JSON.stringify({ received: true }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("[stripe-webhook] handler error", e);
    await logBillingEvent(event, ctx, e instanceof Error ? e.message : String(e));
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});

/**
 * Journalise l'evenement dans public.billing_events.
 * Colonnes reelles : organization_id, subscription_id, type (NOT NULL), payload (NOT NULL).
 */
async function logBillingEvent(event: Stripe.Event, ctx: UpsertResult, handlerError?: string) {
  const payload: Record<string, unknown> = {
    provider: "stripe",
    stripe_event_id: event.id,
    stripe_event_type: event.type,
    created: event.created,
    livemode: event.livemode,
    plan_code: ctx.planCode,
    data: event.data,
  };
  if (handlerError) payload.handler_error = handlerError;

  const { error } = await admin.from("billing_events").insert({
    organization_id: ctx.organizationId,
    subscription_id: ctx.subscriptionId,
    type: event.type,
    payload,
  });

  if (error) {
    console.error("[billing_events] insert failed", {
      message: error.message,
      details: error.details,
      hint: error.hint,
      code: error.code,
      event_id: event.id,
      event_type: event.type,
    });
  }
}

/** Resout le plan_code : metadata subscription -> metadata price -> mapping env. */
async function resolvePlanCode(sub: Stripe.Subscription): Promise<string | null> {
  const fromSub = sub.metadata?.plan_code as string | undefined;
  if (fromSub) return fromSub;

  const priceId = sub.items.data[0]?.price?.id;
  if (priceId) {
    try {
      const price = await stripe.prices.retrieve(priceId);
      const fromPrice = price.metadata?.plan_code as string | undefined;
      if (fromPrice) return fromPrice;
    } catch (e) {
      console.warn("[stripe-webhook] price retrieve failed", priceId, e);
    }
    const map: Record<string, string | undefined> = {
      [Deno.env.get("STRIPE_PRICE_STARTER") ?? "__none_starter__"]: "starter",
      [Deno.env.get("STRIPE_PRICE_PRO") ?? "__none_pro__"]: "pro",
      [Deno.env.get("STRIPE_PRICE_BUSINESS") ?? "__none_business__"]: "business",
    };
    if (map[priceId]) return map[priceId]!;
  }
  return null;
}

async function upsertSubscription(
  sub: Stripe.Subscription,
  orgIdFromSession?: string,
  forcedStatus?: string,
): Promise<UpsertResult> {
  const organizationId =
    orgIdFromSession ??
    (sub.metadata?.organization_id as string | undefined) ??
    null;

  const planCode = await resolvePlanCode(sub);

  if (!organizationId) {
    console.warn("[stripe-webhook] subscription without organization_id", sub.id, {
      plan_code: planCode,
    });
    return { organizationId: null, subscriptionId: null, planCode };
  }

  if (!planCode) {
    console.error("[stripe-webhook] plan_code introuvable pour", sub.id);
    return { organizationId, subscriptionId: null, planCode: null };
  }

  const row = {
    organization_id: organizationId,
    plan_code: planCode,
    status: forcedStatus ?? sub.status,
    provider: "stripe",
    provider_customer_id: typeof sub.customer === "string" ? sub.customer : sub.customer.id,
    provider_subscription_id: sub.id,
    current_period_start: sub.current_period_start
      ? new Date(sub.current_period_start * 1000).toISOString()
      : null,
    current_period_end: sub.current_period_end
      ? new Date(sub.current_period_end * 1000).toISOString()
      : null,
    cancel_at_period_end: sub.cancel_at_period_end ?? false,
    updated_at: new Date().toISOString(),
  };

  const { data: upserted, error } = await admin
    .from("subscriptions")
    .upsert(row, { onConflict: "provider_subscription_id" })
    .select("id")
    .maybeSingle();
  if (error) {
    console.error("[stripe-webhook] upsert subscription failed", error);
    throw error;
  }

  const subscriptionId = upserted?.id ?? null;

  const active = ["active", "trialing", "past_due"].includes(row.status);
  const dead = ["canceled", "unpaid", "incomplete_expired"].includes(row.status);

  if (active) {
    const { error: orgErr } = await admin
      .from("organizations")
      .update({ plan_code: planCode, status: "active", updated_at: new Date().toISOString() })
      .eq("id", organizationId);
    if (orgErr) {
      console.error("[stripe-webhook] mirror organizations failed", orgErr);
      throw orgErr;
    }
    const { error: tErr } = await admin
      .from("tenants")
      .update({ plan_override: null })
      .eq("organization_id", organizationId)
      .not("plan_override", "is", null);
    if (tErr) console.warn("[stripe-webhook] reset plan_override skipped", tErr.message);
  } else if (dead) {
    const { error: orgErr } = await admin
      .from("organizations")
      .update({ status: "canceled", updated_at: new Date().toISOString() })
      .eq("id", organizationId);
    if (orgErr) {
      console.error("[stripe-webhook] mirror organizations (canceled) failed", orgErr);
      throw orgErr;
    }
  }

  return { organizationId, subscriptionId, planCode };
}

/**
 * Complete la ligne pending_provisionings correspondant a la session Stripe.
 * C'est cette ligne que provision-organization lit pour connaitre le plan achete.
 */
async function hydratePendingProvisioning(
  session: Stripe.Checkout.Session,
  sub: Stripe.Subscription,
  ctx: UpsertResult,
) {
  const patch: Record<string, unknown> = {
    stripe_subscription_id: sub.id,
    stripe_customer_id: typeof sub.customer === "string" ? sub.customer : sub.customer.id,
    updated_at: new Date().toISOString(),
  };
  if (ctx.planCode) patch.plan_code = ctx.planCode;
  if (ctx.organizationId) patch.organization_id = ctx.organizationId;

  const { error } = await admin
    .from("pending_provisionings")
    .update(patch)
    .eq("stripe_session_id", session.id);

  if (error) {
    console.error("[stripe-webhook] hydrate pending_provisionings failed", {
      message: error.message,
      session_id: session.id,
    });
  }
}
