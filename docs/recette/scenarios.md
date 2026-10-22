# Scénarios de recette (P6)

Scénarios R-01..R-25 à rejouer par Alec à chaque cycle de recette (ADR-008), sur la pile locale. Ils sont tirés des parcours de `docs/ecrans-et-parcours.html` (le parcours 5, Timesheet, est T2 : exclu) et des critères d'acceptation des US E1 à E7 du dossier §5.3 (MVP T1 seulement). Le registre des retours est `registre.md`.

## Mode d'emploi

1. Démarrer la pile avec le seed de recette : `npm run dev:recette:seed` (API, PostgreSQL embarqué dédié `.dev-pg-recette/`, IdP local et écran Vite en OIDC, en une commande ; Ctrl-C arrête tout). Ne pas la lancer en même temps que `dev:stack` / `dev:recette` / `dev:recette:vide` (mêmes ports) ; la base `.dev-pg/` n'est jamais touchée (répertoire et base vérifiés avant toute suppression ou écriture). Sur la page de choix de l'IdP, se connecter en **Alec** (owner) ; autres comptes dans `docs/runbooks/demarrage-local.md` (Camille Roy member, Nadia Benali project_manager, Admin Recette, Invité Recette guest, Admin Autre Société sur le second compte). `--reset` repart du jeu initial.
2. Données : le seed de recette `scripts/seed-recette.mjs` est **disponible** (RT-044). Compte « WNEXT Recette » : 18 personnes sur 4 équipes, 3 clients, 7 projets dont `REF-01` « Refonte » et `SITE-01` « Site vitrine », allocations, congés, férié France, temps loggé. Les dates sont relatives au lundi de la semaine du semis (S0 ; S+2 = lundi 2026-11-02 si le seed a été fait la semaine du 2026-10-19), pas aux dates ISO écrites dans les scénarios : lire « 2026-11-02 » comme « lundi S+2 », « 2026-11-09 » comme « lundi S+3 ». Les scénarios R-01 et R-02 citent `alec@example.test` : l'e-mail réel du compte Alec est `alec@wnext.test`. Un vrai **compte vide** (R-06) : `npm run dev:recette:vide` (base dédiée `.dev-pg-vide/`, compte « WNEXT Vide », Alec owner seul, aucune personne ni projet) ; `-- --reset` le remet à zéro. Jamais `dev:stack -- --reset` pour cela : il supprimerait `.dev-pg/` et sèmerait 50 personnes. Correspondance des préconditions (le seed les répartit entre plusieurs personnes pour qu'elles tiennent toutes ensemble) :
   - R-04 : **Julie Lambert** (au lieu de Camille) : 6 h/jour sur `REF-01` en S+1, 10 h/jour en S+2 (75 % puis 125 %).
   - R-10 : **Lucas Morel** (libre toute la semaine S+2 et S+3), avec Léo Martin comme seconde personne.
   - R-12, R-15 : **Camille Roy** : bloc `REF-01` 8 h lun-mer S+2, plus 5 h `SITE-01` le mardi S+2 (+5 h) ; Léo Martin libre ce mardi.
   - R-13 : Camille Roy libre lundi-mardi S+3. R-18 : **Antoine Mercier**, 3 allocations lundi-mercredi S+3.
   - R-19 : férié France le mercredi S+3 (Camille 0 h, **Sam Carter**, États-Unis, 8 h). R-16 : à saisir (non semé). R-20 : Léo Martin, 12 allocations et 34 h loggées sur `REF-01`.
   - R-08 : `SITE-01` existe déjà (pour R-12, R-15) : prendre `SITE-02` pour l'étape « code corrigé » ; `REF-01` reste le doublon à tester. R-09 renomme `REF-01` : jouer R-11 avant.
   - R-24 : le project_manager (Nadia Benali) gère `REF-01` **et** co-gère `SITE-01` ; Camille Roy est le member lié à une personne, les autres personnes n'ont aucun accès ; second compte « Autre Société ». R-23 : sessions Alec et Camille Roy ; la cloche part vide.
   - Cas utiles : surbooking Thomas Girard (S0), sous-allocation Hugo Petit et Maxime Rousseau, Karim Haddad travaille le samedi et a un congé matin jeudi S0, Élodie Fontaine à temps partiel, Chloé Bernard congé en attente, projet tentatif `AO-01`, série « Point hebdo Refonte » (Nadia, lundis), groupe « Atelier de lancement » (Thomas, Nadia, Yasmine).
