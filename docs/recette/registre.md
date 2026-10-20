# Registre des retours de recette (P6)

Source de vérité de la recette (ADR-008). Un retour = une observation atomique, tracée vers sa note source (citation exacte) et vers la spec.
Les notes d'Alec sont dans `notes/` et ne sont jamais modifiées. Synthèse de chaque cycle : `cadrage-N.html`.

**Cycle de vie** : `qualifié → validé → planifié → corrigé → vérifié`, ou `rejeté` / `reporté (T2+)` avec la raison.
**Nature** : anomalie (écart au comportement spécifié) · manque (prévu au MVP, absent) · ergonomie · graphique · texte · performance · évolution (hors spec) · décision (choix technique ou produit) · constat (positif, à préserver).
**Écart à la spec** : *écart* (à corriger) · *contesté* (conforme à la spec mais remis en cause : décision d'Alec, puis amendement) · *hors spec* (évolution).
**Gravité** : bloquante (empêche un parcours du MVP) · majeure · mineure · cosmétique.

## Note n°1 — 2026-10-21 (`notes/2026-10-21-note-1.txt`)

Reproduction : vérifiée dans le code de `main` à `11bc44d` (écran Schedule, démo et `dev:stack`).

| ID | Retour | Citation (ligne) | Nature | Spec | Écart | Écran | Gravité | Cible | Lot | Statut |
|---|---|---|---|---|---|---|---|---|---|---|
| RT-001 | Pas d'en-tête applicatif portant le nom de l'app ; la barre d'outils doit s'intégrer à un header ou un sous-header | « il n'y a aucun header qui reprend le nom de l'app […] avec une toolbar intégrée à ce header ou sub-header » (l. 3) | manque | ux-ui §2.1 (barre haute) ; dossier §4.1 principe 1 (onglets) | écart | Coque | majeure | P6 | L-B | qualifié |
| RT-002 | L'app s'ouvre sans authentification ; il faut un portail de connexion adossé à la base des utilisateurs | « je ne devrais pas pouvoir accéder à ça de façon complètement libre. Je devrais passer par un portail d'authentification » (l. 3) | manque | ADR-002 §1 (`users` / `account_members`) ; OIDC PKCE existant mais mode `dev` par défaut, pas d'écran de connexion | écart | Connexion | majeure | P6 | L-B | qualifié |
| RT-003 | Afficher l'utilisateur connecté (« Bonjour Alec ») à droite de l'en-tête | « j'ai « Bonjour Alec », qui est disponible traditionnellement plutôt à droite » (l. 5) | manque | ux-ui §2.1 ; nécessite `GET /me` (absent) | écart | Coque | mineure | P6 | L-B | qualifié |
| RT-004 | Le canevas (grille) convient à ce stade | « le canevas a l'air, ma foi, très bien » (l. 8) | constat | ADR-005 | — | Schedule | — | à préserver | — | qualifié |
| RT-005 | Réglage de densité d'affichage à 3 niveaux (aujourd'hui ~12 personnes visibles ; viser aussi ~8 et ~6) | « régler trois tailles de densité […] passerait de 12 à 8 […] encore un autre niveau où on passerait à 6 » (l. 10-12) | manque | ux-ui §2.1 (toggle densité), §2.2 (32 / 40 / 48 px) ; dossier §4.1 principe 6 | écart, et *contesté* sur les valeurs (Q1) | Schedule | majeure | P6 | L-C | qualifié |
| RT-006 | En densité aérée, les éléments grossissent (blocs, textes) et occupent toute la hauteur | « je vais pouvoir faire grossir les éléments pour rendre tout ça beaucoup plus aéré » (l. 14) | graphique | ux-ui §2.2, §3.2 | hors spec (la spec ne change que la hauteur de ligne) | Schedule | mineure | P6 | L-C | qualifié |
| RT-007 | Réglage de densité appliqué à la volée d'abord, puis sauvegardé et attaché au profil | « dans un premier temps uniquement à la volée et, dans un deuxième temps, qui serait sauvegardée, peut-être attachée au profil » (l. 10) | manque | ux-ui §6 Q4 (préférences utilisateur absentes du schéma) | écart (Q2) | Schedule | mineure | P6 (à la volée), puis selon Q2 | L-C | qualifié |
| RT-008 | Jauge d'allocation / surallocation par personne, sur une période à définir (recommandation demandée) | « chaque personne devra avoir une petite barre de remplissage […] Est-ce que c'est juste la période du viewport ? » (l. 16) | manque | ux-ui §2.1 (jauge 4 px + % de la période visible) ; dossier §4.1 principe 4 | écart (Q3 pour la période) | Schedule | majeure | P6 | L-C | qualifié |
| RT-009 | Les formulaires (ex. nouveau congé) s'ouvrent dans un panneau inséré en bas de page au lieu d'une fenêtre superposée | « vont ouvrir une sorte de panel docké en bas. C'est pas une pop-in. Tout ça, ça va pas » (l. 17) | ergonomie | ux-ui §3.4 (Popover, Modal en dernier recours, Drawer) ; `.wn-dialog` est dans le flux | écart | Schedule (tous les dialogues) | majeure | P6 | L-D | qualifié |
| RT-010 | Aucune interface pour éditer les propriétés d'un projet (et de ses tâches) | « je ne sais pas comment on édite les propriétés afférentes à un projet » (l. 19) | manque | dossier §4.1 principe 1 (panneau projet latéral) ; ux-ui §2.1, §3.4 `ProjectSidebar` | écart | Projets | bloquante | P6 | L-F | qualifié |
| RT-011 | Aucune interface pour modifier une allocation déjà posée (changer son projet, sa tâche…) | « on manque d'un bout d'interface pour permettre de changer l'allocation qu'on pose » (l. 19) ; « je dois pouvoir très facilement changer […] projet B » (l. 25) | manque | dossier §4.1 principe 2 (« le clic ouvre un popover ») ; ux-ui §3.4 `AllocationPopover` | écart | Schedule | bloquante | P6 | L-E | qualifié |
| RT-012 | Pas de back-office : listes et CRUD des projets, des personnes et des équipes | « J'ai un CRUD avec la liste des projets, par exemple, ou la liste des équipes […] Idem pour la liste des personnes » (l. 21) | manque | dossier §4.1 principe 1 (onglets Projects, People ; Settings hors navigation) ; US-1.1, US-2.1 | écart (Q4 pour « équipes ») | Projets, Personnes, Réglages | bloquante | P6 | L-F | qualifié |
| RT-013 | Clic (ou double-clic, à définir) sur un bloc posé : ouvre une pop-in d'édition qui reprend les informations du projet | « quand je clique sur un élément du déjà posé […] (cliquer ou peut-être double cliquer, trigger à définir), ouvre une popine » (l. 23) | ergonomie | dossier §4.1 principe 2 ; aujourd'hui le clic sélectionne et montre les poignées | écart (Q5 pour le déclencheur) | Schedule | majeure | P6 | L-E | qualifié |
| RT-014 | Changer le projet ou la tâche d'un bloc depuis le référentiel (liste reliée aux données) | « indiquant que ce n'est plus projet A ou tâche A, mais projet B […] connecté au référentiel » (l. 25) | manque | ux-ui §3.4 (Combobox avec recherche) | écart | Schedule | bloquante | P6 | L-E | qualifié |
| RT-015 | Créer une allocation sans passer par la saisie rapide : bouton visible et clic ou glisser dans une zone libre, qui crée un bloc provisoire puis ouvre l'édition | « Ce n'est pas un bouton accessible. C'est le fait de cliquer dans une zone blanche […] qui va me créer un bloc » (l. 27) ; « Il en va de même pour la création » (l. 25) | manque | US-3.1 (créer par glisser sur une cellule) ; ux-ui §2.1 (bouton `+ Allocation`), §2.4 | écart | Schedule | bloquante | P6 | L-E | qualifié |
| RT-016 | Dans la pop-in, choisir une ou plusieurs personnes | « sélectionner un projet, une personne ou plusieurs personnes » (l. 27) | manque | US-3.3, BR-26 (création de groupe déjà dans l'API) | écart | Schedule | majeure | P6 | L-E | qualifié |
| RT-017 | Une même pop-in pour un créneau : onglet « Projet / tâche » (par défaut) et onglet « Congé », car un créneau posé peut être une absence qui impacte la capacité | « ça peut être une allocation sur un projet ou la définition d'une absence ou d'un congé […] Le premier onglet par défaut […] le deuxième onglet, c'était une table de congé » (l. 28-30) | ergonomie | ux-ui §3.4 (`TimeoffRequestForm` séparé) ; parcours congé existant (BR-04) | hors spec (évolution alignée sur Float, proposée en P6) | Schedule | majeure | P6 | L-E | qualifié |
| RT-018 | Changer la couleur du projet depuis les propriétés de ce qui est posé | « je dois pouvoir changer la couleur du projet » (l. 32) | manque | US-2.1 (`ProjectColorPicker`, contraste ≥ 4,5:1) ; palette OKLCH (ux-ui §3.1) | écart | Schedule, Projets | mineure | P6 | L-E, L-F | qualifié |
| RT-019 | Utiliser Tailwind (bibliothèque CSS) | « d'un point de vue framework (plutôt librairie que framework), je veux du Tailwind » (l. 35) | décision | aucune contrainte contraire (ADR-003, ADR-005) ; consignée dans ADR-009 | — | Toutes | — | P6 | L-A | planifié |

## Lots proposés (cadrage n°1)

| Lot | Contenu | Retours | Modèle | Dépend de | Contrat |
|---|---|---|---|---|---|
| L-A | Tailwind v4 et design tokens (socle sans changement visible, garde-fou anti-couleurs en dur) | RT-019 | Sonnet | — | non |
| L-B | Coque applicative : en-tête WNEXT, navigation (Schedule, Projets, Personnes, Réglages), barre d'outils en sous-header, écran de connexion OIDC par défaut en recette, « Bonjour Alec » | RT-001, RT-002, RT-003 | Sonnet | L-A | oui (`GET /me`) |
| L-D | Primitives de fenêtres (Modal, Popover, Drawer) et migration de tous les dialogues vers des fenêtres superposées (Fermer + Échap) | RT-009 | Sonnet | L-A | non |
| L-C | Densité à 3 niveaux et jauge par personne dans la colonne de gauche | RT-005 à RT-008 | Opus (grille) | L-A, L-D | non |
| L-E | Éditeur de créneau : création (bouton, clic ou glisser en zone libre), pop-in à onglets Projet / tâche et Congé, changement de projet / tâche / personnes, couleur du projet | RT-011, RT-013 à RT-018 | Opus | L-D, L-C | à vérifier (aucun prévu) |
| L-F | Back-office : écrans Projets (liste, création, panneau propriétés et équipe), Personnes (liste, création, modification datée), Réglages (départements, rôles, clients, types de congé, fériés) | RT-010, RT-012, RT-018 | Sonnet | L-B | si une route manque |

## Questions à Alec (cadrage n°1)

| Q | Question | Retours | Recommandation |
|---|---|---|---|
| Q1 | Densité : hauteurs fixes calibrées pour ~12 / ~8 / ~6 personnes sur ton écran actuel, ou ajustement à la fenêtre (N personnes remplissent toujours la hauteur) ? | RT-005, RT-006 | Hauteurs fixes calibrées : stables au redimensionnement, compatibles avec l'empilement des blocs ; la spec (32 / 40 / 48 px) est amendée en conséquence. |
| Q2 | Persistance de la densité : à la volée (navigateur) + dans les vues sauvegardées, puis profil utilisateur plus tard ? | RT-007 | Oui : stockage local immédiat, la densité entre dans les vues sauvegardées (table existante) ; un profil utilisateur (préférences) en T2. |
| Q3 | Période de la jauge par personne | RT-008 | La période visible à l'écran (comme la spec), libellée « du … au … » dans l'infobulle et mise à jour au défilement ; une période fixe (semaine en cours, mois) plus tard si besoin. |
| Q4 | « Équipes » : ce sont les départements (groupes de personnes, déjà dans le schéma) ? | RT-012 | Oui : départements, libellés « Équipes » dans l'interface si tu préfères ce mot ; l'équipe d'un projet reste dans la fiche projet. |
| Q5 | Déclencheur de la pop-in d'édition | RT-013 | Clic simple = sélection (poignées, clavier), double-clic ou Entrée = pop-in ; un clic sur un bloc déjà sélectionné ouvre aussi la pop-in. |
