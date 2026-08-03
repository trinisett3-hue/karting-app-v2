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
//   EMAIL_FROM       "Karting X <resultats@trinisette.fr>"
//   EMAIL_REPLY_TO   optionnel
//   PUBLIC_APP_URL   https://app.trinisette.fr   (origine de l'application, SANS / final)
//
// 03/08 : PUBLIC_APP_URL est la SEULE origine ecrite en dur de tout le systeme. Le
// navigateur, lui, deduit toujours la sienne de window.location.origin (APP_CONFIG.baseUrl) ;
// ici il n'y a pas de navigateur, donc il faut la lui donner. Si ce secret est faux, les
// e-mails partent quand meme mais le lien "Voir mes resultats" pointe dans le vide.
// Valeurs de reference et procedure : docs/DEPLOIEMENT.md.
//
// Deployee avec verify_jwt = false : pg_cron n'a pas de JWT a presenter, et
// la fonction ne fait rien d'autre que vider une file deja constituee.
// SUPABASE_URL et SUPABASE_SERVICE_ROLE_KEY sont injectes par la plateforme.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const BUCKET = 'session-exports';
const SIGNED_URL_TTL = 60 * 60 * 24 * 30; // 30 jours : le pilote ouvre parfois son e-mail bien plus tard.

// 01/08 : sans en-tetes CORS, l'appel immediat depuis le navigateur de l'admin
// (db.functions.invoke au clic sur « Publier ») etait rejete par le
// pre-vol du navigateur. L'admin voyait « envoi en cours » et les e-mails ne
// partaient qu'au tour de cron suivant, jusqu'a 5 minutes plus tard — au point
// que la publication semblait n'avoir rien envoye du tout.
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const JSON_HEADERS = { ...CORS, 'Content-Type': 'application/json' };

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

// 01/08 : le corps de l'e-mail ne porte plus AUCUN theme ni couleur de marque.
// Demande explicite : « pas de theme dans le corps du mail, juste du texte ».
// On garde une enveloppe HTML minimale (les clients mail rendent mal le
// text/plain brut envoye en `html`), mais sans fond, sans carte, sans bouton
// colore : police systeme, texte noir sur blanc, un seul lien souligne.
// Piste notee pour plus tard : des modeles d'e-mail choisis dans l'app par le
// centre, reserves aux offres superieures.

// Date ISO (2026-08-01) -> « samedi 1er aout 2026 ».
const JOURS = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'];
const MOIS = ['janvier', 'fevrier', 'mars', 'avril', 'mai', 'juin', 'juillet', 'aout', 'septembre', 'octobre', 'novembre', 'decembre'];

function dateLisible(iso: string | null) {
  if (!iso) return '';
  const m = String(iso).slice(0, 10).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return String(iso);
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  if (isNaN(d.getTime())) return String(iso);
  const jour = +m[3];
  return JOURS[d.getUTCDay()] + ' ' + (jour === 1 ? '1er' : jour) + ' ' + MOIS[+m[2] - 1] + ' ' + m[1];
}

