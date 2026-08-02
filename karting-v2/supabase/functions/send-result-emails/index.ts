// Edge Function : envoi des resultats par e-mail.
//
// Elle ne RENDE rien. Les PDF et les cartes sont produits par le navigateur
// de l'admin (html2canvas + jsPDF) et televerses dans le bucket prive
// `session-exports` au moment de la publication. Cette fonction lit la file
// `card_deliveries`, signe les fichiers, envoie, et marque.
//
// Deux appelants, tous deux legitimes :
//   - le clic « Publier les resultats » (envoi immediat)
//   - le cron de rattrapage toutes les 5 minutes (echecs reseau)
// La prise de file est atomique cote SQL (claim_card_deliveries, avec
// `for update skip locked`), donc les deux peuvent se croiser sans qu'un
// pilote recoive deux fois le meme e-mail.
//
// Configuration (Supabase > Edge Functions > Secrets) :
//   EMAIL_PROVIDER   resend | brevo        (defaut: resend)
//   EMAIL_API_KEY    la cle du fournisseur
//   EMAIL_FROM       "Karting X <resultats@ton-domaine.fr>"
//   EMAIL_REPLY_TO   optionnel
//   PUBLIC_APP_URL   https://ton-app.pages.dev  (pour le lien resultats)
//
// Deployee avec verify_jwt = false : pg_cron n'a pas de JWT a presenter, et
// la fonction ne fait rien d'autre que vider une file deja constituee.
// SUPABASE_URL et SUPABASE_SERVICE_ROLE_KEY sont injectes par la plateforme.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const BUCKET = 'session-exports';
const SIGNED_URL_TTL = 60 * 60 * 24 * 30; // 30 jours : le pilote ouvre parfois son e-mail bien plus tard.

type Delivery = {
  delivery_id: string;
  session_id: string;
  registration_id: string | null;
  email: string;
  kind: string;
  scope: string | null;
  payload: Record<string, unknown>;
  display_name: string | null;
  first_name: string | null;
  session_title: string | null;
  session_date: string | null;
  results_token: string | null;
  venue_name: string | null;
  assets: Array<{ kind: string; path: string; mime: string }>;
};

const env = (k: string, fallback = '') => Deno.env.get(k) ?? fallback;

const admin = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), {
  auth: { persistSession: false },
});

// --- Fournisseur d'e-mail ----------------------------------------------------
// Abstraction volontairement minuscule : le choix du fournisseur n'est pas
// encore arrete, et il ne doit pas contaminer le reste du code.

type Mail = {
  to: string;
  subject: string;
  html: string;
  attachments: Array<{ filename: string; url: string }>;
};

async function sendViaResend(m: Mail) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + env('EMAIL_API_KEY'),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: env('EMAIL_FROM'),
      reply_to: env('EMAIL_REPLY_TO') || undefined,
      to: [m.to],
      subject: m.subject,
      html: m.html,
      // Resend accepte une URL distante par piece jointe : on n'a donc
      // jamais a charger les PDF en memoire dans la fonction.
      attachments: m.attachments.map((a) => ({ filename: a.filename, path: a.url })),
    }),
  });
  if (!res.ok) throw new Error('Resend ' + res.status + ' : ' + (await res.text()).slice(0, 300));
}

async function sendViaBrevo(m: Mail) {
  const from = env('EMAIL_FROM');
  const match = from.match(/^(.*?)\s*<(.+)>$/);
  const res = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { 'api-key': env('EMAIL_API_KEY'), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sender: { name: match ? match[1] : 'Karting', email: match ? match[2] : from },
      to: [{ email: m.to }],
      subject: m.subject,
      htmlContent: m.html,
      attachment: m.attachments.map((a) => ({ url: a.url, name: a.filename })),
    }),
  });
  if (!res.ok) throw new Error('Brevo ' + res.status + ' : ' + (await res.text()).slice(0, 300));
}

function sendMail(m: Mail) {
  return env('EMAIL_PROVIDER', 'resend') === 'brevo' ? sendViaBrevo(m) : sendViaResend(m);
}

// --- Contenu -----------------------------------------------------------------

function esc(s: unknown) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string)
  );
}

const LABELS: Record<string, string> = {
  full_pdf: 'Classement complet',
  pilot_pdf: 'Ta fiche pilote',
  position_card: 'Ta carte de position',
  record_card: 'Ta carte de record',
};

