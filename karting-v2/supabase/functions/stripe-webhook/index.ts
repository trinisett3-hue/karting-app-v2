import Stripe from "https://esm.sh/stripe@17.7.0?target=deno";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";

// stripe-webhook — v4 (02/09/2026)
// ---------------------------------------------------------------------------
// v3 (18/08/2026) a introduit le PARCOURS "PAIEMENT D'ABORD".
// L'ancien chemin (client deja connecte qui monte en gamme depuis l'app) est
// conserve intact : il est reconnu par la presence de client_reference_id.
//
// Idempotence : Stripe rejoue ses webhooks. La cle est
// pending_provisionings.stripe_session_id (contrainte UNIQUE).
//
// ---------------------------------------------------------------------------
// v4 (02/09/2026) — LE PLAN PAYE NE PEUT PLUS SE PERDRE EN SILENCE
//
// Defaut corrige : resolvePlanCode() ne connaissait que trois sources --
// metadonnees de l'abonnement, metadonnees du prix, et secrets STRIPE_PRICE_*.
// Si les trois echouaient : provisionFromPayment() retombait sur ?? "starter"
// sans le dire ; upsertSubscription() sortait sans ecrire de ligne dans
// `subscriptions` ; et private.tenant_plan_code(), qui lit subscriptions et non
// Stripe, renvoyait 'starter'. Un circuit payant 99 EUR/mois se retrouvait sur
// un espace Basique, sans abonnement visible, sans aucune erreur affichee.
//
// Trois changements :
//   a. QUATRIEME source : le MONTANT paye, compare a public.plans. Un prix
//      recree change d'identifiant, mais pas de montant.
//   b. Le repli n'est plus silencieux : il s'ecrit dans
//      pending_provisionings.last_error et dans billing_events.
//   c. upsertSubscription() ecrit toujours la ligne d'abonnement. Son absence
//      etait le vrai degat.
// ---------------------------------------------------------------------------

const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY")!, {
  apiVersion: "2024-11-20.acacia",
});
const webhookSecret = Deno.env.get("STRIPE_WEBHOOK_SECRET")!;

const admin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

const APP_ADMIN_URL = Deno.env.get("APP_ADMIN_URL") ?? "https://app.trinisette.fr/admin";
const MANUAL_URL = Deno.env.get("MANUAL_URL") ?? "https://app.trinisette.fr/manuel-trinisette.pdf";
const EMAIL_API_KEY = Deno.env.get("EMAIL_API_KEY") ?? "";
const WELCOME_FROM = Deno.env.get("WELCOME_EMAIL_FROM") ?? "TRINISETTE <contact@trinisette.fr>";
const REPLY_TO = Deno.env.get("EMAIL_REPLY_TO") ?? "contact@trinisette.fr";

// Plan applique quand AUCUNE des quatre sources ne repond. Le client garde un
// acces (il a paye), mais l'echec est trace.
const FALLBACK_PLAN = "starter";

type UpsertResult = {
  organizationId: string | null;
  subscriptionId: string | null;
  planCode: string | null;
  planResolved: boolean;
};

const EMPTY: UpsertResult = {
  organizationId: null,
  subscriptionId: null,
  planCode: null,
  planResolved: true,
};

function planUnresolvedMessage(sub: Stripe.Subscription): string {
  const item = sub.items.data[0];
  return [
    "Plan introuvable pour l'abonnement ",
    sub.id,
    ` (prix ${item?.price?.id ?? "?"}, montant ${item?.price?.unit_amount ?? "?"} `,
    `${(item?.price?.currency ?? "?").toUpperCase()}).`,
    ` Repli applique : ${FALLBACK_PLAN}.`,
    " Poser la metadonnee plan_code sur le prix Stripe, ou mettre a jour les",
    " secrets STRIPE_PRICE_STARTER / STRIPE_PRICE_PRO / STRIPE_PRICE_BUSINESS.",
  ].join("");
}

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
          const orgIdFromSession =
            session.client_reference_id ??
            (sub.metadata?.organization_id as string | undefined) ??
            null;

          if (orgIdFromSession) {
            ctx = await upsertSubscription(sub, orgIdFromSession);
            await hydratePendingProvisioning(session, sub, ctx);
          } else {
            ctx = await provisionFromPayment(session, sub);
          }
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

