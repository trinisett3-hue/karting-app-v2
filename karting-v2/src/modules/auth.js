// Module Auth — connexion admin (Supabase Auth), nécessaire depuis le passage à un
// schéma multi-tenant en base : sans session authentifiée, current_tenant_id() ne
// résout à rien côté Postgres et les policies RLS bloquent toute écriture sur
// sessions/session_registrations/laps/drivers/app_settings.
//
// Les pages publiques (register.html, results.html) n'ont PAS besoin de ce module :
// elles ont leurs propres policies RLS ouvertes (lecture par token, insertion des
// inscriptions), donc elles continuent de fonctionner avec la seule clé anon.
import { db } from '../lib/supabase.js';
import { APP_CONFIG } from '../config.js';

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
// redirectTo est indispensable : sans lui, Supabase renvoie vers le Site URL du projet,
// donc le client atterrissait sur l'admin avec un jeton de recuperation que PERSONNE
// n'exploitait — aucun ecran ne lui demandait son nouveau mot de passe. On pointe
// explicitement sur la page admin de CETTE instance (baseUrl = window.location.origin,
// jamais un domaine ecrit en dur) ; admin.html etant servie a la racine, Cloudflare Pages
// expose l'URL propre /admin.
export async function requestPasswordReset(email) {
  const { error } = await db.auth.resetPasswordForEmail(email, {
    redirectTo: APP_CONFIG.baseUrl + '/admin',
  });
  if (error) throw error;
}

// Mise a jour du mot de passe de l'utilisateur courant. Fonctionne aussi bien avec une
// session normale qu'avec la session temporaire creee par le lien de recuperation :
// c'est ce qui permet au parcours "mot de passe oublie" de se terminer sans backend.
export async function updatePassword(newPassword) {
  const { error } = await db.auth.updateUser({ password: newPassword });
  if (error) throw error;
}

// Le type d'evenement est transmis en 2e argument (la session reste en 1er, pour ne pas
// casser les appelants existants) : l'admin doit pouvoir distinguer PASSWORD_RECOVERY
// d'une connexion ordinaire, sinon le lien de reinitialisation ouvrirait simplement
// l'application au lieu de l'ecran de choix du nouveau mot de passe.
export function onAuthStateChange(callback) {
  db.auth.onAuthStateChange((event, session) => callback(session, event));
}