function filenameFor(kind: string, mime: string) {
  const ext = mime.includes('png') ? 'png' : mime.includes('jpeg') ? 'jpg' : 'pdf';
  const base: Record<string, string> = {
    full_pdf: 'classement-complet',
    pilot_pdf: 'fiche-pilote',
    position_card: 'carte-position',
    record_card: 'carte-record',
  };
  return (base[kind] || 'document') + '.' + ext;
}

function buildHtml(g: Delivery[], attachments: Array<{ filename: string; url: string }>, kinds: string[]) {
  const head = g[0];
  // Le pseudo, jamais le nom civil — contrainte metier constante du projet.
  const who = head.display_name || head.first_name || 'Pilote';
  const venue = head.venue_name || 'Karting';
  const link = env('PUBLIC_APP_URL') && head.results_token
    ? env('PUBLIC_APP_URL').replace(/\/+$/, '') + '/results.html?result=' + encodeURIComponent(head.results_token)
    : '';
  const hasRecord = g.some((d) => d.kind === 'record' || d.kind === 'record_card');
  // Correctif audit 30/07 : ne PAS annoncer une piece jointe qui n'existe pas.
  // Aucun code ne produit encore d'asset `record_card` / `position_card` (le
  // navigateur ne televerse que `full_pdf` et `pilot_pdf`) : le message
  // « Ta carte est en piece jointe » etait donc faux des qu'un record etait
  // detecte. On ne le dit que si la carte est reellement signee et attachee.
  const recordCardAttached = attachments.some((a) => a.filename.indexOf('carte-record') === 0);
  const recordLine = hasRecord
    ? (recordCardAttached
      ? 'Nouveau record battu sur cette session. Ta carte est en piece jointe.'
      : 'Nouveau record battu sur cette session. Felicitations !')
    : '';

  return `<!DOCTYPE html><html lang="fr"><body style="margin:0;background:#06070b;font-family:'Segoe UI',Arial,sans-serif;color:#f5f6fb">
<div style="max-width:560px;margin:0 auto;padding:32px 20px">
  <div style="height:3px;background:linear-gradient(90deg,transparent,#d8b571,transparent);margin-bottom:28px"></div>
  <h1 style="font-size:26px;margin:0 0 6px;text-transform:uppercase;letter-spacing:.02em">${esc(venue)}</h1>
  <p style="color:#8d92ac;margin:0 0 24px;font-size:15px">${esc(head.session_title || 'Session')}${head.session_date ? ' — ' + esc(head.session_date) : ''}</p>

  <div style="background:#12141e;border:1px solid #262a3c;border-radius:16px;padding:20px;margin-bottom:16px">
    <p style="margin:0 0 12px;font-size:17px">Bravo <strong>${esc(who)}</strong>, tes resultats sont en ligne.</p>
    ${recordLine ? '<p style="margin:0 0 12px;padding:10px 12px;background:rgba(216,181,113,.12);border:1px solid rgba(216,181,113,.4);border-radius:10px;color:#d8b571;font-weight:600">' + esc(recordLine) + '</p>' : ''}
    ${attachments.length ? `<p style="margin:0;color:#8d92ac;font-size:14px">${attachments.length} document${attachments.length > 1 ? 's' : ''} en piece jointe :</p>
    <ul style="margin:8px 0 0;padding-left:20px;color:#f5f6fb;font-size:14px">
      ${kinds.map((k) => '<li>' + esc(LABELS[k] || k) + '</li>').join('')}
    </ul>` : ''}
  </div>

  ${link ? `<a href="${esc(link)}" style="display:block;text-align:center;background:linear-gradient(135deg,#ff3b30,#c81e18);color:#fff;text-decoration:none;font-weight:700;font-size:16px;text-transform:uppercase;letter-spacing:.05em;padding:15px;border-radius:14px">Voir le classement en ligne</a>` : ''}

  <p style="color:#5f6480;font-size:12px;text-align:center;margin-top:26px;line-height:1.6">
    Tu recois cet e-mail parce que tu t'es inscrit a cette session.${attachments.length ? '<br/>Les liens des pieces jointes expirent au bout de 30 jours.' : ''}
  </p>
</div></body></html>`;
}

// --- Traitement --------------------------------------------------------------

