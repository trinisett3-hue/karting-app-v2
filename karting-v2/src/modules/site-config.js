/* =============================================================================
   TRINISETTE — Configuration publique du site (thème + avatars)
   -----------------------------------------------------------------------------
   Ce module existe pour UNE raison : la page publique de résultats a besoin de
   deux informations qui viennent de la base AVANT de dessiner quoi que ce soit —
   le thème (classic / neon / carbon) et la configuration d'avatars du tenant
   (pack autorisé ou non, type, fond, forme). Les deux venaient jusqu'ici de deux
   endroits différents, et l'une d'elles n'existait pas encore.

   Pourquoi un module dédié, et pas deux appels dans public-results.js ?

   1. results-app.js n'attend RIEN :

          results.initTheme();
          results.initNav();
          results.initPdfFullButton();
          results.load();

      Quatre appels lancés à la suite, aucun `await`. Si initTheme() devient
      asynchrone (et il le devient : il passe par un RPC), il court alors contre
      load(). Selon lequel des deux répond le premier, les avatars sont dessinés
      AVANT que la configuration soit appliquée — donc en repli classique, une
      fois sur deux, sans erreur ni trace. Un bug de course est le pire type de
      bug à diagnostiquer en production : il ne se reproduit pas sur la machine
      du développeur, dont le cache répond en 2 ms.

      La promesse est donc mémoïsée ici, au niveau du module. Les deux appelants
      font `await loadSiteConfig()` : le premier déclenche la requête, le second
      attend la même promesse. Un seul aller-retour réseau, et l'ordre est
      garanti quel que soit le point d'entrée.

   2. La configuration d'avatars est une décision COMMERCIALE, et elle est prise
      côté serveur. public_site_config() est SECURITY DEFINER : c'est Postgres,
      pas le navigateur, qui décide si ce tenant a droit au pack Signature
      (`private.avatar_config()` force pack='classic' si l'entitlement
      'avatars_signature' est absent). Le client ne fait qu'obéir. Concentrer
      l'appel ici garantit qu'il n'existe qu'un seul endroit dans tout le
      frontend où cette réponse est interprétée.

   ATTENTION — le paramètre d'URL s'appelle `result`, pas `token`.
   results.js publie `'/results.html?result=' + token`, et load() lit bien
   `.get('result')`. Un `.get('token')` renverrait null, public_site_config()
   renverrait NULL, et on perdrait SILENCIEUSEMENT le thème ET les avatars sur
   toutes les pages publiées. C'est exactement l'erreur que contenait la première
   rédaction de l'annexe B.

   Dépendances : ../lib/supabase.js, ./signature-avatar.js
   ========================================================================== */

import { db } from '../lib/supabase.js';
import {
  configureSignatureAvatars,
  wireSignatureAvatarFallback
} from './signature-avatar.js';

/* Ce que l'on applique quand la base ne répond pas, ne connaît pas le token, ou
   n'a rien à dire. Jamais d'exception qui remonte : une page de résultats doit
   s'afficher même si la configuration est indisponible — au pire en thème par
   défaut avec les avatars classiques. */
const FALLBACK = Object.freeze({
  settings: {},
  avatars: { pack: 'classic', entitled: false, plan: 'free' }
});

let pending = null;

/** Le token de résultats de l'URL courante, ou null. */
export function resultsToken() {
  try {
    return new URLSearchParams(window.location.search).get('result');
  } catch (e) {
    return null;
  }
}

function apply(cfg) {
  // configureSignatureAvatars() complète avec ses propres DEFAULTS : les clés
  // absentes de la réponse serveur (base_url notamment, que la base ne connaît
  // pas) reprennent leur valeur par défaut au lieu de devenir undefined.
  configureSignatureAvatars(cfg.avatars);
  // À câbler même quand le pack est inactif : si la config change en cours de
  // session (rare, mais possible via une preview), l'écouteur est déjà en place.
  wireSignatureAvatarFallback();
  return cfg;
}

/**
 * Charge — une seule fois par page — la configuration publique du site.
 * Retourne toujours { settings, avatars }, jamais une exception.
 */
export function loadSiteConfig() {
  if (pending) return pending;

  pending = (async () => {
    const token = resultsToken();
    if (!token) return apply(FALLBACK);

    let data = null;
    try {
      const res = await db.rpc('public_site_config', { _results_token: token });
      // supabase-js v2 ne LÈVE PAS sur erreur SQL/RLS : il résout avec
      // { data, error }. Un try/catch seul ne verrait jamais rien passer.
      if (res.error) throw res.error;
      data = res.data;
    } catch (e) {
      console.warn('[site-config] configuration publique indisponible —' +
        ' repli sur le thème et les avatars par défaut.', e);
      return apply(FALLBACK);
    }

    // public_site_config() renvoie NULL si le token ne correspond à aucune
    // session (lien périmé, faute de frappe). Ce n'est pas une erreur : c'est
    // une absence, et elle se traite comme le repli.
    return apply({
      settings: (data && data.settings) || FALLBACK.settings,
      avatars: (data && data.avatars) || FALLBACK.avatars
    });
  })();

  return pending;
}

/** Uniquement pour les tests et la page de preview : oublie le cache. */
export function resetSiteConfig() {
  pending = null;
}
