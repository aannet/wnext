# ADR-002 — Identité vs ressource planifiée, zoom, navigation temporelle, i18n, fluidité, blocs

Statut : exigences posées par l'utilisateur (1-6) ; les choix techniques marqués **[proposé]** restent à valider par un prototype.
Complète : ADR-001, `docs/dossier-fondamentaux-v1.1.md` (§4 UX, §5 exigences), `docs/review/ux-ui.md` §2.

## 1. Utilisateurs qui s'authentifient ≠ personnes planifiées

**Réponse : ce sont deux entités distinctes, et `schema.sql` v1.1 le fait déjà.**

| Entité | Table | Rôle |
|---|---|---|
| Identité (se connecte) | `users` (email, `idp_subject`) | Authentification, global à la plateforme |
| Appartenance + droits | `account_members` (`role`, `person_id` nullable) | Un user dans un compte, avec son rôle Owner/Admin/Member/Guest |
| Ressource planifiable | `people` (employee, contractor, placeholder) | Apparaît sur le Schedule, porte capacité et taux, compte comme siège (BR-15) |

Le lien est `account_members.person_id`, nullable, avec un index unique : une personne a au plus un compte de connexion.

| Cas | users | people |
|---|---|---|
| Admin qui ne se planifie pas | oui | non (`person_id` NULL) |
| Membre planifié qui se connecte | oui | oui, liée |
| Contractor planifié sans accès | non | oui |
| Placeholder (« Designer ? ») | non | oui |
| Guest en lecture seule | oui | non |

À faire en conception : l'écran People distingue visuellement « a un accès » / « invitation envoyée » / « sans accès » ; l'invitation relie un user à une personne existante. Le siège facturé suit la **personne**, pas le user (BR-15, ADR-001 n°2).

## 2. Zoom calendaire jour / semaine / mois

- Contrôle segmenté permanent dans la barre haute, plus raccourcis clavier et Ctrl + molette.
- Changer de zoom **conserve le point central** de la vue (la date au milieu reste au milieu).
- Le zoom ne change que l'échelle : mêmes blocs, mêmes gestes (en mois, les blocs restent déplaçables à la journée).

## 3. Navigation horizontale et bouton « Aujourd'hui »

- Défilement horizontal continu sur toute la plage planifiable, passé compris. Données chargées **par fenêtre** autour de la vue visible, avec préchargement de part et d'autre.
- Bouton **« Aujourd'hui »** toujours visible, raccourci `T` : recale la vue sur la date du jour en conservant le zoom. Indicateur de la ligne « aujourd'hui » dans la grille.
- Aller à une date (sélecteur) et flèches précédent/suivant.
- **À définir :** bornes de la plage planifiable (proposition : de 2 ans dans le passé à 3 ans dans le futur, configurable par compte).

## 4. i18n dès le départ (NFR)

- Langues au lancement : **FR et EN**. Aucune chaîne en dur dans l'interface ni dans les messages d'erreur de l'API.
- Messages au format ICU (pluriels, genre, variables) **[proposé : FormatJS ou Lingui, à trancher au spike]**.
- Dates, nombres, durées et premier jour de semaine via `Intl`, jamais formatés à la main. Durées en décimal (BR-11) avec séparateur local.
- CSS en propriétés logiques (`inline-start`) pour ne pas bloquer une langue RTL plus tard. Textes qui s'allongent (EN → DE) sans casser les blocs.
- **Schéma, à ajouter :** `accounts.default_locale`, `users.locale`. Absent de `schema.sql` v1.1 (seul `accounts.timezone` existe).
- Qualité : lint « pas de chaîne en dur » et test de pseudo-localisation en CI ; règle imposée aux agents de la factory (`docs/factory/strategy.md`).

## 5. Fluidité de la saisie des plages