// ===========================================================================
// PARCOURS "PAIEMENT D'ABORD"
// ===========================================================================

async function provisionFromPayment(
  session: Stripe.Checkout.Session,
  sub: Stripe.Subscription,
): Promise<UpsertResult> {
  // v4 : on distingue "plan resolu" de "plan de repli".
  const resolvedPlan = await resolvePlanCode(sub);
  const planResolved = resolvedPlan !== null;
  const planCode = resolvedPlan ?? FALLBACK_PLAN;

  const email = (session.customer_details?.email ?? session.customer_email ?? "").trim();
  const customerId = typeof sub.customer === "string" ? sub.customer : sub.customer.id;

  const circuitName =
    firstCustomFieldText(session, "nomducircuit") ??
    session.customer_details?.name ??
    "Mon circuit";

  const { data: existing } = await admin
    .from("pending_provisionings")
    .select("id, provisioned, organization_id, tenant_id")
    .eq("stripe_session_id", session.id)
    .maybeSingle();

  if (existing?.provisioned) {
    console.log("[stripe-webhook] session deja provisionnee", session.id);
    return {
      organizationId: existing.organization_id,
      subscriptionId: null,
      planCode,
      planResolved,
    };
  }

  let pendingId = existing?.id as string | undefined;
  if (!pendingId) {
    const { data: inserted, error: insErr } = await admin
      .from("pending_provisionings")
      .insert({
        stripe_session_id: session.id,
        stripe_customer_id: customerId,
        stripe_subscription_id: sub.id,
        plan_code: planCode,
        provisioned: false,
        user_id: "00000000-0000-0000-0000-000000000000",
      })
      .select("id")
      .maybeSingle();
    if (insErr) {
      const { data: retry } = await admin
        .from("pending_provisionings")
        .select("id, provisioned")
        .eq("stripe_session_id", session.id)
        .maybeSingle();
      if (retry?.provisioned) {
        return { organizationId: null, subscriptionId: null, planCode, planResolved };
      }
      pendingId = retry?.id as string | undefined;
      if (!pendingId) throw insErr;
    } else {
      pendingId = inserted?.id as string | undefined;
    }
  }

  const fail = async (msg: string) => {
    console.error("[stripe-webhook] provisionFromPayment:", msg);
    if (pendingId) {
      await admin
        .from("pending_provisionings")
        .update({ last_error: msg, updated_at: new Date().toISOString() })
        .eq("id", pendingId);
    }
  };

  // v4 : un declassement silencieux devient une trace ecrite. On continue le
  // provisionnement -- le client a paye, il doit avoir son acces.
  if (!planResolved) {
    await fail(planUnresolvedMessage(sub));
  }

  if (!email) {
    await fail("Aucune adresse e-mail sur la session Stripe : provisionnement impossible.");
    return { organizationId: null, subscriptionId: null, planCode, planResolved };
  }

  let userId: string | null = null;
  const { data: foundId, error: lookupErr } = await admin.rpc("admin_user_id_by_email", {
    _email: email,
  });
  if (lookupErr) {
    await fail(`Recherche du compte par e-mail impossible : ${lookupErr.message}`);
    return { organizationId: null, subscriptionId: null, planCode, planResolved };
  }
  userId = (foundId as string | null) ?? null;

  let isNewAccount = false;
  if (!userId) {
    const { data: created, error: createErr } = await admin.auth.admin.createUser({
      email,
      email_confirm: true,
      user_metadata: { circuit_name: circuitName, source: "stripe_payment_link" },
    });
    if (createErr || !created?.user) {
      await fail(`Creation du compte impossible : ${createErr?.message ?? "reponse vide"}`);
      return { organizationId: null, subscriptionId: null, planCode, planResolved };
    }
    userId = created.user.id;
    isNewAccount = true;
  }

  await admin
    .from("pending_provisionings")
    .update({ user_id: userId, updated_at: new Date().toISOString() })
    .eq("id", pendingId!);

  let organizationId: string | null = null;
  let tenantId: string | null = null;

  const { data: membership } = await admin
    .from("organization_memberships")
    .select("organization_id")
    .eq("user_id", userId)
    .limit(1)
    .maybeSingle();

  if (membership?.organization_id) {
    organizationId = membership.organization_id as string;
    const { data: t } = await admin
      .from("tenants")
      .select("id")
      .eq("organization_id", organizationId)
      .limit(1)
      .maybeSingle();
    tenantId = (t?.id as string) ?? null;
  } else {
    const { data: provisioned, error: provErr } = await admin.rpc(
      "admin_provision_organization",
      {
        _user_id: userId,
        _email: email,
        _org_name: circuitName,
        _slug: slugify(circuitName),
        _plan_code: planCode,
      },
    );
    if (provErr) {
      await fail(`Provisionnement atomique en echec : ${provErr.message}`);
      return { organizationId: null, subscriptionId: null, planCode, planResolved };
    }
    organizationId = (provisioned as Record<string, string>)?.organization_id ?? null;
    tenantId = (provisioned as Record<string, string>)?.tenant_id ?? null;
  }

  if (!organizationId) {
    await fail("Organisation introuvable apres provisionnement.");
    return { organizationId: null, subscriptionId: null, planCode, planResolved };
  }

  // v4 : on transmet le plan deja resolu.
  const upserted = await upsertSubscription(sub, organizationId, undefined, planCode);

  await admin
    .from("pending_provisionings")
    .update({
      provisioned: true,
      provisioned_at: new Date().toISOString(),
      organization_id: organizationId,
      tenant_id: tenantId,
      atelier_url: APP_ADMIN_URL,
      // On n'efface pas une alerte de plan non resolu : elle doit survivre au
      // succes du provisionnement, sinon personne ne la verra jamais.
      last_error: planResolved ? null : planUnresolvedMessage(sub),
      updated_at: new Date().toISOString(),
    })
    .eq("id", pendingId!);

  try {
    const link = await buildAccessLink(email);
    await sendWelcomeEmail({ email, circuitName, planCode, link, isNewAccount });
  } catch (e) {
    await fail(
      `Compte et espace crees, mais l'e-mail de bienvenue n'est pas parti : ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
  }

  return { ...upserted, planResolved };
}

async function buildAccessLink(email: string): Promise<string> {
  const { data, error } = await admin.auth.admin.generateLink({
    type: "recovery",
    email,
    options: { redirectTo: APP_ADMIN_URL },
  });
  if (error || !data?.properties?.action_link) {
    throw new Error(`generateLink: ${error?.message ?? "lien absent de la reponse"}`);
  }
  return data.properties.action_link;
}

async function sendWelcomeEmail(p: {
  email: string;
  circuitName: string;
  planCode: string;
  link: string;
  isNewAccount: boolean;
}) {
  if (!EMAIL_API_KEY) throw new Error("EMAIL_API_KEY absent : impossible d'envoyer.");

  const planLabel =
    p.planCode === "pro" ? "Premium" : p.planCode === "business" ? "Business" : "Basique";
  const subject = `Votre espace TRINISETTE est prêt — ${p.circuitName}`;

  const adminHost = APP_ADMIN_URL.replace(/^https:\/\//, "");

  const html = `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f4f5f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#16181d">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5f7;padding:32px 12px">
<tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:14px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.08)">
  <tr><td style="background:#07080c;padding:26px 32px">
    <div style="font-size:21px;font-weight:800;letter-spacing:.14em;color:#ffffff">TRINISETTE</div>
    <div style="font-size:12px;letter-spacing:.09em;color:#ff3b30;margin-top:5px;font-weight:700">GESTION DE CIRCUIT KARTING</div>
  </td></tr>
  <tr><td style="padding:32px">
    <p style="margin:0 0 18px;font-size:17px;font-weight:700">Bienvenue, et merci pour votre confiance.</p>
    <p style="margin:0 0 18px;font-size:15px;line-height:1.6;color:#3a3f4a">
      Votre paiement est bien enregistré et l'espace de <strong>${escapeHtml(p.circuitName)}</strong>
      est créé, sur l'offre <strong>${planLabel}</strong>.
    </p>
    <p style="margin:0 0 26px;font-size:15px;line-height:1.6;color:#3a3f4a">
      ${
        p.isNewAccount
          ? "Il ne reste qu'une étape : choisir votre mot de passe."
          : "Votre compte existant a été rattaché à cet abonnement. Ce lien vous permet de vous connecter ou de redéfinir votre mot de passe."
      }
    </p>
    <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 auto 18px">
      <tr><td style="border-radius:9px;background:#ff3b30">
        <a href="${p.link}" style="display:inline-block;padding:15px 34px;font-size:15px;font-weight:700;color:#ffffff;text-decoration:none;border-radius:9px">
          Définir mon mot de passe
        </a>
      </td></tr>
    </table>
    <p style="margin:0 0 24px;font-size:13px;line-height:1.6;color:#79808f;text-align:center">
      Ce lien est valable 24 heures et ne fonctionne qu'une seule fois.
    </p>

    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 26px;background:#f4f5f7;border-left:4px solid #ff3b30;border-radius:0 8px 8px 0">
      <tr><td style="padding:18px 20px">
        <p style="margin:0 0 8px;font-size:14px;font-weight:700;color:#16181d">
          Ajoutez cette adresse à vos favoris, maintenant
        </p>
        <p style="margin:0 0 10px;font-size:14px;line-height:1.6;color:#3a3f4a">
          Votre espace vit ici, une fois votre mot de passe choisi :<br>
          <a href="${APP_ADMIN_URL}" style="color:#ff3b30;text-decoration:none;font-weight:700">${adminHost}</a>
        </p>
        <p style="margin:0;font-size:13px;line-height:1.6;color:#79808f">
          Enregistrez-la dès maintenant dans votre navigateur — <strong>Ctrl + D</strong> sur Windows,
          <strong>⌘ + D</strong> sur Mac — et nommez le favori « Espace karting ». C'est le seul chemin
          vers votre espace : il n'apparaît pas dans les moteurs de recherche, et cet e-mail finira
          par se perdre au fond de votre boîte de réception. Sur la tablette du comptoir, utilisez
          « Ajouter à l'écran d'accueil » : l'espace s'ouvrira comme une application.
        </p>
      </td></tr>
    </table>

    <div style="border-top:1px solid #e6e8ec;padding-top:22px">
      <p style="margin:0 0 12px;font-size:14px;font-weight:700">Vos trois premières minutes</p>
      <p style="margin:0 0 8px;font-size:14px;line-height:1.6;color:#3a3f4a">
        <strong>1.</strong> Dans <em>Paramètres</em>, renseignez le nom de votre circuit et votre logo.
      </p>
      <p style="margin:0 0 8px;font-size:14px;line-height:1.6;color:#3a3f4a">
        <strong>2.</strong> Réglez le nombre de karts et de tours par défaut : vos sessions seront pré-remplies.
      </p>
      <p style="margin:0 0 16px;font-size:14px;line-height:1.6;color:#3a3f4a">
        <strong>3.</strong> Créez une première session d'essai, affichez son QR code d'inscription, et
        scannez-le avec votre téléphone pour voir ce que verront vos pilotes.
      </p>
      <p style="margin:0;font-size:14px;line-height:1.6;color:#3a3f4a">
        Tout est détaillé, écran par écran, dans le
        <a href="${MANUAL_URL}" style="color:#ff3b30;text-decoration:none;font-weight:700">manuel de mise en route (PDF)</a> —
        sa dernière page est un mémo à imprimer pour votre comptoir.
      </p>
    </div>
  </td></tr>
  <tr><td style="background:#f9fafb;padding:22px 32px;border-top:1px solid #e6e8ec">
    <p style="margin:0;font-size:13px;line-height:1.6;color:#79808f">
      Une question, un réglage à faire ensemble ? Répondez simplement à cet e-mail,
      ou écrivez à <a href="mailto:${REPLY_TO}" style="color:#ff3b30;text-decoration:none">${REPLY_TO}</a>.
      Nous vous rappelons volontiers pour la mise en route.
    </p>
  </td></tr>
</table>
<p style="max-width:560px;margin:16px auto 0;font-size:11px;line-height:1.5;color:#9aa1ae;text-align:center">
  TRINISETTE — gestion d'événements karting. Vous recevez cet e-mail suite à votre abonnement.
</p>
</td></tr></table>
</body></html>`;

  const text = [
    `Bienvenue, et merci pour votre confiance.`,
    ``,
    `Votre paiement est bien enregistré et l'espace de ${p.circuitName} est créé, sur l'offre ${planLabel}.`,
    ``,
    `Définissez votre mot de passe ici (lien valable 24 h, usage unique) :`,
    p.link,
    ``,
    `AJOUTEZ CETTE ADRESSE A VOS FAVORIS, MAINTENANT`,
    `Votre espace vit ici : ${APP_ADMIN_URL}`,
    `Enregistrez-la dans votre navigateur (Ctrl + D sur Windows, Cmd + D sur Mac) et nommez`,
    `le favori "Espace karting". C'est le seul chemin vers votre espace : il n'apparait pas`,
    `dans les moteurs de recherche, et cet e-mail finira par se perdre dans votre boite.`,
    ``,
    `Vos trois premières minutes :`,
    `1. Dans Paramètres, renseignez le nom de votre circuit et votre logo.`,
    `2. Réglez le nombre de karts et de tours par défaut.`,
    `3. Créez une session d'essai et scannez son QR code d'inscription.`,
    ``,
    `Manuel de mise en route (PDF) : ${MANUAL_URL}`,
    ``,
    `Une question ? Répondez à cet e-mail ou écrivez à ${REPLY_TO}.`,
  ].join("\n");

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${EMAIL_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: WELCOME_FROM,
      to: [p.email],
      reply_to: REPLY_TO,
      subject,
      html,
      text,
    }),
  });

  if (!res.ok) {
    throw new Error(`Resend ${res.status} : ${await res.text()}`);
  }
}

// ===========================================================================
// OUTILS
// ===========================================================================

function firstCustomFieldText(session: Stripe.Checkout.Session, key: string): string | null {
  const f = (session.custom_fields ?? []).find((c) => c.key === key);
  const v = f?.text?.value?.trim();
  return v ? v : null;
}

function slugify(input: string): string {
  const base = input
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)+/g, "");
  return `${base || "circuit"}-${crypto.randomUUID().slice(0, 6)}`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function logBillingEvent(event: Stripe.Event, ctx: UpsertResult, handlerError?: string) {
  const payload: Record<string, unknown> = {
    provider: "stripe",
    stripe_event_id: event.id,
    stripe_event_type: event.type,
    created: event.created,
    livemode: event.livemode,
    plan_code: ctx.planCode,
    // v4 : false = le plan n'a pas pu etre resolu et un repli a ete applique.
    plan_resolved: ctx.planResolved,
    data: event.data,
  };
  if (handlerError) payload.handler_error = handlerError;
  if (ctx.planResolved === false && !handlerError) {
    payload.handler_error =
      "plan_code non resolu : repli applique, voir pending_provisionings.last_error";
  }

  const { error } = await admin.from("billing_events").insert({
    organization_id: ctx.organizationId,
    subscription_id: ctx.subscriptionId,
    type: event.type,
    payload,
  });

  if (error) {
    console.error("[billing_events] insert failed", {
      message: error.message,
      event_id: event.id,
      event_type: event.type,
    });
  }
}

// v4 : quatre sources, de la plus explicite a la plus resistante.
//   1. metadonnee plan_code sur l'abonnement
//   2. metadonnee plan_code sur le prix
//   3. secrets STRIPE_PRICE_*
//   4. montant reellement paye, compare a public.plans
async function resolvePlanCode(sub: Stripe.Subscription): Promise<string | null> {
  const fromSub = sub.metadata?.plan_code as string | undefined;
  if (fromSub) return fromSub;

  const item = sub.items.data[0];
  const priceId = item?.price?.id;

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

  const fromAmount = await planCodeFromAmount(item);
  if (fromAmount) {
    console.warn(
      "[stripe-webhook] plan resolu par le MONTANT, pas par la configuration Stripe.",
      "Poser la metadonnee plan_code sur le prix",
      priceId ?? "(inconnu)",
    );
    return fromAmount;
  }

  return null;
}

// Correspondance par montant contre public.plans. On exige que la ligne soit
// active et que la periode corresponde. Ambiguite (deux plans actifs au meme
// montant) => on refuse de deviner et on renvoie null.
async function planCodeFromAmount(
  item: Stripe.SubscriptionItem | undefined,
): Promise<string | null> {
  const amount = item?.price?.unit_amount;
  const currency = item?.price?.currency;
  const interval = item?.price?.recurring?.interval;
  if (amount == null || !currency || !interval) return null;

  const { data, error } = await admin
    .from("plans")
    .select("code")
    .eq("price_cents", amount)
    .eq("currency", currency.toUpperCase())
    .eq("interval", interval)
    .eq("is_active", true);

  if (error) {
    console.warn("[stripe-webhook] lookup plan par montant en echec", error.message);
    return null;
  }
  if (!data || data.length !== 1) {
    if (data && data.length > 1) {
      console.error(
        "[stripe-webhook] plusieurs plans actifs au meme montant, resolution impossible",
        amount,
        currency,
      );
    }
    return null;
  }
  return data[0].code as string;
}

async function upsertSubscription(
  sub: Stripe.Subscription,
  orgIdFromSession?: string,
  forcedStatus?: string,
  planCodeHint?: string,
): Promise<UpsertResult> {
  const organizationId =
    orgIdFromSession ??
    (sub.metadata?.organization_id as string | undefined) ??
    (await organizationIdFromCustomer(sub)) ??
    null;

  // v4 : si l'appelant a deja resolu le plan, on ne refait pas le travail.
  const resolvedPlan = planCodeHint ?? (await resolvePlanCode(sub));
  const planResolved = resolvedPlan !== null;
  const planCode = resolvedPlan ?? FALLBACK_PLAN;

  if (!organizationId) {
    console.warn("[stripe-webhook] subscription without organization_id", sub.id, {
      plan_code: planCode,
    });
    return { organizationId: null, subscriptionId: null, planCode, planResolved };
  }

  // v4 : on n'abandonne plus la ligne d'abonnement quand le plan n'est pas
  // resolu. C'etait le vrai degat : sans ligne dans `subscriptions`,
  // private.tenant_plan_code() renvoie 'starter' et le portail de facturation
  // n'a rien a montrer.
  if (!planResolved) {
    console.error("[stripe-webhook] " + planUnresolvedMessage(sub));
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

  return { organizationId, subscriptionId, planCode, planResolved };
}

async function organizationIdFromCustomer(sub: Stripe.Subscription): Promise<string | null> {
  const customerId = typeof sub.customer === "string" ? sub.customer : sub.customer?.id;
  if (!customerId) return null;

  const { data: bySub } = await admin
    .from("subscriptions")
    .select("organization_id")
    .eq("provider_subscription_id", sub.id)
    .maybeSingle();
  if (bySub?.organization_id) return bySub.organization_id as string;

  const { data: byCustomer } = await admin
    .from("subscriptions")
    .select("organization_id")
    .eq("provider_customer_id", customerId)
    .limit(1)
    .maybeSingle();
  if (byCustomer?.organization_id) return byCustomer.organization_id as string;

  const { data: pending } = await admin
    .from("pending_provisionings")
    .select("organization_id")
    .eq("stripe_customer_id", customerId)
    .not("organization_id", "is", null)
    .limit(1)
    .maybeSingle();
  return (pending?.organization_id as string) ?? null;
}

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
  if (ctx.planResolved === false) patch.last_error = planUnresolvedMessage(sub);

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