async function signAssets(items: Array<{ kind: string; path: string; mime: string }>) {
  const out: Array<{ filename: string; url: string; kind: string }> = [];
  for (const a of items) {
    const { data, error } = await admin.storage.from(BUCKET).createSignedUrl(a.path, SIGNED_URL_TTL);
    // Une piece jointe manquante ne doit pas empecher l'envoi : le pilote
    // recoit ce qui existe, et le lien vers le classement en ligne.
    // On trace quand meme : un envoi a zero piece jointe est silencieux sinon,
    // et c'est exactement le genre de panne qu'on ne voit jamais (audit 30/07).
    if (error || !data?.signedUrl) {
      console.warn('[signAssets] asset introuvable, ignore :', a.kind, a.path, error?.message || '');
      continue;
    }
    out.push({ filename: filenameFor(a.kind, a.mime), url: data.signedUrl, kind: a.kind });
  }
  return out;
}

async function handleGroup(g: Delivery[]) {
  // Un pilote = un e-mail, meme s'il a plusieurs lignes en file (carte de
  // position + carte de record). C'est tout l'interet du regroupement.
  const seen = new Set<string>();
  const assets: Array<{ kind: string; path: string; mime: string }> = [];
  for (const d of g) {
    for (const a of d.assets || []) {
      if (a?.path && !seen.has(a.path)) { seen.add(a.path); assets.push(a); }
    }
  }
  const signed = await signAssets(assets);
  const head = g[0];
  const subject = (head.venue_name ? head.venue_name + ' — ' : '') + 'Tes resultats : ' + (head.session_title || 'session');

  await sendMail({
    to: head.email,
    subject,
    html: buildHtml(g, signed, signed.map((s) => s.kind)),
    attachments: signed.map((s) => ({ filename: s.filename, url: s.url })),
  });

  // Toutes les lignes du groupe sont marquees ensemble : elles ont voyage
  // dans le meme e-mail, elles reussissent ou echouent ensemble.
  for (const d of g) {
    await admin.rpc('mark_card_delivery', { _id: d.delivery_id, _ok: true, _error: null });
  }
  return g.length;
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'POST attendu' }), { status: 405, headers: { 'Content-Type': 'application/json' } });
  }
  if (!env('EMAIL_API_KEY') || !env('EMAIL_FROM')) {
    return new Response(
      JSON.stringify({ error: 'EMAIL_API_KEY et EMAIL_FROM ne sont pas configures.' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }

  let requeued = 0;
  try {
    const { data } = await admin.rpc('requeue_stuck_deliveries');
    requeued = Number(data || 0);
  } catch { /* non bloquant : le rattrapage se fera au tour suivant */ }

  const { data: claimed, error } = await admin.rpc('claim_card_deliveries', { _limit: 200 });
  if (error) {
    return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }

  const rows: Delivery[] = Array.isArray(claimed) ? claimed : [];
  if (!rows.length) {
    return new Response(JSON.stringify({ sent: 0, failed: 0, requeued, note: 'file vide' }), { headers: { 'Content-Type': 'application/json' } });
  }

  // Regroupement par pilote. Un anonyme sans registration_id ne devrait pas
  // arriver ici (pas d'e-mail), mais on retombe sur l'adresse par securite.
  const groups = new Map<string, Delivery[]>();
  for (const r of rows) {
    // 02/08 — `session_id` ajoute a la cle : UN SEUL e-mail par pilote ET PAR
    // SESSION, portant toutes ses pieces jointes (classement, fiche pilote,
    // carte de position, carte de record s'il y en a une). Sans lui, un pilote
    // ayant roule sur deux seances publiees dans la meme fenetre de prise de
    // file voyait ses deux seances fusionnees dans un seul e-mail : mauvais
    // titre, mauvaise date, pieces jointes melangees. Un envoi = une seance.
    const key = r.session_id + '|' + (r.registration_id || '') + '|' + r.email.toLowerCase();
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(r);
  }

  let sent = 0;
  let failed = 0;
  const errors: string[] = [];
  for (const g of groups.values()) {
    try {
      sent += await handleGroup(g);
    } catch (e) {
      failed += g.length;
      const msg = (e as Error).message || String(e);
      if (errors.length < 5) errors.push(msg);
      // Repasse en 'pending' : le cron reessaiera, jusqu'a 5 tentatives.
      for (const d of g) {
        await admin.rpc('mark_card_delivery', { _id: d.delivery_id, _ok: false, _error: msg });
      }
    }
  }

  return new Response(JSON.stringify({ sent, failed, requeued, groups: groups.size, errors }), {
    headers: { 'Content-Type': 'application/json' },
  });
});