function buildHtml(g: Delivery[], attachments: Array<{ filename: string; url: string }>, kinds: string[]) {
  const head = g[0];
  // Le pseudo, jamais le nom civil — contrainte metier constante du projet.
  const who = head.display_name || head.first_name || 'Pilote';
  const venue = head.venue_name || '';
  // 01/08 : `/results` et non `/results.html` — Cloudflare Pages repond 308 sur
  // la forme avec extension, et certains clients mail suivent mal la redirection.
  const link = env('PUBLIC_APP_URL') && head.results_token
    ? env('PUBLIC_APP_URL').replace(/\/+$/, '') + '/results?result=' + encodeURIComponent(head.results_token)
    : '';
  const hasRecord = g.some((d) => d.kind === 'record' || d.kind === 'record_card');
  // Correctif audit 30/07 : ne PAS annoncer une piece jointe qui n'existe pas.
  const recordCardAttached = attachments.some((a) => a.filename.indexOf('carte-record') === 0);

  const seance = head.session_title || 'ta session';
  const quand = dateLisible(head.session_date);
  const ou = venue ? ' sur le circuit ' + esc(venue) : '';

  const paras: string[] = [];
  paras.push('Bonjour ' + esc(who) + ',');
  paras.push(
    'Tu as pilote a la seance <strong>' + esc(seance) + '</strong>' +
    (quand ? ' du ' + esc(quand) : '') + ou + '. ' +
    'Tes resultats viennent d\'etre publies.'
  );
  if (hasRecord) {
    paras.push(
      recordCardAttached
        ? 'Tu as battu un record sur cette seance — bravo. Ta carte de record est jointe a cet e-mail.'
        : 'Tu as battu un record sur cette seance — bravo !'
    );
  }
  if (attachments.length) {
    paras.push(
      'Tu trouveras en piece jointe :<br>' +
      kinds.map((k) => '&bull; ' + esc(LABELS[k] || k)).join('<br>')
    );
  }
  if (link) {
    paras.push('Le classement complet reste consultable en ligne : <a href="' + esc(link) + '">voir le classement</a>.');
  }
  paras.push(
    'Merci d\'etre venu rouler. On espere te revoir tres vite sur la piste pour ameliorer ton chrono — ' +
    'les prochaines seances sont ouvertes aux inscriptions.'
  );
  paras.push('Bonne route,<br>' + esc(venue || 'L\'equipe'));

  return `<!DOCTYPE html><html lang="fr"><body style="margin:0;padding:0;background:#ffffff">
<div style="max-width:600px;margin:0 auto;padding:24px 20px;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.6;color:#000000">
${paras.map((p) => '  <p style="margin:0 0 16px">' + p + '</p>').join('\n')}
  <p style="margin:24px 0 0;font-size:12px;color:#666666">
    Tu recois cet e-mail parce que tu t'es inscrit a cette seance.${attachments.length ? ' Les pieces jointes restent telechargeables pendant 30 jours.' : ''}
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
  // Pre-vol CORS : le navigateur de l'admin l'envoie avant le POST.
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: CORS });
  }
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'POST attendu' }), { status: 405, headers: JSON_HEADERS });
  }
  if (!env('EMAIL_API_KEY') || !env('EMAIL_FROM')) {
    return new Response(
      JSON.stringify({ error: 'EMAIL_API_KEY et EMAIL_FROM ne sont pas configures.' }),
      { status: 500, headers: JSON_HEADERS }
    );
  }

  let requeued = 0;
  try {
    const { data } = await admin.rpc('requeue_stuck_deliveries');
    requeued = Number(data || 0);
  } catch { /* non bloquant : le rattrapage se fera au tour suivant */ }

  const { data: claimed, error } = await admin.rpc('claim_card_deliveries', { _limit: 200 });
  if (error) {
    return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: JSON_HEADERS });
  }

  const rows: Delivery[] = Array.isArray(claimed) ? claimed : [];
  if (!rows.length) {
    return new Response(JSON.stringify({ sent: 0, failed: 0, requeued, note: 'file vide' }), { headers: JSON_HEADERS });
  }

  // Regroupement : UN SEUL e-mail par pilote ET PAR SESSION, portant toutes
  // ses pieces jointes (classement, fiche pilote, carte de position, carte de
  // record s'il y en a une).
  // 02/08 — `session_id` ajoute a la cle. Sans lui, un pilote ayant roule sur
  // deux seances publiees dans la meme fenetre de prise de file voyait ses
  // deux seances fusionnees dans un seul e-mail : mauvais titre, mauvaise
  // date, pieces jointes melangees. Un envoi = une seance.
  // Un anonyme sans registration_id ne devrait pas arriver ici (pas d'e-mail),
  // mais on retombe sur l'adresse par securite.
  const groups = new Map<string, Delivery[]>();
  for (const r of rows) {
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
    headers: JSON_HEADERS,
  });
});
