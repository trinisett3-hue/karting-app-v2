// Facturation — Parametres > Compte
// ---------------------------------------------------------------------------
// Ajoute au panneau Compte une carte "Facturation" qui affiche l'abonnement en
// cours et l'historique des factures Stripe du circuit, avec le PDF de chacune.
//
// Le module est volontairement AUTONOME : il s'injecte lui-meme dans le DOM au
// chargement et ne demande qu'une seule ligne dans admin.html (son <script>).
// Aucune modification de settings.js ni de la barre de sous-onglets n'est donc
// necessaire — la mecanique PARAMS_SUBTABS reste intacte.
//
// Securite : le module ne choisit pas l'organisation. L'Edge Function
// list-invoices deduit l'organisation du JWT de l'appelant. Un admin ne peut
// donc voir que les factures de son propre circuit, meme en bidouillant le
// navigateur.
// ---------------------------------------------------------------------------

import { db } from '../lib/supabase.js';

const PANEL_CANDIDATES = [
  'params-subtab-compte',
  'params-subtab-account',
  'params-subtab-general',
];

const STATUS_LABELS = {
  paid: 'Payée',
  open: 'À payer',
  void: 'Annulée',
  uncollectible: 'Impayée',
};

const SUB_STATUS_LABELS = {
  active: 'Actif',
  trialing: "Période d'essai",
  past_due: 'Paiement en retard',
  canceled: 'Résilié',
  unpaid: 'Impayé',
  incomplete: 'Incomplet',
  incomplete_expired: 'Expiré',
  paused: 'En pause',
};

const PLAN_LABELS = { starter: 'Basique', pro: 'Premium', business: 'Business' };

let loaded = false;

function money(cents, currency) {
  try {
    return new Intl.NumberFormat('fr-FR', {
      style: 'currency',
      currency: currency || 'EUR',
    }).format((cents || 0) / 100);
  } catch {
    return `${((cents || 0) / 100).toFixed(2)} ${currency || 'EUR'}`;
  }
}

function shortDate(iso) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleDateString('fr-FR', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
    });
  } catch {
    return '—';
  }
}

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function findPanel() {
  for (const id of PANEL_CANDIDATES) {
    const el = document.getElementById(id);
    if (el) return el;
  }
  return document.getElementById('panel-parametres');
}

function buildCard() {
  const card = document.createElement('div');
  card.className = 'card';
  card.id = 'billing-card';
  card.innerHTML = `
    <div class="ctitle">Facturation</div>
    <div id="billing-sub" style="font-size:12px;color:var(--mut);margin-bottom:14px">Chargement…</div>
    <div id="billing-list"></div>
    <div id="billing-actions" style="margin-top:14px;display:none">
      <button class="btn btn-ghost btn-sm" id="billing-portal-btn" type="button">
        Gérer mon abonnement et mon moyen de paiement
      </button>
      <div style="font-size:11px;color:var(--mut);margin-top:8px;line-height:1.5">
        Vous serez redirigé vers l'espace sécurisé de Stripe, notre prestataire de paiement.
        Vos coordonnées bancaires ne transitent jamais par TRINISETTE.
      </div>
    </div>`;
  return card;
}

function renderSubscription(sub) {
  const el = document.getElementById('billing-sub');
  if (!el) return;

  if (!sub) {
    el.innerHTML =
      "Aucun abonnement payant sur ce circuit. Une question sur les offres ? Écrivez-nous.";
    return;
  }

  const plan = PLAN_LABELS[sub.planCode] || sub.planCode || '—';
  const status = SUB_STATUS_LABELS[sub.status] || sub.status || '—';
  const renews = sub.currentPeriodEnd ? shortDate(sub.currentPeriodEnd) : null;

  const parts = [
    `Offre <strong style="color:var(--txt)">${esc(plan)}</strong>`,
    `statut <strong style="color:var(--txt)">${esc(status)}</strong>`,
  ];
  if (renews) {
    parts.push(
      sub.cancelAtPeriodEnd
        ? `se termine le <strong style="color:var(--txt)">${renews}</strong>`
        : `prochain renouvellement le <strong style="color:var(--txt)">${renews}</strong>`
    );
  }
  el.innerHTML = parts.join(' · ');
}

