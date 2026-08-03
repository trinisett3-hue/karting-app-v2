# Déploiement — domaines, hébergement, secrets

Source de vérité versionnée de la configuration hors-code. Mise à jour le 03/08/2026,
au moment de la bascule de `karting-app-v2.pages.dev` vers `trinisette.fr`.

## Pourquoi ce document existe

Le code navigateur ne contient **aucune** origine écrite en dur : `karting-v2/src/config.js`
expose `baseUrl: window.location.origin`, et tous les liens sont soit construits à partir de
là, soit relatifs. L'application fonctionne donc à l'identique sur `.pages.dev` et sur
`app.trinisette.fr`, sans une ligne modifiée. C'est voulu, et c'est vérifié automatiquement
par le workflow CI `Verification JS`.

La contrepartie, c'est que le domaine réel vit **ailleurs que dans Git** : dans les secrets
Supabase, dans la configuration Auth, chez Resend, chez Cloudflare. Rien ne le rappelle au
développeur, rien ne casse bruyamment si c'est faux — les e-mails partent quand même, avec un
lien mort. Ce fichier est le rattrapage : la partie non versionnable est au moins décrite ici,
et toute modification de domaine doit passer par une mise à jour de ce tableau.

## Domaines

| Nom | Cible | Statut |
|---|---|---|
| `trinisette.fr` | vitrine — projet Pages `trinisette-vitrine`, même dépôt, racine `vitrine/` | **en ligne, SSL actif** |
| `www.trinisette.fr` | même projet Pages que l'apex | **en ligne, SSL actif** |
| `app.trinisette.fr` | projet Cloudflare Pages `karting-app-v2` (ce dépôt) | **en ligne, SSL actif** |
| `envoi.trinisette.fr` | Return-Path Resend (Amazon SES `eu-west-1`) | vérifié |
| `news.trinisette.fr` | second domaine Resend, e-mails marketing | prévu |

Les deux défauts constatés le 03/08 au matin sont résolus : `https://trinisette.fr/` répondait
**525** (les A de l'apex étaient proxifiés vers l'origine de parking IONOS, qui n'a pas de
certificat pour ce nom) et `https://www.trinisette.fr/` répondait **502** (aucun enregistrement
DNS). En branchant le domaine sur le projet vitrine, Cloudflare a remplacé les
`A 217.160.0.185` / `AAAA 2001:8d8:100f:f000::200` par un `CNAME @ → trinisette-vitrine.pages.dev`
et créé `CNAME www → trinisette-vitrine.pages.dev`. Les deux noms répondent **200** en HTTPS.

Registrar : IONOS. DNS : Cloudflare (plan Free), zone `trinisette.fr`,
compte `0800a8606b90e0fe96cc14596afeb8a4`, serveurs de noms `gabriel.ns.cloudflare.com`
et `magali.ns.cloudflare.com`.

Le transactionnel part de l'apex `trinisette.fr` et le marketing partira de
`news.trinisette.fr` : une plainte pour spam sur une campagne ne doit pas pouvoir dégrader
la délivrabilité des e-mails de résultats, qui sont attendus par le destinataire.

## Enregistrements DNS

Conservés depuis IONOS, parce que les boîtes `contact@trinisette.fr` y sont hébergées :
`MX mx00.ionos.fr` et `MX mx01.ionos.fr` (priorité 10), et le SPF de l'apex
`v=spf1 include:_spf-eu.ionos.com ~all`.

Ajoutés pour Resend, tous en « DNS uniquement » — un enregistrement proxifié par Cloudflare
ne serait pas lisible par les vérificateurs SPF/DKIM :

```
resend._domainkey   TXT   p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQC4XwQrG5g0...
envoi               MX    feedback-smtp.eu-west-1.amazonses.com   (10)
envoi               TXT   v=spf1 include:amazonses.com ~all
```

Les deux SPF ne se contredisent pas : celui d'IONOS couvre l'apex (d'où part le courrier
humain), celui d'Amazon couvre `envoi`, qui n'est que le Return-Path. L'alignement DMARC
relaxé accepte qu'un sous-domaine s'aligne sur le domaine organisationnel, donc une adresse
`From:` en `@trinisette.fr` avec un Return-Path en `@envoi.trinisette.fr` passe.

DMARC est posé depuis le 03/08 : le `CNAME _dmarc → dmarc.ionos.fr` hérité a été remplacé par
`TXT _dmarc = v=DMARC1; p=none; rua=mailto:contact@trinisette.fr`. `p=none` est délibéré le
temps de lire les rapports agrégés ; le durcissement en `quarantine` viendra ensuite, et pas
avant d'avoir la certitude qu'aucun envoi légitime n'est cassé.

Les `A 217.160.0.185` et `AAAA 2001:8d8:100f:f000::200` de parking IONOS ont été supprimés le
03/08, au moment même du branchement de la vitrine — Cloudflare les a remplacés par le CNAME
en une seule opération, ce qui évite la fenêtre pendant laquelle le domaine n'aurait plus
répondu du tout.

À finaliser : repasser `autodiscover` et `_domainconnect` en « DNS uniquement ».

## Secrets et configuration hors-code

**Supabase — Edge Functions > Secrets** (projet `yfgrvfdjakjnmryhtpgo`) :

