// =====================================================================
// PUBLICATION — GENERATION DE TOUTES LES PIECES JOINTES PDF
//
// Demande client du 30/07 : « Il faut que tous les PDF soient des pieces
// jointes. » Concretement, un pilote doit recevoir a la publication :
//   - le classement complet de la session (commun a tout le monde) ;
//   - SA fiche pilote (tours, meilleur tour, palmares) — personnelle.
//
// Contrainte technique de fond : ces deux documents sont produits par
// html2canvas + jsPDF, donc par un NAVIGATEUR. Une Edge Function Deno n'a pas
// de DOM et ne peut pas les rendre. C'est le choix d'architecture deja acte le
// 30/07 (« le navigateur les televerse ») : le navigateur de l'admin rend, puis
// depose dans le bucket prive `session-exports` ; l'Edge Function ne fait plus
// que signer et envoyer.
//
// POURQUOI UNE IFRAME. Le moteur de rendu soigne (podium, avatars Signature,
// pagination, theme du circuit, logo) vit dans public-results.js et depend
// d'une quinzaine de variables de module. Le porter cote admin voudrait dire le
// dupliquer, donc le maintenir en double et accepter qu'un jour la piece jointe
// ne ressemble plus a ce que le pilote telecharge. On charge donc la vraie page
// publique dans une iframe cachee de MEME ORIGINE et on lui demande ses PDF :
// la piece jointe est octet pour octet le fichier du pilote.
//
// L'iframe est positionnee hors ecran mais avec de VRAIES dimensions :
// display:none donnerait une mise en page de taille zero et html2canvas
// produirait des pages vides.
import { db } from '../lib/supabase.js';
import { uploadSessionAsset } from './publish-exports.js';

const IFRAME_LOAD_TIMEOUT = 45000; // chargement de la page + donnees
const BRIDGE_TIMEOUT = 60000;      // fin de load() cote public (RPC + avatars)
const PDF_TIMEOUT = 120000;        // rendu d'un document (grille tres fournie)

function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('Delai depasse : ' + label)), ms); }),
  ]).finally(() => clearTimeout(timer));
}

function slug(s) {
  return String(s || 'pilote')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40) || 'pilote';
}

// URL RELATIVE volontairement : APP_CONFIG.baseUrl peut pointer sur le domaine
// de production alors qu'on travaille en local, et l'iframe serait alors d'une
// autre origine — window.__kartingExport deviendrait inaccessible. Repartir de
// window.location garantit la meme origine, donc l'acces direct au pont.
function exportUrl(token) {
  // Racine de l'origine courante, et non un chemin relatif : selon la facon
  // dont Cloudflare Pages sert admin.html (avec ou sans extension, avec ou
  // sans slash final), un « results.html » relatif pourrait resoudre vers un
  // sous-dossier inexistant. Les pages du projet sont toutes a la racine.
  const u = new URL('/results.html', window.location.origin);
  u.searchParams.set('result', token);
  u.searchParams.set('export', '1');
  return u.toString();
}

function openHiddenFrame(url) {
  const iframe = document.createElement('iframe');
  iframe.setAttribute('aria-hidden', 'true');
  iframe.setAttribute('tabindex', '-1');
  iframe.setAttribute('title', 'Generation des PDF');
  iframe.style.cssText =
    'position:fixed;left:-20000px;top:0;width:1280px;height:1000px;border:0;opacity:0;pointer-events:none';
  const loaded = new Promise((resolve, reject) => {
    iframe.addEventListener('load', () => resolve(), { once: true });
    iframe.addEventListener('error', () => reject(new Error('Page de resultats illisible')), { once: true });
  });
  iframe.src = url;
  document.body.appendChild(iframe);
  return { iframe, loaded };
}

