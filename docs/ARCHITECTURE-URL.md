# Architecture des URL — décision du 03/08/2026

Ce document fige la manière dont les URL de l'application sont construites, **avant**
que des QR codes soient imprimés et avant que des clients autres que Trinisette soient
créés. Une URL publiée est un engagement : elle finit sur une plaque au bord de la piste,
dans un e-mail, dans un signet. On ne la change pas après coup sans casser quelque chose.

## 1. Les trois couches

L'erreur classique est de vouloir un seul schéma d'URL pour tout. Il en faut trois, parce
que les trois familles de pages n'ont ni le même public, ni le même besoin de mémorisation,
ni le même niveau de confidentialité.

### Couche opérateur — `/admin`

`https://app.trinisette.fr/admin`

Le tenant **n'apparaît pas** dans l'URL et ne doit jamais y apparaître. Il est déduit du
JWT Supabase par `current_tenant_id()`, qui lit `tenant_users` pour `auth.uid()`. Mettre le
nom du circuit dans l'URL de l'admin n'apporterait rien (l'utilisateur est déjà authentifié,
il sait chez qui il est) et créerait un vecteur d'erreur : une URL et une session qui
désignent deux tenants différents, avec des policies RLS qui trancheraient silencieusement
en faveur de la session.

C'est le modèle Stripe, Linear, Vercel : `/dashboard`, l'organisation vient de la session.
Le modèle inverse — `notion.so/{workspace}`, `{team}.slack.com` — n'a de sens que quand un
même compte appartient couramment à plusieurs espaces et bascule de l'un à l'autre. Ce n'est
pas notre cas : `current_tenant_id()` fait un `LIMIT 1`, un utilisateur = un circuit.

**Verdict : `/admin` est viable sur le long terme**, à une condition, traitée en §3 —
que le mot `admin` soit réservé dès maintenant dans l'espace de noms public.

### Couche marque — `/{nomclient}` (prévue, pas encore construite)

`https://trinisette.fr/karting-lyon`

C'est ici, et **uniquement** ici, que la comparaison avec Instagram tient. Ce qu'Instagram
met derrière `/{username}`, c'est un **profil public**, volontairement indexable et
volontairement devinable : c'est tout l'intérêt. L'équivalent chez nous, c'est la page
d'accueil publique d'un circuit — son nom, son logo, ses sessions ouvertes à l'inscription,
ses derniers résultats publiés.

Ce contenu existe déjà : c'est exactement ce que renvoie la RPC
`public_venue_sessions(_venue_token text)`. Aujourd'hui elle est appelée avec un jeton
opaque de 32 caractères. La faire répondre à un slug lisible est un changement
de clé d'entrée, pas un changement d'architecture.

**Cette couche n'est pas construite aujourd'hui, et c'est délibéré** — voir §4.

### Couche jeton — `?session=`, `?result=`, `?c=`

```
/register?session=<24 hex>    inscription à une session précise
/results?result=<24 hex>      résultats d'une session précise
/results?v=<32 hex>           sélecteur de sessions d'un circuit
/j?c=<32 hex>                 atterrissage du QR permanent de la plaque
```

Tout ce qui expose une personne ou une course précise reste derrière un jeton opaque,
**pour toujours**. Une page de résultats contient des noms de pilotes et alimente des envois
d'e-mails ; elle ne doit être atteignable que par quelqu'un à qui on a donné le lien.

C'est le point qui condamne la tentation « `/{nomclient}/resultats` partout » : un slug est
devinable par construction. `trinisette.fr/karting-lyon/resultats` serait scannable par
n'importe qui, y compris par un concurrent qui veut la liste des pilotes. La lisibilité et
la confidentialité sont deux objectifs opposés — on ne les traite pas avec le même mécanisme.

Ces pages sont désormais explicitement exclues de l'indexation (`robots.txt` et `_headers`
à la racine du dépôt), et leur `Referrer-Policy` est passée à `no-referrer` pour qu'aucune
ressource tierce chargée par la page ne reçoive le jeton dans l'en-tête `Referer`.

## 2. Ce qui est déjà à l'épreuve du futur

**Le QR permanent `/j?c=<jeton_circuit>` est une couche d'indirection, et c'est ce qui
autorise à imprimer aujourd'hui.**

`karting-v2/src/j-app.js` reçoit le jeton du circuit, interroge `public_venue_sessions`,
puis redirige vers la bonne session d'inscription ou la bonne page de résultats **au
moment du scan**. La plaque ne contient donc ni numéro de session, ni date, ni slug, ni
rien de ce qui pourra changer.

Conséquence concrète : introduire `/{nomclient}` plus tard, renommer un client, réorganiser
les pages — rien de tout cela n'oblige à réimprimer quoi que ce soit. La seule chose gravée
dans le QR est le couple *(domaine, jeton)*. Le jeton est permanent en base ; le domaine est
`app.trinisette.fr`, qui nous appartient et ne bougera plus.

**Corollaire à respecter :** ne jamais imprimer un QR contenant `.pages.dev`, un jeton de
session (`?session=`, `?result=`) ou un slug. Uniquement `/j?c=`.

