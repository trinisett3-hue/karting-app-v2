# TRINISETTE Karting — karting-app-v2

Application de gestion de karting : inscriptions pilotes, résultats publics, administration circuit. Repo statique (HTML + modules ES natifs, sans framework, sans build) déployé sur Cloudflare Pages, backend Supabase (Postgres + Auth + Storage + Edge Functions).

## État actuel (29/07/2026)

- **Authentification admin** : branchée et active depuis le 24/07.
- **RLS** : activée sur toutes les tables métier. Les fonctions publiques (résultats, inscription) passent par des RPC `SECURITY DEFINER` conditionnées à un jeton de session, pas par des policies anonymes ouvertes.
- **Deux offres actives** : Basique (49€/mois, code `starter`) et Premium (129€/mois, code `pro`). Business (`business`, 299€) existe en base mais est désactivée.
- **Gating Premium** : appliqué côté serveur (thèmes, plan du circuit, avatars Signature) — pas seulement dans l'interface. Voir les migrations `enforce_premium_settings_server_side` et suivantes.
- **Paiement Stripe → provisioning** : chemin webhook → `pending_provisionings` → `provision-organization` réconcilié et transactionnel.

## Architecture

- `karting-v2/src/app.js` — point d'entrée admin (`admin.html`), navigation entre onglets.
- `karting-v2/src/modules/` — un module par domaine fonctionnel (sessions, results, registry, settings, stats, plan, register, ui...).
- `karting-v2/src/lib/supabase.js` — client Supabase partagé, exporté en `{ db }`.
- `supabase/functions/` — 4 Edge Functions : `create-checkout`, `billing-portal`, `stripe-webhook`, `provision-organization`.
- Façade vitrine/tarifs/inscription séparée (Lovable/React), non versionnée dans ce repo.

## Déploiement

Push sur `main` → déploiement automatique Cloudflare Pages (~10-25s). Le workflow
`.github/workflows/check.yml` s'exécute sur chaque push et chaque PR : syntaxe de tous les
modules JS, absence de domaine applicatif écrit en dur, et absence de collision sur le
paramètre d'URL `v`. Toujours pas de build — HTML et modules ES natifs servis tels quels,
racine du dépôt = racine du site.

**Domaines, secrets et configuration hors-code : [`docs/DEPLOIEMENT.md`](docs/DEPLOIEMENT.md).**
L'application tourne sur `app.trinisette.fr` ; le code navigateur, lui, ne connaît pas son
domaine (`APP_CONFIG.baseUrl` = `window.location.origin`), ce qui la rend portable d'une
origine à l'autre sans modification. La seule origine écrite en dur de tout le système est
le secret `PUBLIC_APP_URL` de l'Edge Function `send-result-emails`, hors dépôt par nature —
d'où le contrat versionné dans `karting-v2/supabase/functions/.env.example`.

**Schéma des URL publiques, espace de noms clients et mots réservés :
[`docs/ARCHITECTURE-URL.md`](docs/ARCHITECTURE-URL.md).** À lire avant d'ajouter une page
publique, d'imprimer un QR code ou de créer un compte client.

## Base de données

Plus de 60 migrations appliquées via Supabase MCP. Utiliser `list_migrations` côté Supabase pour l'historique complet plutôt que de chercher des fichiers `.sql` dans ce repo — les migrations ne sont pas committées ici.

Tables clés : `tenants`/`organizations` (deux modèles de rôles coexistent, un pour l'atelier, un pour la façade — dette connue), `sessions`, `session_registrations`, `laps`, `pilots` (registre RGPD global), `plans`/`subscriptions` (facturation).

La source de vérité du plan d'un circuit est **exclusivement** `private.tenant_plan_code()` (priorité : `tenants.plan_override` → `subscriptions` actif → `starter`). `organizations.plan_code` n'est qu'un cache d'affichage, jamais une source de droits.

## Sécurité — connu et accepté

- `leads` accepte les insertions anonymes sans authentification (formulaire de contact assumé ouvert, avec garde-fous applicatifs).
- Plusieurs RPC `SECURITY DEFINER` sont exécutables par le rôle `anon` — c'est voulu, elles sont toutes conditionnées à un jeton de session (résultats publics, inscription).
- Protection contre les mots de passe compromis (HaveIBeenPwned) désactivée sur ce projet Supabase — décision en attente.

## Backlog connu (voir l'audit du 28/07 dans le projet Claude pour le détail)

- Pas de branche `develop`, pas de Pull Requests, pas de CI (lint/build).
- Pagination des agrégats de fidélisation dans `stats.js` non implémentée (silencieusement tronqués au-delà de ~1000 lignes côté PostgREST).
- Nom de domaine propre à acheter (le retour de paiement pointe encore vers une URL de prévisualisation Lovable).
- DPA / politique de conservation RGPD à rédiger.
- Palette d'avatars (24 teintes) à réduire à 12-16, plusieurs paires étant visuellement indistinguables en petit format.