La cible est l'inverse d'un outil de gestion à formulaires. Exigences :
- **Manipulation directe d'abord** : glisser sur des cellules vides crée un bloc, sans dialogue ; le bloc apparaît pendant le geste.
- **Saisie rapide au clavier** : une barre de saisie accepte du langage simple (« Refonte 6h lun-mer », « 50 % jusqu'au 28 »), avec aperçu du bloc en direct avant validation.
- **Aimantation** à la journée, au demi-jour ou à l'heure selon le zoom ; la valeur (dates, heures, %) s'affiche près du curseur pendant le geste.
- **Optimistic UI** : aucune attente visible ; échec = retour arrière et message (principe du dossier §4.1).
- **Budgets mesurables** [proposé] : création perçue < 100 ms ; drag et resize à 60 images/s ; INP p95 < 100 ms ; changement de zoom < 150 ms.
- Édition sur place (clic sur la valeur) plutôt que fenêtre modale pour les modifications courantes ; le popover reste pour les champs avancés.
- Chaque geste a un équivalent clavier (ADR-001 n°9).

## 6. Blocs multi-jours, à hauteur variable, manipulables

Modèle visuel :
- Largeur = durée en jours (un bloc peut tenir sur une seule journée).
- **Hauteur = part de la capacité du jour** (6 h sur 8 h = 75 % de la hauteur de ligne). Une allocation en % se dessine à ce pourcentage.
- Plusieurs blocs de la même personne s'**empilent verticalement** ; la somme dépasse 100 % de la hauteur de ligne quand il y a sur-allocation, signalée par ▲ et le débordement (BR-01).
- Gestes : déplacer (date, personne), étirer ou réduire à gauche/droite (dates), poignée haut/bas (heures ou %), dupliquer (Alt + glisser), couper, supprimer.

**Bibliothèques : aucune ne couvre l'ensemble. [proposé] : moteur de planning sur mesure.**

| Option | Ce qu'elle apporte | Ce qui manque |
|---|---|---|
| FullCalendar (resource-timeline) | Lignes par ressource, drag/resize | Module payant ; pas de hauteur de bloc en % de capacité |
| Bryntum / DHTMLX | Planning de ressources complet | Licences commerciales, forte emprise, rendu à adapter à notre modèle de capacité |
| vis-timeline | Open source, groupes, drag/resize | Pas de hauteur variable ni d'empilement par capacité |
| react-big-calendar | Léger | Pas de lignes par ressource en horizontal |
| dnd-kit | Drag and drop générique accessible | Aucune notion de resize ni de grille temporelle |
| interact.js | Drag, resize, aimantation, indépendant du framework | Aucun rendu ; à combiner avec notre grille |
| TanStack Virtual | Virtualisation des lignes et colonnes | Aucun geste |

Proposition : **moteur de layout en TypeScript pur** (position, aimantation, empilement, détection de sur-allocation ; testable sans navigateur, partagé client/serveur comme le moteur de capacité), **blocs en DOM virtualisés** (seuls les blocs visibles sont rendus), gestes via pointer events ou interact.js, virtualisation via TanStack Virtual.

Cela **amende ADR-001 n°9** (« Schedule canvas + overlay DOM ») : des blocs en DOM simplifient l'accessibilité (`role=grid`, focus, lecteurs d'écran) et l'édition sur place. Le canvas reste le repli si le prototype rate le budget de performance.

Je n'ai pas vérifié l'état des licences et des versions de ces bibliothèques en 2026 ; à contrôler avant tout choix.

## Spike à lancer avant la phase P1 de la factory

1. Prototype de la grille : 300 personnes × 12 mois, blocs à hauteur variable, drag/resize, zoom, « Aujourd'hui ».
2. Mesure : images/s en drag, temps du premier rendu, mémoire, INP.
3. Décision DOM vs canvas sur ces mesures ; choix de la bibliothèque i18n.

## Impacts à reporter

- `docs/dossier-fondamentaux-v1.1.md` : NFR i18n, exigences 2, 3, 5, 6 dans FR-03.
- `docs/review/ux-ui.md` §2 : hauteur = % de capacité, empilement, saisie rapide.
- `schema.sql` : colonnes de langue (§4) ; plage planifiable si elle devient configurable.
- `docs/ecrans-et-parcours.html` : barre de saisie rapide, état « sans accès » dans People.
