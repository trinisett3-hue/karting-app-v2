// Client Supabase partagé — un seul point d'initialisation pour tous les modules.
// Le SDK Supabase (@supabase/supabase-js@2, chargé en <script> global dans les pages)
// expose `window.supabase`. On l'utilise pour créer le client une seule fois ici,
// puis on le réexporte pour les modules (sessions, registrations, results, ui...).
import { APP_CONFIG } from '../config.js';

if (typeof window.supabase === 'undefined') {
throw new Error(
"Le SDK Supabase n'est pas chargé. Vérifie que " +
'<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script> ' +
'est bien présent avant le <script type="module"> qui importe ce fichier.'
);
}

const { createClient } = window.supabase;

// Les pages publiques (inscription par QR + résultats publics) partagent la même
// origine que l'admin. Or le SDK Supabase persiste la session de l'admin connecté
// dans le localStorage de cette origine. Sans précaution, quand un admin ouvre le
// lien d'inscription ou de résultats dans le même navigateur, le client enverrait
// son JWT `authenticated` : l'isolation par tenant (RLS) masque alors les sessions
// des autres tenants et la page affiche "Session introuvable" / "Résultats
// indisponibles". Un vrai pilote sur son téléphone (sans session admin) fonctionne
// en anon, mais le cas admin est cassé et fragile.
//
// Solution : sur ces pages publiques, on force un client strictement anonyme
// (aucune session persistée, storageKey dédié pour ne jamais lire le token admin).
// L'admin (admin.html) garde le client normal avec session persistée.
const isPublicPage = /(^|\/)(register|results)(\.html)?$/.test(window.location.pathname);

export const db = isPublicPage
? createClient(APP_CONFIG.supabaseUrl, APP_CONFIG.supabaseKey, {
auth: { persistSession: false, autoRefreshToken: false, storageKey: 'sb-public-anon' },
})
: createClient(APP_CONFIG.supabaseUrl, APP_CONFIG.supabaseKey);
