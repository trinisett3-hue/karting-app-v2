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

export const db = createClient(APP_CONFIG.supabaseUrl, APP_CONFIG.supabaseKey);