| Clé | Valeur cible | Effet si erronée |
|---|---|---|
| `PUBLIC_APP_URL` | `https://app.trinisette.fr` | lien « Voir mes résultats » mort dans tous les e-mails |
| `EMAIL_PROVIDER` | `resend` | — |
| `EMAIL_API_KEY` | clé Resend | aucun e-mail ne part |
| `EMAIL_FROM` | `Trinisette <resultats@trinisette.fr>` | rejet par le destinataire si le domaine n'est pas vérifié |
| `EMAIL_REPLY_TO` | `contact@trinisette.fr` | optionnel |

Les cinq clés sont posées depuis le 03/08. Les trois dernières manquaient jusque-là, et
l'absence de `PUBLIC_APP_URL` était un bug silencieux : `send-result-emails` construit le
lien par `env('PUBLIC_APP_URL') && head.results_token ? … : ''`, donc le paragraphe « voir le
classement » disparaissait purement et simplement de chaque e-mail envoyé, sans erreur nulle
part.

Le DKIM `resend._domainkey` est passé `verified` le 03/08 (les trois enregistrements — DKIM
TXT, SPF MX et SPF TXT sur `envoi` — sont vérifiés, la vérification côté Amazon SES est
asynchrone et a mis plusieurs heures). `EMAIL_FROM` a donc été basculé sur
`Trinisette <resultats@trinisette.fr>` dans la foulée.

`PUBLIC_APP_URL` est la seule origine écrite en dur de tout le système. Sans `/` final.

**Supabase — Authentication > URL Configuration** :

- Site URL : `https://app.trinisette.fr` — posé
- Redirect URLs : `https://app.trinisette.fr/admin`, `https://app.trinisette.fr/**` — posées

Quatre URL Lovable héritées restent volontairement dans la liste blanche le temps de la
transition (six entrées au total). Elles se retirent une fois le parcours « mot de passe
oublié » validé sur `app.trinisette.fr`, pas avant.

Ces valeurs sont obligatoires : `karting-v2/src/modules/auth.js` appelle
`resetPasswordForEmail(email, { redirectTo: APP_CONFIG.baseUrl + '/admin' })`, et Supabase
refuse toute `redirectTo` absente de la liste blanche — le parcours « mot de passe oublié »
échoue silencieusement si l'ancien domaine `.pages.dev` reste seul déclaré. Garder l'ancienne
origine dans la liste pendant la transition, la retirer une fois `app.trinisette.fr` validé.

**Cloudflare Pages** : projet `karting-app-v2`, branche de production `main`, déploiement
automatique à chaque push. Pas d'étape de build — HTML et modules ES natifs servis tels
quels, racine du dépôt = racine du site. Aucun fichier de routage n'existe côté Pages hormis
`_headers` ; ajouter `_redirects` ou `_routes.json` change le comportement de déploiement et
doit être fait en connaissance de cause (voir `docs/ARCHITECTURE-URL.md`).

Comportement à connaître : Pages répond **308** sur `/X.html` et redirige vers `/X`. Tous les
liens publics doivent donc omettre l'extension. Seule exception assumée,
`karting-v2/src/modules/pdf-bridge.js`, qui conserve `.html` pour une iframe de même origine.

**Cloudflare Pages — projet vitrine** : projet `trinisette-vitrine`
(`trinisette-vitrine.pages.dev`), même dépôt GitHub `karting-app-v2`, même branche de
production `main`, mais **Root directory = `vitrine`**, sans commande de build. Domaines
personnalisés : `trinisette.fr` et `www.trinisette.fr`. Créé le 03/08.

Le nom du projet ne pouvait pas être `karting-app-v2` : ce nom est déjà pris par le projet de
l'application, et Cloudflare aurait suffixé silencieusement en `karting-app-v2-4iz`.

Ce réglage « Root directory » est ce qui permet de servir deux sites depuis un seul dépôt,
sur le plan gratuit, sans second dépôt ni second workflow. Les deux projets se déploient au
même push sur `main` ; chacun ne voit que sa racine. C'est aussi pour ça que `vitrine/`
embarque ses propres `_headers`, `robots.txt` et `sitemap.xml` : à la racine du projet
vitrine, ce sont ces fichiers-là qui s'appliquent, et surtout pas le `robots.txt` de
l'application, qui interdit toute indexation.

La vitrine n'a aucune dépendance vers ce dépôt côté code : elle parle à Supabase en `anon`
pour insérer dans `public.leads` (politique `leads_public_insert`, `status = 'new'` imposé
côté serveur), et ne lit rien. Un formulaire de contact ne peut donc pas servir à lire des
données de circuits.

**Resend** : domaine `trinisette.fr`, ID `fef03a09-76e1-4a67-b74f-201e03e696cb`, région
`eu-west-1`. Plan gratuit — 3 000 e-mails par mois, 100 par jour, domaines vérifiés illimités.
Le plafond quotidien est la limite réelle à surveiller le jour d'une grosse session.

## Procédure de changement de domaine

1. brancher le domaine sur le projet Pages (Cloudflare > Workers & Pages > Custom domains) ;
2. mettre à jour `PUBLIC_APP_URL` côté Supabase ;
3. ajouter la nouvelle origine dans Auth > Redirect URLs **avant** de retirer l'ancienne ;
4. vérifier le domaine expéditeur chez Resend ;
5. tester de bout en bout avec une adresse externe au projet : inscription, publication,
   réception de l'e-mail, ouverture du lien résultats, « mot de passe oublié » ;
6. seulement ensuite, imprimer ou réimprimer quoi que ce soit.

Aucun QR code ne part à l'impression tant que l'étape 5 n'est pas passée sur le domaine
définitif.
