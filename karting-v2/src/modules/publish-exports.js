// Publication : televersement des documents et declenchement des e-mails.
//
// Decision d'architecture (choix utilisateur du 30/07) : « le navigateur les
// televerse ». Une Edge Function tourne sous Deno, sans DOM ; elle ne peut pas
// executer html2canvas. C'est donc le navigateur de l'admin qui produit les PDF
// au moment de la publication, les depose dans le bucket prive
// `session-exports`, declare la ligne correspondante dans `session_assets`,
// puis appelle la fonction `send-result-emails` qui se contente de signer les
// fichiers et d'envoyer.
//
// Chemin de stockage : <tenant_id>/<session_id>/<fichier>. Le premier segment
// est ce sur quoi reposent les policies Storage, il n'est pas cosmetique.
import { db } from '../lib/supabase.js';

const BUCKET = 'session-exports';

// Un echec de televersement ne doit JAMAIS empecher la publication : les
// resultats en ligne sont l'essentiel, la piece jointe est un bonus. On
// remonte l'incident sans faire echouer l'appelant.
export async function uploadSessionAsset({ session, kind, blob, registrationId = null, filename }) {
  if (!session || !session.tenant_id || !session.id || !blob) return null;
  const path = session.tenant_id + '/' + session.id + '/' + filename;
  const up = await db.storage.from(BUCKET).upload(path, blob, {
    contentType: blob.type || 'application/pdf',
    // Republier une session doit remplacer le fichier, pas empiler des doublons.
    upsert: true,
  });
  if (up.error) {
    console.warn('[publication] televersement ' + kind + ' impossible :', up.error.message);
    return null;
  }
  // upsert cote table : l'index unique porte sur (session, kind, registration).
  const row = {
    session_id: session.id,
    registration_id: registrationId,
    kind,
    storage_path: path,
    mime_type: blob.type || 'application/pdf',
    byte_size: blob.size || null,
  };
  const ins = await db.from('session_assets').upsert(row, {
    onConflict: 'session_id,kind,registration_id',
  });
  if (ins.error) {
    // Repli : l'upsert peut echouer si l'index unique utilise l'expression
    // coalesce(registration_id, ...) plutot que la colonne nue. On nettoie
    // puis on reinsere, sinon la piece jointe existerait dans Storage sans
    // etre visible de l'Edge Function.
    let q = db.from('session_assets').delete().eq('session_id', session.id).eq('kind', kind);
    q = registrationId ? q.eq('registration_id', registrationId) : q.is('registration_id', null);
    await q;
    const again = await db.from('session_assets').insert(row);
    if (again.error) {
      console.warn('[publication] session_assets ' + kind + ' :', again.error.message);
      return null;
    }
  }
  return path;
}

// Declenche l'envoi immediat. Le cron de rattrapage (toutes les 5 minutes)
// reprendra ce qui a echoue ici : un reseau coupe ne perd donc rien, et la
// prise de file atomique cote SQL empeche le double envoi.
export async function triggerResultEmails() {
  try {
    const { data, error } = await db.functions.invoke('send-result-emails', { body: {} });
    if (error) throw error;
    return data || null;
  } catch (e) {
    console.warn('[publication] envoi immediat indisponible, le cron reprendra :', e.message || e);
    return null;
  }
}
