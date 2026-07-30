// Module Auth — connexion admin (Supabase Auth), nécessaire depuis le passage à un
// schéma multi-tenant en base : sans session authentifiée, current_tenant_id() ne
// résout à rien côté Postgres et les policies RLS bloquent toute écriture sur
// sessions/session_registrations/laps/drivers/app_settings.
//
// Les pages publiques (register.html, results.html) n'ont PAS besoin de ce module :
// elles ont leurs propres policies RLS ouvertes (lecture par token, insertion des
// inscriptions), donc elles continuent de fonctionner avec la seule clé anon.
import { db } from '../lib/supabase.js';

export async function getSession() {
  const { data } = await db.auth.getSession();
  return data.session;
}

export async function signIn(email, password) {
  const { data, error } = await db.auth.signInWithPassword({ email, password });
  if (error) throw error;
  return data.session;
}

export async function signUp(email, password) {
  const { data, error } = await db.auth.signUp({ email, password });
  if (error) throw error;
  return data.session;
}

export async function signOut() {
  await db.auth.signOut();
}

// Ajoute (refonte Parametres > Compte, 30/07) : envoie un e-mail de reinitialisation de
// mot de passe a l'utilisateur actuellement connecte. Reprend le mecanisme standard
// Supabase Auth, deja utilise par signIn/signUp ci-dessus — pas de nouveau backend.
export async function requestPasswordReset(email) {
  const { error } = await db.auth.resetPasswordForEmail(email);
  if (error) throw error;
}

export function onAuthStateChange(callback) {
  db.auth.onAuthStateChange((_event, session) => callback(session));
}
