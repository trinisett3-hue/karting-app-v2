# Karting App v2

SaaS karting — inscriptions pilotes, attribution des karts, import des chronos (avec secteurs optionnels), résultats publics en temps réel, archives. Migration propre de l'app d'origine (mêmes fonctionnalités, même logique métier) vers une base de code modulaire et un nouveau projet Supabase.

## Stack

- **Frontend** : HTML/CSS/JS statique, sans framework. `admin.html`, `register.html` et `results.html` sont tous les trois modulaires (ES modules).
- **Backend** : [Supabase](https://supabase.com) (PostgreSQL + API REST auto-générée + stockage des photos pilotes).
- **Hébergement** : [Cloudflare Pages](https://pages.cloudflare.com) (déploiement statique, CDN, HTTPS automatique).

## Structure du dépôt

```
├── admin.html                  # Interface admin (sessions, inscriptions, karts, résultats, paramètres)
├── register.html               # Page publique d'inscription (accès par QR code)
├── results.html                # Page publique des résultats (accès par QR code)
├── karting-v2/
│   ├── src/
│   │   ├── app.js              # Point d'entrée — orchestrateur, câble les modules sur admin.html
│   │   ├── register-app.js     # Point d'entrée — câble modules/register.js sur register.html
│   │   ├── results-app.js      # Point d'entrée — câble modules/public-results.js sur results.html
│   │   ├── config.js           # ⚠️ SEUL fichier à modifier pour changer d'environnement Supabase
│   │   ├── state.js            # État partagé de l'admin (sessions, prefs, sélection en cours…)
│   │   ├── lib/
│   │   │   └── supabase.js     # Client Supabase partagé (unique point d'initialisation)
│   │   └── modules/
│   │       ├── ui.js           # Helpers génériques (formatage, avatars, QR, messages)
│   │       ├── sessions.js     # Sessions, inscriptions, attribution des karts
│   │       ├── results.js      # Classement, import chronos (avec secteurs), publication, archives (admin)
│   │       ├── settings.js     # Préférences globales, apparence, casques, secteurs
│   │       ├── register.js     # Logique de la page publique d'inscription (register.html)
│   │       └── public-results.js # Logique de la page publique de résultats (results.html) : podium, top10, PDF
│   └── supabase/
│       └── migration-v2.sql    # Schéma complet à exécuter sur un projet Supabase neuf
└── README.md
```

## État actuel du projet Supabase (`yfgrvfdjakjnmryhtpgo`)

Ce projet est **déjà configuré et prêt à tester**, pas besoin de rejouer de migration :

- Schéma multi-tenant complet en place (`tenants`, `organizations`, `venues`, `sessions`, `session_registrations`, `laps` avec secteurs, `drivers`, `app_settings`, `results_snapshots`). `karting-v2/supabase/migration-v2.sql` documente ce schéma pour référence (utile si tu dois le recréer ailleurs), il n'a pas besoin d'être exécuté sur ce projet.
- Un premier tenant `Trinisette Karting` a été créé.
- Un trigger remplit automatiquement `tenant_id` à l'insertion (`autofill_tenant_id`), une fois l'authentification admin branchée (voir Roadmap) — pas besoin d'y penser dans le code JS.
- **⚠️ Policies RLS temporairement ouvertes pour les tests** : `session_registrations` et `laps` ont des policies `temp_test_all_*` qui autorisent toute écriture sans authentification (le temps de tester l'admin sans login). `sessions` a de son côté une policy `admin_all_sessions` tout aussi ouverte. **Ces policies devront être supprimées avant toute mise en prod réelle avec de vrais clients** (voir requêtes de nettoyage en bas de `migration-v2.sql`) — sans quoi n'importe qui avec la clé publique pourrait modifier les données de n'importe quel tenant.

## Démarrage rapide (si tu changes d'environnement Supabase)

1. Dans **Project Settings → API** du nouveau projet, récupère l'URL et la clé publique (`anon` / `publishable`).
2. Mets à jour `karting-v2/src/config.js` (URL + clé) — **c'est le seul fichier à toucher**, `admin.html`, `register.html` et `results.html` le réutilisent tous automatiquement (via `lib/supabase.js`).
3. Rejoue `karting-v2/supabase/migration-v2.sql` sur le nouveau projet si le schéma n'existe pas encore.
4. Ouvre les pages via un serveur local (**pas** en double-clic — voir ci-dessous) ou déploie sur Cloudflare Pages pour tester.

## ⚠️ Pourquoi je ne peux pas juste double-cliquer sur admin.html

`admin.html` charge sa logique via `<script type="module" src="karting-v2/src/app.js">`. Les navigateurs bloquent par sécurité le chargement de modules JS quand la page est ouverte en `file://` (double-clic) — erreur `CORS` / `switchTab is not defined`. Ce n'est pas un bug, c'est une restriction navigateur standard.

Pour tester en local :

```bash
python3 -m http.server 8080
# puis ouvrir http://localhost:8080/admin.html
```

Sur Cloudflare Pages (HTTP réel), ce problème n'existe pas.

## Déploiement (Cloudflare Pages)

1. Connecte ce repo GitHub à un projet Cloudflare Pages (Build command: aucun — site 100% statique. Output directory : `/`).
2. Chaque push sur `main` redéploie automatiquement.
3. Vérifie que `admin.html` n'est **pas** exposé publiquement sans protection si tu ajoutes un jour de l'authentification — pour l'instant l'app utilise uniquement la clé publique Supabase (`anon`), comme l'app d'origine.

## Modifier le projet — où toucher quoi

| Je veux... | Fichier à modifier |
|---|---|
| Changer d'environnement Supabase (URL/clé) | `karting-v2/src/config.js` (seul fichier à toucher) |
| Modifier la logique sessions / inscriptions / karts (admin) | `karting-v2/src/modules/sessions.js` |
| Modifier le formulaire d'inscription public | `karting-v2/src/modules/register.js` |
| Modifier la page publique de résultats (podium, top10, PDF) | `karting-v2/src/modules/public-results.js` |
| Modifier classement / import chronos / secteurs / publication / archives | `karting-v2/src/modules/results.js` |
| Modifier les réglages (karts par défaut, apparence, casques) | `karting-v2/src/modules/settings.js` |
| Ajouter un helper d'affichage générique (formatage, avatar...) | `karting-v2/src/modules/ui.js` |
| Câbler une nouvelle fonction sur un bouton `onclick="..."` du HTML | `karting-v2/src/app.js` (section `Object.assign(window, {...})`) |
| Modifier le schéma de base de données | `karting-v2/supabase/migration-v2.sql` (+ appliquer manuellement la modif sur le projet Supabase — ce fichier n'est pas rejoué automatiquement) |

## Vérifier avant de pousser une modif

Avant de commit/push un changement dans `karting-v2/src/`, deux vérifications rapides suffisent à attraper la plupart des erreurs (import cassé, faute de syntaxe) sans avoir besoin d'ouvrir un navigateur :

```bash
# 1. Vérifie que tous les modules s'importent correctement entre eux
npx esbuild karting-v2/src/app.js --bundle --format=esm --outfile=/tmp/bundle.js

# 2. Sert le dossier en local et ouvre admin.html dans le navigateur (jamais en double-clic)
python3 -m http.server 8080
```

Si `esbuild` ne renvoie aucune erreur, les imports/exports entre fichiers sont valides. Ça n'attrape pas les bugs de logique métier (ex: mauvais nom de colonne Supabase) — pour ça, il faut tester en vrai avec des données.

## Roadmap

- [ ] **Brancher l'authentification admin.** Le module `karting-v2/src/modules/auth.js` existe déjà (connexion/inscription par email + mot de passe via Supabase Auth) mais n'est pas encore câblé dans `app.js` — l'admin reste accessible sans login pendant la phase de test. Une fois branché : ajouter un écran de connexion dans `admin.html`, appeler `auth.getSession()` / `auth.onAuthStateChange()` au démarrage de `app.js` avant de booter les modules sessions/results/settings.
- [ ] **Supprimer les policies RLS temporaires** (`temp_test_all_session_registrations`, `temp_test_all_laps`, `admin_all_sessions`) une fois l'auth branchée — voir requêtes en bas de `migration-v2.sql`. Sans ça, les policies tenant-scoped (`*_auth`) ne servent à rien : la porte reste grande ouverte.
- [ ] Pour chaque nouveau client/organisateur : créer une ligne dans `tenants`, créer son compte Supabase Auth (self-service via l'écran de connexion, ou manuellement), puis le relier via `tenant_users` (`user_id`, `tenant_id`, `role`).
- [x] Moduler `register.html` sur le même principe que `admin.html` (fait — `karting-v2/src/modules/register.js` + `register-app.js`).
- [x] Moduler `results.html` sur le même principe (fait — `karting-v2/src/modules/public-results.js` + `results-app.js`).
- [ ] Pipeline CI (lint + `esbuild --bundle` en vérification automatique sur chaque pull request).
