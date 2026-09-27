# PM Cockpit

Cockpit de portefeuille projets pour chef de projet / Scrum Master :

- **Vue godmode** : tous les projets sur un écran, avec une santé *calculée* (retards, risques, écart avancement / temps écoulé, jalons dépassés, instabilité du périmètre) comparée au statut *déclaré*, les alertes par projet, les risques qui montent et les échéances des 60 prochains jours.
- **Un dashboard par projet** : actions, matrice des risques probabilité × impact, signaux expliqués, jalons, journal des changements et décisions.
- **Capture en 5 secondes depuis le téléphone** via un bot **Telegram** (ou **WhatsApp**) : un message = une action, sans formulaire.
- **Mails → actions** : copier-coller un mail (ou le transférer au bot, ou via Power Automate), l'app propose les actions, risques et changements ; tu valides d'un clic.
- **Mes actions (ToDo)** : en retard / aujourd'hui / semaine / plus tard, tes relances (« en attente de »), ta charge sur 10 jours ouvrés, report en +1j / +1s.

Node.js ≥ 20.11. Sous Node ≥ 22.13, l'app utilise la base SQLite intégrée à Node (`node:sqlite`) ; sous Node 20, elle bascule automatiquement sur `sql.js` (SQLite en WebAssembly, installé par `npm install`, sans compilation). Les données restent dans `data/pmapp.db` sur ton poste.

## Démarrage

```bash
cp .env.example .env      # puis renseigne ce dont tu as besoin
npm install               # sql.js (requis sous Node 20) + SDK Claude optionnel (extraction IA des mails)
npm run seed              # optionnel : données de démonstration
npm start                 # → http://127.0.0.1:3000
```

`npm test` lance les tests (`PMAPP_SQLITE=sqljs npm test` force le moteur sql.js). Node 20 n'étant plus maintenu, passer à Node 22 LTS reste recommandé quand c'est possible.

## Capturer une action (web, Telegram, WhatsApp)

Même syntaxe partout. Tout est optionnel sauf le texte :

| Message | Résultat |
|---|---|
| `#CRM relancer Paul sur le budget vendredi` | Action pour moi, projet CRM, échéance vendredi |
| `#CRM @Paul envoyer le planning demain !` | Action portée par Paul, priorité haute |
| `w: #ERP @Sophie retour juridique 12/10` | « En attente de » Sophie → liste des relances |
| `r: #ERP fournisseur en retard p4 i5` | Risque (probabilité 4 × impact 5) |
| `c: #CRM go-live décalé au 15/11` | Changement consigné au journal du projet |
| `d: …` / `n: …` | Décision / note |

- **Projet** : `#CODE`, ou un alias du projet (défini dans sa fiche). Sans projet reconnu, l'élément va dans l'**Inbox** ; sur Telegram, des boutons te proposent le projet.
- **Dates** : aujourd'hui, demain, lundi…, fin de semaine, semaine prochaine, fin du mois, +3j, +2s, dans 3 jours, 12/10, 12 octobre.
- **Priorité** : `!` haute, `!!` critique, `!basse`.
- **Porteur** : `@nom`. Sans `@`, l'action est pour toi. Déclare tes prénoms et initiales dans *Réglages* pour que `@Sarah` soit reconnu comme toi.
- Dans l'app web, la barre de capture est toujours en haut (raccourci `/`) avec un aperçu en direct de ce qui sera créé.

## Telegram (recommandé)

1. Sur Telegram, écris à **@BotFather** → `/newbot` → copie le token dans `TELEGRAM_BOT_TOKEN`.
2. Lance l'app, envoie un message à ton bot : il répond avec ton *chat id*. Mets-le dans `TELEGRAM_ALLOWED_CHAT_IDS` et redémarre. Les autres chats sont refusés.
3. Épingle la conversation du bot sur ton téléphone. Pour dicter plutôt que taper, utilise le micro du clavier : les messages vocaux ne sont pas transcrits.

Le mode `polling` n'a pas besoin d'URL publique : il suffit que le poste qui fait tourner l'app puisse joindre `api.telegram.org`. Si le proxy de l'entreprise bloque, fais tourner l'app sur un petit serveur ou une VM (avec `APP_PASSWORD`), ou utilise le mode `webhook`.

Commandes : `/todo`, `/semaine`, `/retard`, `/attente`, `/projets`, `/p CRM`, `/inbox`, `/fait 12`, `/report 12 lundi`, `/aide`.
Un texte long collé dans le bot (par exemple un mail partagé depuis Outlook mobile), ou un texte qui commence par `mail:`, est traité comme un mail : il arrive dans l'onglet *Mails* et le bot propose « Tout ajouter ».