// Les scripts de type module sont differes : ils s'executent avant l'evenement
// load. Le pont devrait donc etre la des `loaded`. On sonde quand meme, une
// seconde au plus : c'est le genre de garantie qui coute peu et evite un echec
// non reproductible.
async function waitForBridge(iframe) {
  for (let i = 0; i < 40; i++) {
    const api = iframe.contentWindow && iframe.contentWindow.__kartingExport;
    if (api) return api;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('Pont d\'export absent (page publique non chargee ?)');
}

// Priorite quand un pilote bat plusieurs records de portees differentes
// dans la meme session (ex : record piste ET record personnel). L'index
// unique de session_assets est (session_id, kind, registration_id) : un
// seul asset `record_card` peut exister par pilote et par session, donc un
// seul des records peut etre illustre. On retient le plus prestigieux.
const RECORD_SCOPE_PRIORITY = ['piste', 'semaine', 'mois', 'perso'];

function pickPrimaryRecord(rows) {
  for (const scope of RECORD_SCOPE_PRIORITY) {
    const hit = rows.find((r) => r.scope === scope);
    if (hit) return hit;
  }
  return rows[0] || null;
}

/**
 * Genere et televerse le classement complet + une fiche par pilote destinataire,
 * puis les cartes partageables (position pour tous les destinataires, record pour
 * ceux qui viennent d'en battre un). Meme iframe cachee, meme pont, pour tout.
 *
 * @param {object}   session      ligne `sessions` complete (tenant_id requis)
 * @param {function} onProgress   (fait, total, libelle) — messages d'attente
 * @returns {Promise<{full:boolean, pilots:number, failed:number, total:number, skipped:number,
 *                     positionCards:number, recordCards:number, cardsFailed:number}>}
 */
export async function generateSessionPDFs(session, onProgress) {
  const report = {
    full: false, pilots: 0, failed: 0, total: 0, skipped: 0,
    positionCards: 0, recordCards: 0, cardsFailed: 0,
  };
  const token = session && session.public_results_token;
  if (!token) throw new Error('Session sans jeton public : rien a rendre.');
  const say = typeof onProgress === 'function' ? onProgress : () => {};

  // Qui recoit reellement un e-mail ? Inutile de rendre la fiche d'un inscrit
  // sans adresse (ajout manuel anonyme) : c'est du temps de rendu pur perdu, et
  // le rendu tourne dans le navigateur de l'admin qui attend.
  const { data: regs, error: rErr } = await db
    .from('session_registrations')
    .select('id,email,display_name')
    .eq('session_id', session.id);
  if (rErr) throw rErr;
  // Meme critere EXACT que enqueue_position_cards cote SQL (length(trim) > 3) :
  // rendre une fiche pour quelqu'un qui n'aura jamais de ligne de file serait du
  // temps de rendu offert au vide, dans le navigateur de l'admin qui attend.
  const recipients = (regs || []).filter((r) => (r.email || '').trim().length > 3);
  report.skipped = (regs || []).length - recipients.length;

  const { iframe, loaded } = openHiddenFrame(exportUrl(token));
  try {
    await withTimeout(loaded, IFRAME_LOAD_TIMEOUT, 'chargement de la page de resultats');
    const api = await waitForBridge(iframe);
    await withTimeout(Promise.resolve(api.ready), BRIDGE_TIMEOUT, 'chargement des donnees de la session');

    // 1. Le classement complet — un seul fichier pour toute la session.
    say(0, recipients.length + 1, 'classement');
    try {
      const buf = await withTimeout(api.fullPDFBytes(), PDF_TIMEOUT, 'rendu du classement');
      const path = await uploadSessionAsset({
        session,
        kind: 'full_pdf',
        blob: new Blob([buf], { type: 'application/pdf' }),
        filename: 'classement.pdf',
      });
      report.full = !!path;
    } catch (e) {
      report.failed++;
      console.warn('[publication] classement PDF :', e.message || e);
    }

    // 2. Une fiche par destinataire. Le pont ne connait que les inscrits
    //    presents dans le classement public : on croise sur regId.
    const known = new Set((api.listPilots() || []).map((p) => p.regId));
    let done = 1;
    for (const reg of recipients) {
      report.total++;
      const label = reg.display_name || 'pilote';
      if (!known.has(reg.id)) {
        // Cas theorique (inscription creee entre le chargement de l'iframe et
        // maintenant). Pas d'echec bloquant : le pilote recevra le classement.
        report.failed++;
        console.warn('[publication] fiche ignoree, pilote absent du classement :', label);
        continue;
      }
      say(done, recipients.length + 1, label);
      try {
        const buf = await withTimeout(api.pilotPDFBytes(reg.id), PDF_TIMEOUT, 'rendu de la fiche ' + label);
        // Le nom porte l'identifiant d'inscription : deux pilotes homonymes sur
        // le meme kart ecraseraient sinon le meme fichier, et l'un recevrait la
        // fiche de l'autre.
        const path = await uploadSessionAsset({
          session,
          kind: 'pilot_pdf',
          blob: new Blob([buf], { type: 'application/pdf' }),
          registrationId: reg.id,
          filename: 'fiche_' + slug(label) + '_' + String(reg.id).slice(0, 8) + '.pdf',
        });
        if (path) report.pilots++; else report.failed++;
      } catch (e) {
        report.failed++;
        console.warn('[publication] fiche de ' + label + ' :', e.message || e);
      }
      done++;
    }

    // 3. Cartes partageables — dans la MEME iframe, donc le MEME rendu de
    //    session (theme, logo, avatars deja charges) que les PDF ci-dessus.
    //
    //    Position : generee pour CHAQUE destinataire (meme liste `recipients`
    //    que les fiches PDF, meme critere que enqueue_position_cards() cote
    //    SQL). On NE LIT PAS card_deliveries pour ca : cette RPC n'est
    //    appelee qu'APRES ce rendu (voir results.js/afterPublish), justement
    //    pour qu'aucune ligne de file n'existe tant que la piece jointe n'est
    //    pas televersee — meme raison que pour les PDF (cf. commentaire en
    //    tete de afterPublish : un cron qui partirait entre-temps enverrait
    //    un e-mail sans carte, irreparable une fois la ligne marquee 'sent').
    //
    //    Record : les lignes existent deja (le trigger SQL les enfile tour
    //    par tour, independamment de la publication) ; on les lit pour savoir
    //    qui vient de battre un record, et sur quelle(s) portee(s).
    const { data: recordDeliveries, error: dErr } = await db
      .from('card_deliveries')
      .select('registration_id,kind,scope,payload')
      .eq('session_id', session.id)
      .eq('status', 'pending')
      .eq('kind', 'record');
    if (dErr) {
      console.warn('[publication] lecture de la file des cartes record :', dErr.message);
    }
    {
      const byPilot = new Map();
      for (const reg of recipients) {
        if (!known.has(reg.id)) continue;
        byPilot.set(reg.id, { position: true, records: [] });
      }
      for (const d of (recordDeliveries || [])) {
        if (!d.registration_id) continue;
        if (!byPilot.has(d.registration_id)) byPilot.set(d.registration_id, { position: false, records: [] });
        byPilot.get(d.registration_id).records.push(d);
      }

      for (const [regId, entry] of byPilot) {
        if (!known.has(regId)) continue; // meme garde-fou que pour les fiches PDF
        const pilotLabel = (recipients.find((r) => r.id === regId) || {}).display_name || 'pilote';

        if (entry.position) {
          try {
            const buf = await withTimeout(api.positionCardPNGBytes(regId), PDF_TIMEOUT, 'carte de position ' + pilotLabel);
            const path = await uploadSessionAsset({
              session,
              kind: 'position_card',
              blob: new Blob([buf], { type: 'image/png' }),
              registrationId: regId,
              filename: 'carte-position_' + slug(pilotLabel) + '_' + String(regId).slice(0, 8) + '.png',
            });
            if (path) report.positionCards++; else report.cardsFailed++;
          } catch (e) {
            report.cardsFailed++;
            console.warn('[publication] carte de position de ' + pilotLabel + ' :', e.message || e);
          }
        }

        if (entry.records.length) {
          const primary = pickPrimaryRecord(entry.records);
          if (entry.records.length > 1) {
            console.warn('[publication] ' + pilotLabel + ' a battu ' + entry.records.length +
              ' records dans cette session ; un seul asset record_card est televersable (index unique), portee retenue : ' + primary.scope);
          }
          try {
            const buf = await withTimeout(
              api.recordCardPNGBytes(regId, primary.scope, primary.payload || {}),
              PDF_TIMEOUT, 'carte de record ' + pilotLabel
            );
            const path = await uploadSessionAsset({
              session,
              kind: 'record_card',
              blob: new Blob([buf], { type: 'image/png' }),
              registrationId: regId,
              filename: 'carte-record_' + slug(pilotLabel) + '_' + String(regId).slice(0, 8) + '.png',
            });
            if (path) report.recordCards++; else report.cardsFailed++;
          } catch (e) {
            report.cardsFailed++;
            console.warn('[publication] carte de record de ' + pilotLabel + ' :', e.message || e);
          }
        }
      }
    }

    return report;
  } finally {
    // Toujours, y compris sur erreur : une iframe oubliee garderait la page
    // publique vivante dans l'admin (timers, requetes) jusqu'au rechargement.
    if (iframe.parentNode) iframe.parentNode.removeChild(iframe);
  }
}
