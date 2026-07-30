# Envoi des résultats par e-mail — comment ça se configure

## Ce qui est déjà en place (rien à faire)

L'infrastructure est posée et vérifiée côté base :

- migration **v26** : bucket privé `session-exports`, table `session_assets`, file d'envoi atomique (`claim_card_deliveries`, `mark_card_delivery`, `requeue_stuck_deliveries`) réservée au `service_role` — ni `anon` ni un admin connecté ne peut déclencher d'envoi ;
- migration **v27** : tâche `rattrapage-envoi-resultats`, active, toutes les 5 minutes ;
- Edge Function **`send-result-emails`** déployée (version 1) ;
- côté app : « Publier les résultats » horodate `results_published_at`, remplit la file (`enqueue_position_cards`), téléverse le PDF du classement, puis appelle la fonction immédiatement.

## Ce qu'il te reste à faire — 3 étapes

### 1. Ouvrir un compte chez un expéditeur

Le code sait parler à **Resend** (par défaut) et à **Brevo**, au choix, sans rien changer d'autre qu'une variable. Resend est le plus simple : 3 000 e-mails par mois gratuits, une clé API en deux clics. Brevo est plus généreux en volume (300/jour) et plus classique côté interface française. L'un ou l'autre, tu peux basculer plus tard.

### 2. Authentifier ton domaine

C'est l'étape qui décide si tes e-mails arrivent en boîte de réception ou en spam, et c'est la seule qui prend un peu de temps. Dans le tableau de bord du fournisseur, tu ajoutes ton domaine ; il te donne deux ou trois enregistrements DNS (**SPF**, **DKIM**, parfois **DMARC**) à créer chez ton registrar — ou dans Cloudflare si ton domaine y est déjà. La propagation prend de quelques minutes à quelques heures. Tant que ce n'est pas fait, envoie depuis leur domaine de test uniquement, jamais vers de vrais pilotes.

### 3. Renseigner les secrets Supabase

Dans le tableau de bord Supabase → **Edge Functions → Secrets** :

| Nom | Valeur | Obligatoire |
|---|---|---|
| `EMAIL_API_KEY` | la clé API du fournisseur | oui |
| `EMAIL_FROM` | `Karting Trinisette <resultats@ton-domaine.fr>` | oui |
| `EMAIL_PROVIDER` | `resend` ou `brevo` (défaut `resend`) | non |
| `EMAIL_REPLY_TO` | ton adresse de contact | non |
| `PUBLIC_APP_URL` | `https://karting-app-v2.pages.dev` | recommandé |

Sans `EMAIL_API_KEY` et `EMAIL_FROM`, la fonction refuse de tourner et renvoie une erreur claire plutôt que d'envoyer n'importe quoi. `SUPABASE_URL` et `SUPABASE_SERVICE_ROLE_KEY` sont injectés automatiquement — tu n'as jamais à les copier quelque part, et surtout jamais côté frontend.

## Pourquoi le cron n'envoie pas d'e-mail toutes les 5 minutes

C'est la question que tu posais. La tâche ne « décide » pas d'envoyer : elle vide une file. Chaque ligne de `card_deliveries` passe de `pending` à `sent` **une seule fois**, dans la même transaction que sa prise en charge (`for update … skip locked`). Un pilote reçoit donc exactement un e-mail, que le cron tourne toutes les 5 minutes ou toutes les 5 heures. Le cron ne sert qu'à rattraper : réseau coupé, fournisseur en panne, onglet fermé pendant la publication.

« Appel à la publication » veut dire que le clic sur **Publier les résultats** appelle la fonction directement, sans attendre le prochain tour de cron — l'e-mail part dans la seconde. Le cron est la ceinture, la publication est le trajet normal.

Un envoi qui échoue repasse en `pending` avec le message d'erreur, et sera retenté — au maximum 5 fois, pour qu'une adresse invalide ne soit pas rappelée indéfiniment.

## Test recommandé avant d'ouvrir aux pilotes

1. Renseigne les secrets avec le domaine de test du fournisseur.
2. Crée une session bidon, inscris-toi avec ta propre adresse, importe deux chronos.
3. Publie. Tu dois recevoir l'e-mail avec le classement en pièce jointe.
4. Republie : tu ne dois **rien** recevoir de plus. C'est la preuve que la file ne rejoue pas.

## Limite connue, à traiter ensuite

Aujourd'hui le navigateur téléverse le **classement complet**. La fiche pilote et la carte de position sont rendues sur la page publique (`public-results.js`), pas dans l'admin : elles ne sont donc pas encore en pièce jointe. L'e-mail part quand même, avec le classement et le lien vers les résultats en ligne — et le code est prêt à les accepter dès qu'on les génère côté admin (`uploadSessionAsset` avec `kind: 'pilot_pdf'` ou `'position_card'`).