3. Pour chaque scénario : suivre les étapes, comparer au résultat attendu, puis renseigner la colonne **Statut** du tableau final : `OK`, `KO` (écart) ou `—` (non passé). La colonne **Faisable** indique si le scénario peut être joué aujourd'hui (`oui`) ou s'il est bloqué par un retour du registre (`bloqué : RT-nnn`) ; un scénario bloqué se rejoue après correction du retour.
4. **Consigner un écart** : soit une nouvelle note brute dans `docs/recette/notes/AAAA-MM-JJ-note-N.txt` (en vrac, elle sera cadrée en retours `RT-nnn`), soit directement une ligne dans `registre.md` si l'écart est déjà atomique (citer le scénario, p. ex. « R-07 étape 3 »). Ne jamais modifier une note existante.
5. Convention : heures en décimal ; semaine affichée selon `accounts.week_start` ; dates au format ISO dans les données ci-dessous.

## Scénarios

### R-01 — Accès protégé par une connexion
- **Couvre** : parcours 1 (entrée), ADR-002 §1, US-6.1 ; RT-002.
- **Faisable** : bloqué : RT-002 (pas d'écran de connexion ; le mode OIDC redirige vers l'IdP local mais le mode `dev` par défaut s'ouvre sans authentification).
- **Préconditions** : compte de recette, utilisateur `alec@example.test` (Owner) connu de l'IdP local, session fermée.
- **Étant donné** que je ne suis pas connecté. **Quand** j'ouvre l'URL de l'application. **Alors** je vois un portail de connexion, jamais le Schedule.
- **Quand** je me connecte en `alec@example.test`. **Alors** j'arrive sur le Schedule de mon compte.
- **Attendu** : aucun accès au Schedule ni aux données sans session ; une session expirée ramène au portail.

### R-02 — En-tête applicatif et utilisateur connecté
- **Couvre** : ux-ui §2.1 ; RT-001, RT-003.
- **Faisable** : bloqué : RT-001, RT-003.
- **Préconditions** : connecté en `alec@example.test` (prénom Alec).
- **Étant donné** que je suis sur le Schedule. **Quand** je regarde le haut de l'écran. **Alors** un en-tête porte le nom « WNEXT », la navigation (Schedule, Projets, Personnes, Réglages) et, à droite, « Bonjour Alec ». La barre d'outils du Schedule est dans l'en-tête ou un sous-en-tête.
- **Attendu** : le nom affiché vient de l'utilisateur connecté (`GET /me`), pas d'une valeur codée.

### R-03 — Densité d'affichage à 3 niveaux
- **Couvre** : ux-ui §2.1-2.2, dossier §4.1 principe 6 ; RT-005, RT-006, RT-007 ; Q1, Q2.
- **Faisable** : bloqué : RT-005.
- **Préconditions** : compte de recette avec au moins 14 personnes actives, fenêtre du navigateur en 1920 × 1080.
- **Étant donné** que le Schedule affiche environ 12 personnes. **Quand** je choisis la densité « confortable » puis « aérée ». **Alors** il reste environ 8 puis environ 6 personnes visibles, la grille occupe toute la hauteur, et les blocs et textes grossissent.
- **Quand** je recharge la page. **Alors** la densité est conservée (Q2 : stockage local, puis vues sauvegardées).
- **Attendu** : lisible à chaque niveau ; aucun chevauchement de blocs ; le changement se fait à la volée sans rechargement.

### R-04 — Jauge d'allocation par personne
- **Couvre** : ux-ui §2.1, dossier §4.1 principe 4, US-4.1 ; RT-008 ; Q3.
- **Faisable** : bloqué : RT-008 (seule la bande de capacité en pied de ligne existe).
- **Préconditions** : Camille Roy (8 h/jour ouvré) a 5 jours de 6 h puis 5 jours de 10 h sur le projet Refonte, dans les deux prochaines semaines.
- **Étant donné** une fenêtre visible sur la 1re semaine. **Alors** la colonne de gauche de Camille affiche une jauge à 75 %. **Quand** je défile sur la 2e semaine. **Alors** elle affiche 125 % avec une icône et un texte de dépassement (pas la couleur seule).
- **Attendu** : l'infobulle dit « du … au … » pour la période visible et la jauge se met à jour au défilement.

### R-05 — Les formulaires s'ouvrent en fenêtre superposée
- **Couvre** : ux-ui §3.4 ; RT-009.
- **Faisable** : oui pour constater l'écart (RT-009 ouvert) ; le scénario ne passe qu'après L-D.
- **Préconditions** : compte de recette, connecté.
- **Quand** j'ouvre « Nouveau congé », « Importer », « Retrait d'équipe » et la cloche de notifications. **Alors** chacun s'ouvre dans une fenêtre superposée (Modal, Popover ou Drawer), jamais dans un panneau inséré en bas de page.
- **Attendu** : bouton Fermer et touche Échap fonctionnels, focus rendu au déclencheur, la page derrière ne se décale pas.

### R-06 — Première allocation depuis un compte vide
- **Couvre** : parcours 1 ; US-1.1, US-2.1, US-3.1 ; RT-010, RT-012, RT-015.
- **Faisable** : bloqué : RT-012 (pas d'écran Personnes), RT-010 (pas d'écran Projets), RT-015 (pas de création d'un bloc par clic).
- **Préconditions** : compte vide, connecté en Owner.
- **Étant donné** le Schedule vide avec « Ajoutez vos premières personnes ». **Quand** j'ajoute Camille Roy (employée), puis Léo Martin (placeholder, sans e-mail), puis le client Acme et le projet « Refonte » (code REF-01, couleur du sélecteur), puis je pose un bloc de Camille sur REF-01 du lundi au mercredi. **Alors** le bloc apparaît avec la capacité visible tout de suite.
- **Attendu** : moins de 5 minutes de bout en bout, sans SQL ni import, personne créée avec moins de 3 champs obligatoires.

### R-07 — Création d'une personne
- **Couvre** : US-1.1 ; RT-012.
- **Faisable** : bloqué : RT-012.
- **Préconditions** : compte de recette.
- **Quand** je crée « Inès Dupont », type employee, horaires par défaut du compte `{8,8,8,8,8,0,0}`. **Alors** elle apparaît dans la liste Personnes et dans le Schedule.
- **Quand** je crée « À recruter », type placeholder, sans e-mail. **Alors** c'est accepté.
- **Quand** je saisis 25 h pour un jour. **Alors** refus avec un message clair (7 valeurs entre 0 et 24).
- **Quand** j'archive Inès. **Alors** elle quitte le Schedule par défaut, son historique reste.

### R-08 — Création client et projet
- **Couvre** : US-2.1 ; RT-010, RT-012, RT-018.
- **Faisable** : bloqué : RT-010, RT-012.
- **Préconditions** : compte de recette contenant déjà le projet REF-01.
- **Quand** je crée le client Acme puis le projet « Site vitrine » avec le code REF-01. **Alors** refus clair (code en double).
- **Quand** je corrige en SITE-01 avec fin au 2026-11-01 et début au 2026-11-15. **Alors** refus (fin avant début).
- **Quand** je corrige les dates et choisis une couleur. **Alors** le projet est créé ; une couleur sous 4,5:1 de contraste est refusée ou corrigée.

### R-09 — Propriétés d'un projet et de son équipe
- **Couvre** : dossier §4.1 principe 1, ux-ui §3.4 ; RT-010, RT-018.
- **Faisable** : bloqué : RT-010.
- **Préconditions** : compte de recette, projet REF-01.
- **Quand** j'ouvre le projet REF-01 depuis la liste Projets. **Alors** un panneau montre ses propriétés (nom, client, code, dates, couleur, statut tentative/confirmé, tâches) et son équipe.
- **Quand** je change le nom en « Refonte v2 » et la couleur. **Alors** le Schedule affiche aussitôt le nouveau nom et la nouvelle couleur sur tous ses blocs, et un second onglet les voit en moins de 1 s.

### R-10 — Poser une allocation par glisser sur une zone libre
- **Couvre** : US-3.1 ; RT-015, RT-016.
- **Faisable** : bloqué : RT-015 (aujourd'hui seule la saisie rapide crée un bloc).
- **Préconditions** : compte de recette, Camille libre la semaine du 2026-11-02.
- **Quand** je glisse sur la ligne de Camille du lundi 2026-11-02 au mercredi 2026-11-04. **Alors** un bloc provisoire apparaît en moins de 100 ms perçus et l'éditeur s'ouvre.
- **Quand** je choisis le projet REF-01, ajoute Léo Martin comme seconde personne et valide. **Alors** deux allocations (une par personne) sont créées.
- **Quand** je glisse sur un samedi non ouvré. **Alors** refus (BR-01) ; un dépassement de capacité est accepté et signalé.
- **Attendu** : le bouton « + Allocation » visible fait la même chose, au clavier aussi.

### R-11 — Saisie rapide
- **Couvre** : US-3.1 ; fonction existante.
- **Faisable** : oui.
- **Préconditions** : compte de recette, projet « Refonte » existant, Camille sélectionnée.
- **Quand** j'appuie sur `/`, tape « Refonte 6h lun-mer » et valide. **Alors** l'aperçu en direct annonce 3 jours à 6 h, puis trois jours de 6 h sont créés, annulables par Ctrl+Z.
- **Attendu** : sans heures précisées, la saisie vaut 8 h par jour.

### R-12 — Éditer un bloc posé et changer son projet
- **Couvre** : dossier §4.1 principe 2, ux-ui §3.4 ; RT-011, RT-013, RT-014 ; Q5.
- **Faisable** : bloqué : RT-011, RT-013, RT-014.
- **Préconditions** : compte de recette, un bloc « Refonte » de Camille du 2026-11-02 au 2026-11-04.
- **Quand** je double-clique le bloc (ou clic simple puis Entrée). **Alors** une fenêtre s'ouvre avec le projet, la tâche, les dates, les heures et la personne, prérenseignés.
- **Quand** je choisis le projet « Site vitrine » dans la liste (recherche par saisie) et valide. **Alors** le bloc change de projet et de couleur sans bouger de place, un 2e onglet le voit en moins de 1 s.
- **Attendu** : un clic simple ne fait que sélectionner (poignées, clavier).

### R-13 — Une même fenêtre pour projet et congé
- **Couvre** : ux-ui §3.4 ; RT-017 ; parcours 3.
- **Faisable** : bloqué : RT-017 (le congé a son propre formulaire).
- **Préconditions** : compte de recette, Camille libre du 2026-11-09 au 2026-11-10.
- **Quand** j'ouvre l'éditeur de créneau sur ces dates. **Alors** l'onglet « Projet / tâche » est affiché par défaut et l'onglet « Congé » est disponible.
- **Quand** je passe sur « Congé » et choisis le type « Congés payés ». **Alors** un bloc de congé est posé et la capacité de Camille baisse de 16 h sur les 2 jours.

### R-14 — Couleur du projet depuis le bloc
- **Couvre** : US-2.1 ; RT-018.
- **Faisable** : bloqué : RT-018.
- **Préconditions** : bloc « Refonte » posé.
- **Quand** j'ouvre le bloc et change la couleur du projet. **Alors** tous les blocs de ce projet changent de couleur ; une couleur de contraste inférieur à 4,5:1 est refusée.

### R-15 — Détecter un surbooking et le résoudre (north star)
- **Couvre** : parcours 2 ; US-3.1, US-4.1, US-3.5 ; BR-01.
- **Faisable** : oui pour la détection et le déplacement ; « Trouver quelqu'un de dispo » n'existe pas encore (lot « Assistant de première allocation »).
- **Préconditions** : Camille (8 h/jour) a 8 h sur REF-01 et 5 h sur SITE-01 le 2026-11-03 ; Léo est libre le même jour.
- **Étant donné** ce jour. **Alors** la ligne de Camille affiche « +5 h » avec une icône et un texte, pas la couleur seule.
- **Quand** je déplace le bloc SITE-01 chez Léo (glisser, ou Alt+Flèches au clavier). **Alors** l'alerte disparaît ; un 2e onglet voit le changement en moins de 1 s.
- **Attendu** : résolution en moins de 10 s sans quitter la grille.

### R-16 — Jeu chiffré de capacité
- **Couvre** : US-4.1, BR-38.
- **Faisable** : oui.
- **Préconditions** : Camille 8 h ouvrées ; un férié France ce jour ; 4 h de congé ; 5 h allouées (à saisir pour la date de test).
- **Alors** capacité 4 h, utilisation 125 %, surtemps 1 h, exposés aussi par motif ou icône.
- **Attendu** : le pourcentage vient du moteur, jamais de l'API.

### R-17 — Déplacer, étirer, dupliquer, supprimer, annuler
- **Couvre** : US-3.2 ; fonction existante.
- **Faisable** : oui.
- **Préconditions** : un bloc de 3 jours.
- **Quand** je déplace, étire par la poignée droite, duplique, scinde puis supprime le bloc. **Alors** chaque geste a son équivalent clavier ; Ctrl+Z annule la dernière action, suppression comprise ; la scission conserve projet, tâche et notes.
- **Attendu** : la découpe d'une occurrence de série n'est pas annulable (connu).

### R-18 — Congé posé sur des allocations existantes (BR-04)
- **Couvre** : parcours 3 ; US-5.1, US-5.2, BR-04.
- **Faisable** : oui jusqu'au choix du report ; l'approbation n'est pas dans l'écran (lot « Approbation des congés »).
- **Préconditions** : Camille a 3 allocations du 2026-11-09 au 2026-11-11.
- **Quand** je pose un congé pleine journée du 2026-11-09 au 2026-11-11. **Alors** un avertissement liste « 3 allocations impactées » avec les actions reporter, laisser ou réduire ; aucune allocation n'est supprimée.
- **Quand** je laisse sans résoudre. **Alors** un badge de conflit reste visible. **Quand** je choisis « reporter ». **Alors** les allocations se décalent, le badge disparaît, le temps loggé est inchangé.
- **Quand** je pose un congé en demi-journée matin. **Alors** 50 % des heures du jour sont déduites. Un congé `pending` s'affiche hachuré.

### R-19 — Fériés par pays
- **Couvre** : US-5.3.
- **Faisable** : oui si les fériés sont saisis (écran Réglages bloqué : RT-012 ; sinon par API ou import).
- **Préconditions** : Camille rattachée à FR, Sam à US, férié FR le 2026-11-11.
- **Alors** Camille a une capacité de 0 h ce jour et Sam de 8 h.

### R-20 — Retirer une personne d'un projet (BR-10)
- **Couvre** : parcours 4 ; US-2.2, BR-10.
- **Faisable** : oui par le menu contextuel du Schedule ; la fiche projet est bloquée par RT-010.
- **Préconditions** : Léo a 12 allocations et 34 h loggées sur REF-01.
- **Quand** je retire Léo de REF-01. **Alors** un récapitulatif annonce « 12 allocations, 34 h loggées seront supprimées » et rien n'est supprimé avant confirmation (saisie demandée si le nombre est grand, lien « Plutôt réaffecter »).
- **Quand** je confirme. **Alors** un toast « Annuler » reste 10 s ; une entrée `delete_log` par ligne supprimée.

### R-21 — Import CSV de personnes, projets, clients
- **Couvre** : parcours 6 ; US-1.2.
- **Faisable** : oui (rôle Owner ou Admin).
- **Préconditions** : un CSV de 300 personnes (colonnes nom, e-mail, type, département) avec 3 lignes invalides.
- **Quand** je l'importe en simulation puis pour de bon. **Alors** la prévisualisation sépare lignes valides et erreurs ligne par ligne, 300 lignes sont traitées en moins de 30 s.
- **Quand** je réimporte le même fichier. **Alors** aucun doublon (clé e-mail ou code projet).

### R-22 — Recherche, filtres, vues sauvegardées
- **Couvre** : US-7.1, US-7.2 ; densité dans les vues (Q2).
- **Faisable** : oui.
- **Préconditions** : compte de recette avec plusieurs départements.
- **Quand** je filtre sur le département Design et le projet REF-01, puis tape « Cam » dans la recherche. **Alors** le résultat se met à jour en moins de 150 ms.
- **Quand** j'enregistre la vue « Design REF » puis la rouvre par son lien `?view=`. **Alors** filtres et zoom sont restitués.

### R-23 — Notifications in-app
- **Couvre** : US-7.3, US-3.5.
- **Faisable** : oui.
- **Préconditions** : deux sessions (Alec et Camille).
- **Quand** Alec modifie une allocation de Camille. **Alors** la cloche de Camille s'incrémente en moins de 1 s ; la liste s'ouvre en fenêtre, « tout marquer lu » remet le compteur à 0 ; une préférence décochée supprime ce type de notification.

### R-24 — Rôles et isolation
- **Couvre** : US-6.1, BR-33.
- **Faisable** : oui avec les utilisateurs de l'IdP local.
- **Préconditions** : un Member, un Guest, un PM limité à REF-01, un second compte.
- **Alors** le Member ne voit que ses assignations (API et temps réel) ; le Guest n'a aucune écriture ; le PM ne modifie que REF-01 ; aucune donnée de l'autre compte n'apparaît jamais.

### R-25 — Conflit d'édition concurrent
- **Couvre** : US-3.5.
- **Faisable** : oui (deux onglets).
- **Quand** je modifie le même bloc dans deux onglets avant synchronisation. **Alors** aucune perte silencieuse : le second enregistrement signale le conflit et propose de recharger.

## Suivi

| Id | Titre | Faisable aujourd'hui | Statut |
|---|---|---|---|
| R-01 | Accès protégé par une connexion | bloqué : RT-002 | — |
| R-02 | En-tête applicatif et utilisateur connecté | bloqué : RT-001, RT-003 | — |
| R-03 | Densité d'affichage à 3 niveaux | bloqué : RT-005 | — |
| R-04 | Jauge d'allocation par personne | bloqué : RT-008 | — |
| R-05 | Formulaires en fenêtre superposée | oui (échec attendu : RT-009) | — |
| R-06 | Première allocation depuis un compte vide | bloqué : RT-010, RT-012, RT-015 | — |
| R-07 | Création d'une personne | bloqué : RT-012 | — |
| R-08 | Création client et projet | bloqué : RT-010, RT-012 | — |
| R-09 | Propriétés d'un projet et équipe | bloqué : RT-010 | — |
| R-10 | Poser une allocation par glisser | bloqué : RT-015, RT-016 | — |
| R-11 | Saisie rapide | oui | — |
| R-12 | Éditer un bloc, changer de projet | bloqué : RT-011, RT-013, RT-014 | — |
| R-13 | Fenêtre unique projet et congé | bloqué : RT-017 | — |
| R-14 | Couleur du projet depuis le bloc | bloqué : RT-018 | — |
| R-15 | Surbooking détecté et résolu | oui (sans « Trouver quelqu'un ») | — |
| R-16 | Jeu chiffré de capacité | oui | — |
| R-17 | Déplacer, étirer, dupliquer, annuler | oui | — |
| R-18 | Congé sur allocations (BR-04) | oui (sans approbation) | — |
| R-19 | Fériés par pays | oui (saisie hors écran) | — |
| R-20 | Retrait d'équipe (BR-10) | oui (menu du Schedule) | — |
| R-21 | Import CSV | oui | — |
| R-22 | Recherche, filtres, vues | oui | — |
| R-23 | Notifications in-app | oui | — |
| R-24 | Rôles et isolation | oui | — |
| R-25 | Conflit d'édition concurrent | oui | — |