## 3. Espace de noms — à réserver dès maintenant

Le jour où `trinisette.fr/{slug}` existera, tout segment de premier niveau devient un slug
potentiel. Les mots ci-dessous sont donc **interdits comme nom de client**, dès la première
inscription, même si la couche marque n'existe pas encore. C'est la seule chose qu'il faut
absolument décider avant d'avoir des clients : reprendre un slug déjà attribué coûte cher,
en interdire un qui ne l'est pas ne coûte rien.

Réservé — infrastructure et pages existantes :

```
admin  api  app  assets  avatars  cards  _cards  j  register  results
robots.txt  sitemap.xml  favicon.ico  _headers  _redirects  _routes.json  _worker.js
```

Réservé — vitrine, marketing et sous-domaines déjà attribués :

```
www  news  envoi  mail  blog  contact  docs  aide  help  support  legal  cgv  cgu
tarifs  pricing  offres  demo  essai  login  logout  signup  inscription  compte
settings  parametres  status  static  cdn  files  media  s  qr  go  r  u
```

Réservé — noms de marque et pièges usuels :

```
trinisette  admin-panel  dashboard  console  root  system  null  undefined  test
```

Format imposé pour un slug client :

```
^[a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9])$
```

Minuscules, chiffres et tirets simples ; 3 à 32 caractères ; ni tiret initial ni tiret
final ; pas de double tiret (réservé au préfixe Punycode `xn--`, pour ne pas se fermer la
porte aux domaines internationalisés). Comparaison en base insensible à la casse.

## 4. Pourquoi on ne construit pas `/{nomclient}` aujourd'hui

Ce n'est pas un renoncement, c'est un ordre de priorité. Construire la couche marque
demande, au minimum :

1. une colonne `tenants.slug` unique, avec contrainte de format et liste de mots réservés
   appliquée **en base** (une simple validation d'interface serait contournable) ;
2. une RPC `public_venue_by_slug(text)` en `SECURITY DEFINER`, accordée à `anon`, jumelle
   de `public_venue_sessions` ;
3. du routage côté Cloudflare Pages, qui n'existe aujourd'hui à aucun endroit du dépôt —
   ni `_redirects`, ni `_routes.json`, ni Pages Function. Un chemin `/{slug}` sur de
   l'hébergement statique impose soit une règle de réécriture, soit une Function ;
4. la modification de la détection de page publique dans `karting-v2/src/lib/supabase.js` :

   ```js
   const isPublicPage = /(^|\/)(register|results|j)(\.html)?$/.test(window.location.pathname);
   ```

   Ce test porte sur le **chemin**. Sous `/{slug}/...`, il ne reconnaît plus rien, et les
   pages publiques repartiraient avec un client Supabase persistant au lieu du client
   strictement anonyme (`persistSession:false`, `storageKey:'sb-public-anon'`). C'est une
   régression de sécurité silencieuse — aucune erreur visible, juste une session qui traîne ;
5. une politique de renommage : redirection 301 de l'ancien slug, délai de carence avant
   qu'il soit réattribuable, sinon un client qui change de nom offre son ancienne adresse
   au premier venu.

Aucun de ces cinq points n'apporte quoi que ce soit tant qu'il n'y a pas plusieurs circuits
clients en production. Ils deviennent tous nécessaires le jour où il y en a. D'où la
règle : **on réserve l'espace de noms maintenant (coût nul), on construit la couche quand
elle sert.**

## 5. Récapitulatif

| Usage | URL | Clé | Indexable |
|---|---|---|---|
| Dashboard circuit | `app.trinisette.fr/admin` | JWT | non |
| Vitrine Trinisette | `trinisette.fr` | — | oui |
| Page publique d'un circuit *(à venir)* | `trinisette.fr/{slug}` | slug | oui |
| Sélecteur de sessions | `app.trinisette.fr/results?v=<32 hex>` | jeton circuit | non |
| QR permanent plaque | `app.trinisette.fr/j?c=<32 hex>` | jeton circuit | non |
| Inscription | `app.trinisette.fr/register?session=<24 hex>` | jeton session | non |
| Résultats | `app.trinisette.fr/results?result=<24 hex>` | jeton session | non |

Règles invariantes :

- aucune origine écrite en dur dans le code navigateur — `APP_CONFIG.baseUrl` vaut
  `window.location.origin`, et le workflow CI `Verification JS` échoue si un domaine
  applicatif apparaît en dur dans `karting-v2/src/` ou dans un `.html` racine ;
- URL publiques sans `.html` : Cloudflare Pages répond 308 sur la forme `.html`, ce qui
  ajoute un aller-retour et affiche une adresse différente de celle qu'on a copiée.
  Seule exception assumée : `karting-v2/src/modules/pdf-bridge.js`, qui garde `.html`
  pour charger une iframe strictement de même origine ;
- un seul paramètre par signification. `v` = jeton de circuit. Le cache-buster des liens
  copiés depuis l'admin s'appelle `_r` depuis le 03/08 — il s'appelait `v` lui aussi, ce
  qui était une collision réelle, masquée seulement par l'ordre des tests dans
  `public-results.js`.