## WhatsApp (optionnel)

WhatsApp n'a pas de bot « personnel » simple. Il faut l'**API WhatsApp Business Cloud** de Meta : une app développeur Meta, un numéro de test ou un numéro dédié, et une URL publique HTTPS.

- Webhook : `https://<PUBLIC_URL>/api/whatsapp/webhook` avec le jeton de vérification `WHATSAPP_VERIFY_TOKEN`.
- Renseigne `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_APP_SECRET` (vérifie la signature des requêtes) et `WHATSAPP_ALLOWED_NUMBERS`.
- Les boutons deviennent des choix numérotés : on répond `1`, `2`…

## Mails → actions

Trois façons de faire entrer un mail :

1. **Copier-coller** dans l'onglet *Mails → actions* (Ctrl+Entrée pour extraire).
2. **Partager vers Telegram** depuis Outlook mobile.
3. **Power Automate** : un flux « Quand un e-mail est marqué d'un indicateur » (ou reçu dans un dossier « À traiter ») → action *HTTP* `POST https://<ton-app>/api/ingest/email` avec l'en-tête `Authorization: Bearer <INGEST_TOKEN>` et le corps `{"subject": "...", "from": "...", "body": "..."}`. Attention : le connecteur HTTP est premium et l'app doit être joignable depuis Power Automate.

L'extraction se fait par :

- une **heuristique locale** (par défaut) : formules d'action (« merci de », « pourrais-tu », listes sous « Actions : »…), porteurs (`Paul :`, « je m'occupe »), dates, signaux de risque et de changement. Rien ne sort du poste.
- **Claude** si `ANTHROPIC_API_KEY` est renseignée (et `npm install` fait) : extraction plus fine, avec un résumé. Le modèle est configurable via `ANTHROPIC_MODEL`. ⚠️ Le contenu du mail est alors envoyé à l'API Anthropic : vérifie que c'est compatible avec la politique de ta société. Le moteur local reste sélectionnable mail par mail.

Dans les deux cas, tu relis et ajustes les propositions (type, projet, porteur, échéance, priorité) avant de les ajouter.

## Comment la santé est calculée

Chaque projet part de 100 points. Chaque signal retire des points et s'affiche avec son explication :

| Signal | Pénalité |
|---|---|
| Deadline dépassée | −30 |
| Avancement en retard de plus de 35 points sur le temps écoulé (20 à 35 points) | −25 (−15) |
| Deadline à 14 jours ou moins avec un avancement sous 80 % | −10 |
| Action en retard | −8 chacune (max −32) |
| Risque critique (score ≥ 15) | −15 chacun (max −30) |
| Risque élevé (score de 10 à 14) | −6 chacun (max −18) |
| Risque en hausse sur 14 jours | −8 chacun (max −16) |
| Jalon dépassé | −10 chacun (max −20) |
| Au moins 3 changements en 7 jours | −8 |

Un score ≥ 75 donne 🟢, de 50 à 74 🟠, en dessous de 50 🔴. Quand le statut déclaré est plus optimiste que le calcul, un signal le rappelle (projet « pastèque »).

## Architecture

```
src/
  server.js        démarrage HTTP + bots
  app.js           API JSON + fichiers statiques (sans framework)
  db.js            schéma SQLite (node:sqlite) et accès aux données
  parser.js        capture rapide (#projet @porteur dates !priorité r:/c:/w:)
  dates.js         dates relatives en français
  health.js        santé, alertes, risques en hausse, ToDo, charge
  emailExtract.js  mail → éléments (heuristique locale + Claude)
  bot.js           logique conversationnelle commune Telegram / WhatsApp
  telegram.js      bot Telegram (polling ou webhook)
  whatsapp.js      webhook WhatsApp Business Cloud
  seed.js          données de démonstration
public/            interface web (HTML/CSS/JS, sans build)
test/              tests (node --test)
```

Export CSV des actions (compatible Excel) : *Réglages → Exporter*.

## Sécurité

- Par défaut, l'app n'écoute que sur `127.0.0.1`. Si tu l'ouvres au réseau, définis `APP_PASSWORD` (cookie de session signé, HttpOnly, SameSite=Strict).
- Les bots n'acceptent que les chats et numéros de la liste blanche. Le webhook Telegram vérifie son jeton secret, le webhook WhatsApp la signature `X-Hub-Signature-256`.
- L'ingestion de mails exige `INGEST_TOKEN`.
