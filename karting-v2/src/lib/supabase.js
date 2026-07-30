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
// `j` = page d'accueil du circuit atteinte par la plaque QR imprimée (j.html?c=<token>).
const isPublicPage = /(^|\/)(register|results|j)(\.html)?$/.test(window.location.pathname);

export const db = isPublicPage
? createClient(APP_CONFIG.supabaseUrl, APP_CONFIG.supabaseKey, {
auth: { persistSession: false, autoRefreshToken: false, storageKey: 'sb-public-anon' },
})
: createClient(APP_CONFIG.supabaseUrl, APP_CONFIG.supabaseKey);

// --- Pagination obligatoire (P0-5, audit 2026-07-30) -----------------------------------
//
// PostgREST plafonne CHAQUE réponse à `max_rows` (1000 par défaut chez Supabase) et
// ne remonte AUCUNE erreur quand la limite est atteinte : la réponse est simplement
// tronquée. Un `select('*')` sans `.range()` sur `laps` est donc une bombe à
// retardement — dès ~1000 tours (soit une cinquantaine de sessions), les classements
// et les statistiques deviennent silencieusement faux.
//
// `fetchAll` pagine jusqu'à épuisement. Trois contraintes importantes :
//  1. On reconstruit la requête à chaque page : un PostgrestFilterBuilder est un
//     thenable à usage unique, on ne peut pas le réutiliser après un await.
//  2. On ajoute un `.order()` déterministe : sans ORDER BY total, PostgreSQL ne
//     garantit aucun ordre stable entre deux pages, donc une pagination par OFFSET
//     peut dupliquer ou perdre des lignes. `.order()` s'AJOUTE aux tris déjà posés
//     par l'appelant (postgrest-js concatène) : le tri d'affichage est conservé et
//     `orderBy` ne sert que de départage.
//  3. `.range()` de postgrest-js v1 écrit les paramètres d'URL `limit`/`offset`
//     (et non l'en-tête Range), ce qui fonctionne aussi sur `.rpc()` d'une fonction
//     qui renvoie une TABLE. Garde-fou quand même : si deux pages consécutives
//     commencent par la même ligne, la pagination n'est pas honorée et on s'arrête
//     au lieu de boucler.
export const PAGE_SIZE = 1000;
const HARD_CAP = 200000; // garde-fou mémoire navigateur (~200k lignes)

function firstRowSig(page) {
try {
return page.length ? JSON.stringify(page[0]) : '';
} catch (e) {
return '';
}
}

export async function fetchAll(buildQuery, opts) {
const o = opts || {};
const pageSize = o.pageSize || PAGE_SIZE;
const orderBy = o.orderBy ? (Array.isArray(o.orderBy) ? o.orderBy : [o.orderBy]) : ['id'];
const hardCap = o.hardCap || HARD_CAP;
const out = [];
let prevSig = null;
for (let from = 0; ; from += pageSize) {
let q = buildQuery();
for (let c = 0; c < orderBy.length; c++) q = q.order(orderBy[c], { ascending: true });
const { data, error } = await q.range(from, from + pageSize - 1);
if (error) return { data: null, error, truncated: false };
const page = data || [];
const sig = firstRowSig(page);
if (from > 0 && sig && sig === prevSig) {
console.warn('[fetchAll] pagination non honoree par le serveur — arret apres ' + out.length + ' lignes');
return { data: out, error: null, truncated: true };
}
prevSig = sig;
for (let i = 0; i < page.length; i++) out.push(page[i]);
if (page.length < pageSize) return { data: out, error: null, truncated: false };
if (out.length >= hardCap) {
console.warn('[fetchAll] garde-fou atteint (' + hardCap + ' lignes) — resultat tronque');
return { data: out, error: null, truncated: true };
}
}
}

// Variante pour les filtres `.in(col, ids)` : au-delà de ~600 UUID, l'URL générée
// dépasse la limite de taille des en-têtes HTTP et PostgREST répond 414. On découpe
// la liste en tranches, chaque tranche étant elle-même paginée.
export async function fetchAllIn(buildQuery, column, ids, opts) {
const o = opts || {};
const chunkSize = o.chunkSize || 400;
const list = Array.from(new Set((ids || []).filter(Boolean)));
if (!list.length) return { data: [], error: null, truncated: false };
const out = [];
let truncated = false;
for (let i = 0; i < list.length; i += chunkSize) {
const chunk = list.slice(i, i + chunkSize);
const res = await fetchAll(() => buildQuery().in(column, chunk), o);
if (res.error) return { data: null, error: res.error, truncated: false };
for (let k = 0; k < res.data.length; k++) out.push(res.data[k]);
if (res.truncated) truncated = true;
}
return { data: out, error: null, truncated };
}