function renderInvoices(invoices) {
  const el = document.getElementById('billing-list');
  if (!el) return;

  if (!invoices || !invoices.length) {
    el.innerHTML =
      '<div class="empty">Aucune facture pour le moment. Elles apparaîtront ici dès le premier prélèvement.</div>';
    return;
  }

  const rows = invoices
    .map((inv) => {
      const label = STATUS_LABELS[inv.status] || inv.status || '—';
      const isPaid = inv.status === 'paid';
      const link =
        inv.pdfUrl || inv.hostedUrl
          ? `<a class="btn btn-ghost btn-sm" href="${esc(inv.pdfUrl || inv.hostedUrl)}"
                target="_blank" rel="noopener noreferrer">PDF</a>`
          : '<span style="color:var(--mut);font-size:11px">—</span>';

      return `
      <div style="display:flex;align-items:center;gap:12px;padding:10px 0;border-bottom:1px solid var(--bord)">
        <div style="flex:1 1 auto;min-width:0">
          <div style="font-weight:600;font-size:13px">${shortDate(inv.created)}</div>
          <div style="font-size:11px;color:var(--mut)">
            ${inv.number ? esc(inv.number) + ' · ' : ''}${esc(label)}
          </div>
        </div>
        <div style="flex:0 0 auto;text-align:right">
          <div style="font-weight:700;font-size:13px;${isPaid ? '' : 'color:var(--yel)'}">
            ${money(inv.total, inv.currency)}
          </div>
          <div style="font-size:10px;color:var(--mut)">TTC</div>
        </div>
        <div style="flex:0 0 auto">${link}</div>
      </div>`;
    })
    .join('');

  el.innerHTML = `
    <div style="display:flex;justify-content:space-between;font-size:10px;letter-spacing:.06em;
                color:var(--mut);text-transform:uppercase;padding-bottom:6px;border-bottom:1px solid var(--bord)">
      <span>Date</span><span>Montant</span>
    </div>
    ${rows}`;
}

async function openPortal(btn) {
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Ouverture…';
  try {
    const { data, error } = await db.functions.invoke('billing-portal', {
      body: { returnUrl: window.location.href },
    });
    if (error) throw error;
    if (!data?.url) throw new Error('URL de portail absente');
    window.open(data.url, '_blank', 'noopener');
  } catch (e) {
    console.error('[billing] portail indisponible', e);
    const actions = document.getElementById('billing-actions');
    if (actions) {
      const msg = document.createElement('div');
      msg.className = 'msg';
      msg.style.cssText = 'display:block;margin-top:10px;color:var(--red)';
      msg.textContent =
        "Le portail de facturation n'a pas pu s'ouvrir. Réessayez, ou écrivez-nous et nous réglons ça.";
      actions.appendChild(msg);
    }
  } finally {
    btn.disabled = false;
    btn.textContent = original;
  }
}

async function load() {
  if (loaded) return;
  loaded = true;

  try {
    const { data: sessionData } = await db.auth.getSession();
    if (!sessionData?.session) {
      loaded = false; // pas encore connecte : on retentera a la prochaine ouverture
      return;
    }

    const { data, error } = await db.functions.invoke('list-invoices', { body: {} });
    if (error) throw error;

    renderSubscription(data?.subscription ?? null);
    renderInvoices(data?.invoices ?? []);

    // Le portail Stripe n'a de sens que si un client Stripe existe.
    if (data?.subscription && data.reason !== 'no_stripe_customer') {
      const actions = document.getElementById('billing-actions');
      const btn = document.getElementById('billing-portal-btn');
      if (actions && btn) {
        actions.style.display = 'block';
        btn.addEventListener('click', () => openPortal(btn));
      }
    }
  } catch (e) {
    console.error('[billing] chargement impossible', e);
    const sub = document.getElementById('billing-sub');
    if (sub) {
      sub.textContent =
        "Impossible de charger vos factures pour l'instant. Rechargez la page, ou écrivez-nous.";
    }
    loaded = false;
  }
}

function install() {
  if (document.getElementById('billing-card')) return;

  const panel = findPanel();
  if (!panel) return;

  panel.appendChild(buildCard());

  // On ne sollicite l'API que lorsque la carte devient reellement visible :
  // inutile d'appeler Stripe a chaque ouverture de l'admin.
  const card = document.getElementById('billing-card');
  if ('IntersectionObserver' in window && card) {
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          io.disconnect();
          load();
        }
      },
      { threshold: 0.05 }
    );
    io.observe(card);
  } else {
    load();
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', install);
} else {
  install();
}
