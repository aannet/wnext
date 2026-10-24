# Scénarios de recette (P6)

Scénarios R-01..R-32 à rejouer par Alec à chaque cycle de recette (ADR-008), sur la pile locale. Ils sont tirés des parcours de `docs/02-design/ecrans-et-parcours.html` (le parcours 5, Timesheet, est T2 : exclu) et des critères d'acceptation des US E1 à E7 du dossier §5.3 (MVP T1 seulement). Le registre des retours est `registre.md`.

## Mode d'emploi

1. Démarrer la pile avec le seed de recette : `npm run dev:recette:seed` (API, PostgreSQL embarqué dédié `.dev-pg-recette/`, IdP local et écran Vite en OIDC, en une commande ; Ctrl-C arrête tout). Ne pas la lancer en même temps que `dev:stack` / `dev:recette` / `dev:recette:vide` (mêmes ports) ; la base `.dev-pg/` n'est jamais touchée (répertoire et base vérifiés avant toute suppression ou écriture). Sur la page de choix de l'IdP, se connecter en **Alec** (owner) ; autres comptes dans `docs/03-tech/runbooks/demarrage-local.md` (Camille Roy member, Nadia Benali project_manager, Admin Recette, Invité Recette guest, Admin Autre Société sur le second compte). `--reset` repart du jeu initial.
2. Données : le seed de recette `scripts/seed-recette.mjs` est **disponible** (RT-044). Compte « WNEXT Recette » : 18 personnes sur 4 équipes, 3 clients, 7 projets dont `REF-01` « Refonte » et `SITE-01` « Site vitrine », allocations, congés, férié France, temps loggé. Les dates sont relatives au lundi de la semaine du semis (S0 ; S+2 = lundi 2026-11-02 si le seed a été fait la semaine du 2026-10-19), pas aux dates ISO écrites dans les scénarios : lire « 2026-11-02 » comme « lundi S+2 », « 2026-11-09 » comme « lundi S+3 ». Les scénarios R-01 et R-02 citent `alec@example.test` : l'e-mail réel du compte Alec est `alec@wnext.test`. Un vrai **compte vide** (R-06) : `npm run dev:recette:vide` (base dédiée `.dev-pg-vide/`, compte « WNEXT Vide », Alec owner seul, aucune personne ni projet) ; `-- --reset` le remet à zéro. Jamais `dev:stack -- --reset` pour cela : il supprimerait `.dev-pg/` et sèmerait 50 personnes. Correspondance des préconditions (le seed les répartit entre plusieurs personnes pour qu'elles tiennent toutes ensemble) :
   - R-04 : **Julie Lambert** (au lieu de Camille) : 6 h/jour sur `REF-01` en S+1, 10 h/jour en S+2 (75 % puis 125 %).
   - R-10 : **Lucas Morel** (libre toute la semaine S+2 et S+3), avec Léo Martin comme seconde personne.
   - R-12, R-15 : **Camille Roy** : bloc `REF-01` 8 h lun-mer S+2, plus 5 h `SITE-01` le mardi S+2 (+5 h) ; Léo Martin libre ce mardi.
   - R-13 : Camille Roy libre lundi-mardi S+3. R-18 : **Antoine Mercier**, 3 allocations lundi-mercredi S+3.
   - R-19 : férié France le mercredi S+3 (Camille 0 h, **Sam Carter**, États-Unis, 8 h). R-16 : à saisir (non semé). R-20 : Léo Martin, 12 allocations et 34 h loggées sur `REF-01`.
   - R-08 : `SITE-01` existe déjà (pour R-12, R-15) : prendre `SITE-02` pour l'étape « code corrigé » ; `REF-01` reste le doublon à tester. R-09 renomme `REF-01` : jouer R-11 avant.
   - R-24 : le project_manager (Nadia Benali) gère `REF-01` **et** co-gère `SITE-01` ; Camille Roy est le member lié à une personne, les autres personnes n'ont aucun accès ; second compte « Autre Société ». R-23 : sessions Alec et Camille Roy ; la cloche part vide.
   - Cas utiles : surbooking Thomas Girard (S0), sous-allocation Hugo Petit et Maxime Rousseau, Karim Haddad travaille le samedi et a un congé matin jeudi S0, Élodie Fontaine à temps partiel, Chloé Bernard congé en attente, projet tentatif `AO-01`, série « Point hebdo Refonte » (Nadia, lundis), groupe « Atelier de lancement » (Thomas, Nadia, Yasmine).
3. Pour chaque scénario : suivre les étapes, comparer au résultat attendu, puis renseigner la colonne **Statut** du tableau final (la colonne « Pré-recette auto » donne le résultat de `npm run test:recette`) : `OK`, `KO` (écart) ou `—` (non passé). La colonne **Faisable** indique si le scénario peut être joué aujourd'hui (`oui`) ou s'il est bloqué par un retour du registre (`bloqué : RT-nnn`) ; un scénario bloqué se rejoue après correction du retour.
4. **Consigner un écart** : soit une nouvelle note brute dans `docs/05-project/recette/notes/AAAA-MM-JJ-note-N.txt` (en vrac, elle sera cadrée en retours `RT-nnn`), soit directement une ligne dans `registre.md` si l'écart est déjà atomique (citer le scénario, p. ex. « R-07 étape 3 »). Ne jamais modifier une note existante.
5. Convention : heures en décimal ; semaine affichée selon `accounts.week_start` ; dates relatives au lundi du semis (« lundi S+2 ») dans les scénarios.

## Scénarios

Notation des dates : « lundi S+2 » = `S0 + 14 jours`, etc. (S0 = lundi de la semaine du semis). Les libellés entre guillemets sont ceux de l'interface livrée.

### R-01 — Accès protégé par une connexion
- **Couvre** : parcours 1 (entrée), ADR-002 §1, US-6.1 ; RT-002.
- **Faisable** : oui.
- **Préconditions** : `npm run dev:recette:seed` (mode OIDC), session fermée (fenêtre privée).
- **Étant donné** que je ne suis pas connecté. **Quand** j'ouvre l'URL de l'application. **Alors** je vois l'écran « Connexion » (ni en-tête ni grille), jamais le Planning ; l'API répond 401 sans session.
- **Quand** je clique « Se connecter » puis choisis **Alec** (`alec@wnext.test`, owner) sur la page de l'IdP local. **Alors** j'arrive sur le Planning de « WNEXT Recette », avec « Bonjour Alec » dans l'en-tête.
- **Attendu** : aucun accès au Planning ni aux données sans session ; une session expirée ramène à l'écran de connexion.

### R-02 — En-tête applicatif et utilisateur connecté
- **Couvre** : ux-ui §2.1 ; RT-001, RT-003, RT-025.
- **Faisable** : oui.
- **Préconditions** : connecté en Alec ; une seconde session (fenêtre privée) en Camille Roy.
- **Étant donné** que je suis sur le Planning. **Quand** je regarde le haut de l'écran. **Alors** l'en-tête porte le lien « WNEXT », la navigation « Planning, Projets, Personnes », le lien « Réglages » et « Bonjour Alec » à droite. Le titre « Planning » et la barre d'outils (niveau 2) se placent sous l'en-tête, sans chevauchement.
- **Attendu** : le nom affiché vient de l'utilisateur connecté (`GET /me`) : la session de Camille affiche « Bonjour Camille ».

### R-03 — Densité d'affichage à 3 niveaux
- **Couvre** : ux-ui §2.1-2.2, dossier §4.1 principe 6 ; RT-005, RT-006, RT-007 ; Q1, Q2.
- **Faisable** : oui (RT-050 corrigé : noms et blocs grossissent à chaque niveau).
- **Préconditions** : seed de recette (17 personnes actives), fenêtre du navigateur en 1920 × 1080.
- **Étant donné** le Planning en densité « Standard ». **Quand** j'ouvre le menu « Affichage » et choisis « Compacte », « Standard » puis « Aérée » (groupe « Densité »). **Alors** le nombre de lignes entières visibles diminue à chaque niveau, la grille occupe toute la hauteur, et en « Aérée » le nom de la personne et les blocs grossissent (RT-006).
- **Quand** je recharge la page. **Alors** la densité est conservée (Q2 : stockage local, puis vues sauvegardées).
- **Attendu** : lisible à chaque niveau, aucun chevauchement de blocs, changement à la volée sans rechargement. Remettre « Standard » en fin de scénario.

### R-04 — Jauge d'allocation par personne
- **Couvre** : ux-ui §2.1, dossier §4.1 principe 4, US-4.1 ; RT-008 ; Q3.
- **Faisable** : oui.
- **Préconditions** : **Julie Lambert** : 6 h/jour sur `REF-01` en S+1 (75 %), 10 h/jour en S+2 (125 %) ; fenêtre assez étroite (≈ 940 px) pour voir une semaine à la fois.
- **Étant donné** que la fenêtre visible couvre la semaine S+1 (zoom jour). **Alors** la colonne de gauche de Julie affiche une jauge « 75 % » ; l'infobulle dit « Du … au … : 30 h planifiées sur 40 h de capacité ». **Quand** je défile sur la semaine S+2. **Alors** la jauge affiche « ▲ 125 % +10 h » (icône et texte de dépassement, pas la couleur seule) et l'infobulle « 50 h planifiées sur 40 h ».
- **Attendu** : la jauge suit le défilement ; le pourcentage vient du moteur côté écran, jamais de l'API.

### R-05 — Les formulaires s'ouvrent en fenêtre superposée
- **Couvre** : ux-ui §3.4 ; RT-009, RT-023 ; `docs/02-design/design.md`.
- **Faisable** : oui (RT-049 sans objet depuis RT-060 : plus de bouton de création ; ouvert au clavier, le drawer rend le focus à la grille ou au bloc d'origine).
- **Préconditions** : connecté en Alec sur le Planning.
- **Quand** j'ouvre successivement le congé (touche C sur la grille, drawer), « Importer un fichier CSV… » (Réglages > Import, RT-054), la cloche « Notifications », l'aide des raccourcis (bouton « ? », RT-064) et, par clic droit sur un bloc de Camille Roy, « Retirer Camille Roy du projet Refonte… ». **Alors** chacun s'ouvre dans une fenêtre superposée (drawer, modale ou popover), jamais dans un panneau inséré dans la page.
- **Attendu** : Échap (ou Annuler / Fermer) ferme la fenêtre ; **le focus revient au déclencheur** ; la grille derrière ne se décale pas ; rien n'est retiré après Échap sur le dialogue de retrait.

### R-06 — Première allocation depuis un compte vide
- **Couvre** : parcours 1 ; US-1.1, US-2.1, US-3.1 ; RT-010, RT-012, RT-015.
- **Faisable** : oui.
- **Préconditions** : `npm run dev:recette:vide` (compte « WNEXT Vide », Alec owner seul, aucune personne ni projet) ; se connecter en Alec.
- **Étant donné** le Planning vide. **Quand** j'ajoute depuis l'écran Personnes Camille Roy (employée), puis Léo Martin (profil à pourvoir, sans e-mail), puis, depuis l'écran Projets, un client Acme créé à la volée et le projet « Refonte » (code REF-01, couleur du sélecteur), puis que je glisse sur la ligne de Camille du lundi au mercredi dans le Planning et choisis REF-01. **Alors** le bloc apparaît avec la capacité visible tout de suite.
- **Attendu** : moins de 5 minutes de bout en bout, sans SQL ni import, personne créée avec moins de 3 champs obligatoires. La grille encore sans bloc affiche une seule indication « Cliquez ou glissez dans la grille pour planifier » (RT-060) ; les listes vides de Personnes et de Projets proposent « Importer depuis un fichier CSV (Réglages > Import) » (RT-054).

### R-07 — Création d'une personne
- **Couvre** : US-1.1 ; RT-012.
- **Faisable** : oui.
- **Préconditions** : seed de recette, connecté en Alec, écran Personnes.
- **Quand** je clique « Nouvelle personne » et crée « Inès Dupont » (type Employé, horaires par défaut). **Alors** sa fiche s'ouvre dans un drawer (« Toujours : 40 h par semaine ») et elle apparaît dans la liste et dans le Planning (palette Ctrl+K).
- **Quand** je crée « À recruter », type « Profil à pourvoir », sans e-mail. **Alors** c'est accepté.
- **Quand** je saisis 25 h pour le samedi. **Alors** refus « Chaque jour : un nombre d’heures entre 0 et 24. ».
- **Quand** je désactive Inès (« Désactiver cette personne », confirmation). **Alors** elle quitte la liste « Actives » et le Planning ; filtre « État : Désactivées », sa fiche reste lisible avec l'historique de l'horaire.
- **Attendu** : désactiver « À recruter » et Inès en fin de scénario pour repartir du seed.

### R-08 — Création client et projet
- **Couvre** : US-2.1 ; RT-010, RT-012, RT-018.
- **Faisable** : oui.
- **Préconditions** : seed de recette (`REF-01` et `SITE-01` existent ; client Acme existant), écran Projets.
- **Quand** je clique « Nouveau projet », nomme « Portail client », choisis le client Acme et saisis le code `REF-01`. **Alors** refus « Ce code est déjà utilisé par un autre projet. ».
- **Quand** je corrige en `SITE-02` avec Fin avant Début. **Alors** refus « La fin ne peut pas précéder le début. ».
- **Quand** je saisis une couleur très claire (`#FFFFCC`) puis un format invalide (`#12`). **Alors** respectivement l'avertissement de contraste et « Format attendu : # suivi de six chiffres hexadécimaux. » ; je choisis une couleur du sélecteur, corrige les dates et crée. **Alors** la fiche du projet s'ouvre (code `SITE-02`) et la liste montre « Portail client » chez Acme.

### R-09 — Propriétés d'un projet et de son équipe
- **Couvre** : dossier §4.1 principe 1, ux-ui §3.4 ; RT-010, RT-018.
- **Faisable** : oui.
- **Préconditions** : seed de recette ; un second onglet sur le Planning (Camille Roy, lundi S+2, bloc « Refonte »). **Jouer R-11 avant** si R-08 a déjà renommé quelque chose : R-09 renomme `REF-01` puis le remet.
- **Quand** j'ouvre `REF-01` « Refonte » depuis la liste Projets. **Alors** un drawer montre ses propriétés (nom, code, client, dates, couleur, statut, tâches « Conception… ») et son équipe (Léo Martin…).
- **Quand** je renomme en « Refonte v2 », change la couleur et enregistre (« Modifications enregistrées. »). **Alors** le second onglet affiche le nouveau nom et la nouvelle couleur sur les blocs en moins de 1 s, sans recharger ; le Planning du premier onglet aussi.
- **Attendu** : remettre le nom « Refonte » en fin de scénario.

### R-10 — Poser une allocation par glisser sur une zone libre
- **Couvre** : US-3.1 ; RT-015, RT-016, RT-024.
- **Faisable** : oui.
- **Préconditions** : **Lucas Morel** libre toute la semaine S+2 et S+3 ; Léo Martin comme seconde personne.
- **Quand** je glisse sur la ligne de Lucas du lundi S+2 au mercredi S+2. **Alors** un bloc provisoire suit le geste, puis le drawer « Nouvelle allocation » s'ouvre avec Du / Au prérenseignés et Lucas coché.
- **Quand** je coche aussi Léo Martin (recherche de personne), choisis le projet Refonte (liste à saisie) et clique « Créer ». **Alors** « 2 allocations créées (groupe). Ctrl+Z annule. » ; un bloc « Refonte, … 8 h par jour » apparaît sur les deux lignes.
- **Attendu** : la touche N (grille focalisée) ouvre le même drawer (RT-060 : plus de bouton « + Allocation »). Annuler avec Ctrl+Z (« Ajout annulé. ») en fin de scénario.

### R-11 — Création au clavier (touche N)
- **Couvre** : US-3.1 ; RT-057, RT-060 (D1, ADR-002 §5 amendé : la barre de saisie rapide est retirée de l'écran).
- **Faisable** : oui.
- **Préconditions** : seed de recette.
- **Quand** je focalise un bloc de Camille Roy et appuie sur N. **Alors** le drawer « Nouvelle allocation » s'ouvre avec Camille cochée et Du = Au = le premier jour du bloc ; sur la grille (aucun bloc focalisé), N coche la première personne visible et met la date du jour.
- **Quand** je choisis Refonte, 6 h par jour, du lundi au mercredi, et clique « Créer ». **Alors** la création est annoncée, annulable par Ctrl+Z ; Échap sans créer rend le focus au bloc d'origine (ou à la grille).
- **Attendu** : N et C sont annoncés par la grille (aria-keyshortcuts) et listés dans l'aide des raccourcis (« ? »).

### R-12 — Éditer un bloc posé et changer son projet
- **Couvre** : dossier §4.1 principe 2, ux-ui §3.4 ; RT-011, RT-013, RT-014, RT-024 ; Q5.
- **Faisable** : oui.
- **Préconditions** : **Camille Roy** : bloc « Refonte » (tâche « Design UI », note « Valider les variantes avec Nadia avant jeudi. ») du lundi au mercredi S+2, 8 h par jour ; un second onglet sur la même semaine.
- **Quand** je clique le bloc une fois. **Alors** il est sélectionné (poignées) et rien ne s'ouvre. **Quand** je double-clique (ou Entrée). **Alors** le drawer « Modifier l’allocation » s'ouvre prérempli (personne, projet, tâche, dates, heures, note).
- **Quand** je choisis le projet « Site vitrine » (recherche par saisie) et enregistre. **Alors** « Allocation modifiée. Ctrl+Z annule. » ; le bloc change de projet et de couleur sans bouger de place ; le second onglet le voit en moins de 1 s.
- **Attendu** : annuler par Ctrl+Z en fin de scénario.

### R-13 — Une même fenêtre pour projet et congé
- **Couvre** : ux-ui §3.4 ; RT-017 ; parcours 3.
- **Faisable** : oui.
- **Préconditions** : **Camille Roy** libre lundi et mardi S+3.
- **Quand** je glisse sur ces deux jours dans la ligne de Camille. **Alors** le drawer « Nouvelle allocation » s'ouvre, onglet « Projet / tâche » actif par défaut, onglet « Congé » disponible.
- **Quand** je passe sur « Congé » (titre « Nouveau congé », personne et dates conservées) et choisis le type « Congés payés ». **Alors** un bloc de congé est posé (approuvé d'emblée, RT-022) et la capacité de Camille baisse de 16 h (infobulle de la jauge).
- **Attendu** : annuler par Ctrl+Z (« Pose du congé annulée. »).

### R-14 — Couleur du projet depuis le bloc
- **Couvre** : US-2.1 ; RT-018.
- **Faisable** : oui.
- **Préconditions** : bloc « Refonte » de Camille Roy, lundi S+2.
- **Quand** j'ouvre le bloc (double-clic), clique « Couleur du projet… », choisis une autre couleur et « Appliquer la couleur ». **Alors** « Couleur du projet Refonte changée : tous ses blocs suivent. » et tous les blocs de ce projet changent de couleur ; le sélecteur n'offre que des couleurs de contraste suffisant.
- **Attendu** : remettre la couleur d'origine (`#2563EB`) par l'écran Projets en fin de scénario.

### R-15 — Détecter un surbooking et le résoudre (north star)
- **Couvre** : parcours 2 ; US-3.1, US-4.1, US-3.5 ; BR-01.
- **Faisable** : oui pour la détection et le déplacement ; « Trouver quelqu'un de dispo » n'existe pas encore (hors lot courant).
- **Préconditions** : **Camille Roy** a 8 h `REF-01` et 5 h `SITE-01` le mardi S+2 ; **Léo Martin** est libre ce jour-là ; un second onglet ouvert.
- **Étant donné** ce mardi. **Alors** la case de capacité de Camille annonce « 13 h planifiées sur 8 h de capacité, surcharge de 5 h » avec un motif hachuré en plus de la couleur.
- **Quand** je focalise le bloc « Site vitrine, 5 h » et appuie sur Ctrl+↓ jusqu'à la ligne de Léo Martin, puis Entrée. **Alors** « Modification enregistrée. », l'alerte disparaît (8 h sur 8 h) et le second onglet le voit en moins de 1 s ; le bloc est chez Léo. (Glisser le bloc à la souris fait la même chose.)
- **Attendu** : résolution en moins de 10 s sans quitter la grille ; annuler par Ctrl+Z en fin de scénario.

### R-16 — Jeu chiffré de capacité
- **Couvre** : US-4.1, BR-38.
- **Faisable** : oui.
- **Préconditions** : **Karim Haddad** : 8 h ouvrées le jeudi S0, congé du matin (4 h déduites), 4 h allouées.
- **Étant donné** ce jeudi. **Alors** la case annonce « 4 h planifiées sur 4 h de capacité » (100 %).
- **Quand** j'ajoute 1 h sur `REF-01` ce jeudi (touche N sur un bloc de Karim, Karim coché, Du = Au = ce jeudi, 1 h par jour). **Alors** « 5 h planifiées sur 4 h de capacité, surcharge de 1 h », charge 125 %, hachuré.
- **Attendu** : le pourcentage vient du moteur, jamais de l'API ; annuler par Ctrl+Z.

### R-17 — Déplacer, étirer, dupliquer, supprimer, annuler
- **Couvre** : US-3.2 ; fonction existante.
- **Faisable** : oui (RT-047 corrigé : Suppr / Retour arrière, Ctrl+D, S, Alt+glisser, menu du bloc et actions du drawer).
- **Préconditions** : bloc « Refonte » de Camille Roy, lundi à mercredi S+2.
- **Quand** je déplace le bloc d'un jour (flèche droite, Entrée), l'étire d'un jour (Maj+flèche droite, Entrée) puis d'un jour à la poignée droite à la souris. **Alors** « Modification enregistrée. » à chaque geste ; Ctrl+Z annule dans l'ordre inverse (« Redimensionnement annulé. », « Déplacement annulé. »).
- **Quand** j'ouvre le menu du bloc (clic droit). **Alors** « Dupliquer », « Scinder… » et « Supprimer » y figurent, avec leur raccourci ; Suppr supprime le bloc focalisé ; Ctrl+Z annule la suppression ; la scission conserve projet, tâche et notes.
- **Attendu** : la découpe d'une occurrence de série n'est pas annulable (connu, annoncé : voir R-31).

### R-18 — Congé posé sur des allocations existantes (BR-04)
- **Couvre** : parcours 3 ; US-5.1, US-5.2, BR-04 ; RT-022.
- **Faisable** : oui. Il n'y a pas d'approbation : tout congé posé est approuvé d'emblée (RT-022, PO-01 retiré).
- **Préconditions** : **Antoine Mercier** : 3 allocations de 4 h, lundi (Refonte), mardi (Site vitrine), mercredi (Application mobile) S+3 ; le mercredi est le férié France du seed.
- **Quand** j'appuie sur C (grille focalisée), choisis Antoine, « Congés payés », du lundi au mercredi S+3 et enregistre. **Alors** le drawer « Ce congé recouvre des allocations de Antoine Mercier » liste les jours impactés (2 sur 3 : le mercredi férié est déjà à 0 h) avec « 4 h planifiées pour 0 h disponibles » ; aucune allocation n'est supprimée.
- **Quand** je clique « Garder tel quel ». **Alors** le congé est posé, « Antoine Mercier est en surcharge ces jours-là » et les cases sont en surcharge ; Ctrl+Z retire le congé.
- **Quand** je recommence et clique « Reprogrammer… » puis « Appliquer » (choix « Reporter »). **Alors** « Congé enregistré et allocations reprogrammées. Ctrl+Z annule le tout. » ; les allocations se décalent après le congé ; Ctrl+Z défait le tout.
- **Quand** je pose pour **Lucas Morel** un congé du mardi S+2 avec fin « Matin seulement ». **Alors** la capacité du jour passe de 8 h à 4 h (50 %).
- **Attendu** : le temps loggé est inchangé. Le seed contient aussi un congé « en attente » (Chloé Bernard, S+1) affiché hachuré, hérité du modèle : il ne peut plus être créé par l'interface.

### R-19 — Fériés par pays
- **Couvre** : US-5.3.
- **Faisable** : oui.
- **Préconditions** : seed de recette : férié « Férié de recette (France) » le mercredi S+3 ; Camille Roy rattachée à FR, Sam Carter à US.
- **Alors** ce mercredi, la case de Camille annonce « aucune capacité » (0 h) et celle de Sam Carter « 8 h de capacité ».
- **Quand** j'ouvre Réglages > « Jours fériés ». **Alors** la liste montre « Férié de recette (France) », pays FR, à cette date.

### R-20 — Retirer une personne d'un projet (BR-10)
- **Couvre** : parcours 4 ; US-2.2, BR-10.
- **Faisable** : oui, par le menu du bloc dans le Planning.
- **Préconditions** : **Léo Martin** : 12 allocations `REF-01` (S-4 à S-1) et 34 h loggées (6 temps saisis). Se placer sur S-2.
- **Quand** je fais un clic droit sur un bloc « Refonte » de Léo et choisis « Retirer Léo Martin du projet Refonte… ». **Alors** le dialogue « Retirer Léo Martin du projet Refonte ? » annonce « 12 allocations supprimées (du … au …) » et « 6 temps saisis supprimés (34 h) » ; « Suppression définitive : elle ne s’annule pas avec Ctrl+Z. » ; rien n'est supprimé avant confirmation (« Annuler » ne change rien).
- **Quand** je confirme (« Retirer du projet »). **Alors** « Léo Martin n’est plus sur le projet Refonte : 12 allocations et 6 temps saisis supprimés. » ; ses autres allocations restent.
- **Attendu** : le retrait est aussi possible depuis la fiche projet (équipe). Ce scénario est destructif pour le seed : `--reset` avant de le rejouer.

### R-21 — Import CSV de personnes, projets, clients
- **Couvre** : parcours 6 ; US-1.2.
- **Faisable** : oui (rôle owner ou admin ; Réglages > Import, seule entrée depuis RT-054). Non automatisé : c'est le seul scénario à fichier volumineux.
- **Préconditions** : un CSV de 300 personnes (colonnes nom, e-mail, type, département) avec 3 lignes invalides ; **à jouer en dernier**, il ajoute 300 personnes au seed.
- **Quand** je l'importe en simulation puis pour de bon (Réglages > Import → « Importer un fichier CSV… »). **Alors** la prévisualisation sépare lignes valides et erreurs ligne par ligne, 300 lignes sont traitées en moins de 30 s.
- **Quand** je réimporte le même fichier. **Alors** aucun doublon (clé e-mail ou code projet).

### R-22 — Recherche, filtres, vues sauvegardées
- **Couvre** : US-7.1, US-7.2 ; RT-025, RT-038, RT-058, RT-059, RT-061 ; densité dans les vues (Q2).
- **Faisable** : oui.
- **Préconditions** : seed de recette (4 départements ; 17 personnes actives).
- **Quand** j'ouvre « Filtres », choisis le département Design et le projet Refonte. **Alors** le bouton devient « Filtres (2) », des puces retirables apparaissent et le compteur du coin de la grille (au-dessus des noms) passe de « 17 personnes » à 2 ou 3 (Camille, Lucas, Léo) en moins de 150 ms ; Thomas Girard n'y est plus.
- **Quand** je tape Ctrl+K puis « Cam » et Entrée. **Alors** la ligne de Camille Roy est mise en évidence dans la vue filtrée.
- **Quand** je passe en « Semaine » et clique « Enregistrer la vue… » (pied du panneau Filtres) sous le nom « Design REF », puis rouvre l'adresse `?view=…`. **Alors** filtres et zoom sont restitués et le bouton affiche « Filtres (2) · Design REF » ; un filtre changé ajoute « ● ».
- **Quand** je tape Ctrl+K depuis l'écran Projets et choisis Camille Roy. **Alors** le Planning s'ouvre sur sa ligne, mise en évidence (recherche globale, bouton dans l'en-tête commun).
- **Attendu** : supprimer la vue en fin de scénario.

### R-23 — Notifications in-app
- **Couvre** : US-7.3, US-3.5.
- **Faisable** : oui.
- **Préconditions** : deux sessions, Alec et Camille Roy (member) ; la cloche de Camille part vide (seed).
- **Quand** Alec modifie, dans le drawer, le pourcentage du bloc « Refonte » 25 % de Camille (lundi S+4 au vendredi S+4). **Alors** la cloche de Camille affiche « 1 » en moins de 1 s ; la liste s'ouvre en fenêtre (« Alec a modifié vos allocations », « 1 allocation modifiée ») ; « Tout marquer comme lu » remet le compteur à 0.
- **Quand** Camille décoche « les changements de mes allocations » et qu'Alec modifie de nouveau. **Alors** aucune notification n'arrive.
- **Attendu** : rétablir la préférence et annuler les modifications (Ctrl+Z) en fin de scénario.

### R-24 — Rôles et isolation
- **Couvre** : US-6.1, BR-33.
- **Faisable** : oui (RT-048 corrigé : le Member ne voit que sa personne liée).
- **Préconditions** : comptes de l'IdP local : Camille Roy (member), Invité Recette (guest), Nadia Benali (project_manager : gère `REF-01`, co-gère `SITE-01`), Admin Autre Société (second compte).
- **Alors** le Member n'a aucune écriture (N et C n'ouvrent rien ; ni Réglages ni Import), l'API refuse ses écritures (403) et il ne voit que ses assignations, API et temps réel (une autre personne : 404). Le Guest n'a aucune écriture. Nadia écrit sur `REF-01` et `SITE-01`, refusée (403, `FORBIDDEN`) sur `MOB-01`. Le second compte ne voit que « Agathe Collin », « Bruno Nguyen » et le projet `SEC-01`, jamais une donnée du premier (404 sur ses ids).

### R-25 — Conflit d'édition concurrent
- **Couvre** : US-3.5.
- **Faisable** : oui (deux onglets).
- **Préconditions** : bloc « Identité de marque » de Camille Roy, 50 %, jeudi-vendredi S+3 (S0 + 24..25) ; deux onglets Alec, le second sans temps réel pour ne pas se synchroniser.
- **Quand** j'ouvre le même bloc dans les deux onglets, enregistre 60 % dans le premier, puis 55 % dans le second. **Alors** aucune perte silencieuse : le second signale « Quelqu’un d’autre a modifié cette donnée entre-temps : la dernière version est affichée, refaites votre changement. » et affiche la valeur 60 %.
- **Attendu** : annuler par Ctrl+Z dans le premier onglet.

### R-26 — Palette de recherche Ctrl+K
- **Couvre** : RT-038, PO-09 ; `docs/02-design/design.md` (recherche).
- **Faisable** : oui.
- **Préconditions** : seed de recette, Planning, filtre « Département : Produit » actif (Camille Roy, du département Design, est masquée).
- **Quand** j'appuie sur Ctrl+K (⌘K sur Mac) et tape « camille ». **Alors** l'option « Camille Roy masquée par les filtres » est proposée ; Entrée affiche une confirmation (« Retirer les filtres et afficher Camille Roy », focalisée) ; je la valide. **Alors** les filtres sont retirés, la palette se ferme, la ligne de Camille est mise en évidence ; un bouton « Rétablir les filtres » ramène « Filtres (1) » et disparaît.
- **Quand** je rouvre Ctrl+K et tape « refonte ». **Alors** le groupe « Projets » propose Refonte ; Entrée ouvre l'écran Projets avec la fiche de « Refonte » en drawer (l'adresse n'en garde pas le paramètre).

### R-27 — Réglages > Compte : début de semaine
- **Couvre** : RT-041, PO-05 ; ADR-001 (`week_start`).
- **Faisable** : oui (owner ou admin).
- **Préconditions** : connecté en Alec ; Planning en zoom « Semaine » (les colonnes commencent un lundi).
- **Quand** j'ouvre Réglages > « Compte » (fuseau « Europe/Paris »), choisis « Début de semaine : dimanche » et « Enregistrer ». **Alors** « Réglages du compte enregistrés. » ; de retour au Planning, la semaine commence un dimanche.
- **Attendu** : remettre « lundi » en fin de scénario.

### R-28 — Colonne Accès de l'écran Personnes
- **Couvre** : RT-040, PO-04 ; ADR-002 §1.
- **Faisable** : oui.
- **Préconditions** : seed de recette ; comptes Alec, Nadia Benali (project_manager), Camille Roy (member).
- **Alors** en Alec, l'écran Personnes a une colonne « Accès » : Camille Roy et Nadia Benali « A un accès », Léo Martin « Sans accès ». Nadia voit la même colonne. Camille voit la liste sans cette colonne.

### R-29 — Co-gestion de projet (Nadia et SITE-01)
- **Couvre** : RT-039, PO-06 ; BR-33.
- **Faisable** : oui.
- **Préconditions** : Nadia Benali (project_manager) gère `REF-01` et co-gère `SITE-01`.
- **Quand** je me connecte en Nadia et ouvre le drawer de création (touche N), liste « Projet ». **Alors** seuls « Refonte » et « Site vitrine » sont proposés (pas « Application mobile »). En Alec, tous les projets (7) sont proposés.
- **Attendu** : l'API est juge : écriture acceptée par Nadia sur `SITE-01`, refusée (403) sur `MOB-01`.

### R-30 — Appui long tactile sur une case vide
- **Couvre** : RT-043, PO-07.
- **Faisable** : oui, avec un écran tactile ou l'émulation tactile des outils de développement du navigateur.
- **Préconditions** : seed de recette, Planning.
- **Quand** je tape brièvement sur une case libre. **Alors** rien ne se crée. **Quand** je balaie la grille au doigt. **Alors** elle défile sans rien créer.
- **Quand** j'appuie longuement (≈ 0,5 s) sur une case libre puis glisse d'un jour. **Alors** un bloc provisoire de deux jours apparaît, la grille ne défile pas, et au relâchement le drawer « Nouvelle allocation » s'ouvre sur cette plage avec la personne de la ligne cochée.

### R-31 — Portée d'une série dans le drawer
- **Couvre** : RT-042, PO-08.
- **Faisable** : oui.
- **Préconditions** : série « Point hebdo Refonte » de Nadia Benali (Refonte, 2 h, chaque lundi, de S0 à S+11) ; se placer sur le lundi S+1.
- **Quand** j'ouvre l'occurrence du lundi S+1 (« Série répétée » dans le drawer), passe à 3 h et clique « Enregistrer ». **Alors** une étape de choix s'affiche. **Quand** je choisis « Cette occurrence » puis « Confirmer ». **Alors** « La découpe d’une occurrence ne peut pas être annulée. » ; seule cette occurrence passe à 3 h, celle du lundi S+2 reste à 2 h.
- **Quand** j'ouvre l'occurrence du lundi S+2, passe à 4 h, choisis « Toute la série » puis « Confirmer ». **Alors** les occurrences suivantes passent à 4 h ; Ctrl+Z remet 2 h.
- **Attendu** : la scission de l'occurrence n'est pas annulable (annoncé). Ce scénario laisse le seed modifié : `--reset` avant de le rejouer.

### R-32 — Portée d'un groupe dans le drawer
- **Couvre** : RT-042, PO-08, BR-26.
- **Faisable** : oui.
- **Préconditions** : groupe « Atelier de lancement » (Application mobile, 6 h par jour, jeudi-vendredi S+2 : Thomas Girard, Nadia Benali, Yasmine Cherif). La charge et la personne sont propres à chaque ligne : la portée ne se pose que pour un champ commun au groupe, ici le statut.
- **Quand** j'ouvre la ligne de Thomas Girard, passe le statut à « tentative » et enregistre. **Alors** une étape de choix s'affiche. **Quand** je choisis « Cette ligne » puis « Confirmer ». **Alors** seule la ligne de Thomas devient « tentatif » ; celle de Yasmine reste confirmée.
- **Quand** j'ouvre la ligne de Yasmine, passe le statut à « tentative », choisis « Tout le groupe » puis « Confirmer ». **Alors** les trois lignes sont tentatives ; un Ctrl+Z annule d'un coup.
- **Attendu** : annuler aussi le changement de Thomas (Ctrl+Z) en fin de scénario.

### R-33 — Manipuler un congé comme un bloc
- **Couvre** : RT-051 (décision D4 : le congé reste un objet distinct et reçoit les gestes des blocs), BR-04, BR-40.
- **Faisable** : oui.
- **Préconditions** : seed de recette, Planning en vue jour ; **Lucas Morel** est libre les semaines S+2 et S+3. Poser pour lui un congé « Congés payés » le mardi S+2 (touche C).
- **Quand** je clique sur le congé. **Alors** il est sélectionné (contour, poignées de début et de fin, pas de poignée de hauteur) ; un double clic ou Entrée ouvre le drawer « Modifier le congé ».
- **Quand** je le glisse d'une demi-journée vers la droite. **Alors** « Congé déplacé. » ; il couvre du mardi après-midi au mercredi matin (libellé et demi-cellules) ; Ctrl+Z le remet en place.
- **Quand** je le focalise et appuie sur Maj + → deux fois puis Entrée. **Alors** il s'allonge d'une journée (« Congé modifié. ») ; Alt + ← allonge par le début ; en vue semaine, le pas est la journée.
- **Quand** je le glisse sur un jour où Lucas a une allocation (en poser une d'abord). **Alors** le drawer « Ce congé recouvre des allocations de Lucas Morel » s'ouvre ; rien n'est écrit avant le choix ; « Garder tel quel » ou « Reprogrammer… » comme en R-18 ; fermer le drawer laisse le congé à sa place.
- **Quand** je le glisse sur un autre congé de Lucas. **Alors** « Ce congé chevauche un autre congé de cette personne : changez les dates. », rien n'est écrit.
- **Quand** j'appuie sur Suppr (ou clic droit puis « Supprimer », ou Maj+F10). **Alors** « Congé supprimé. » ; Ctrl+Z le rend.
- **Attendu** : au toucher, un tap sélectionne le congé et un appui long arme son déplacement (comme R-30 pour un bloc). L'aide des raccourcis (« ? ») a un groupe « Congé sélectionné ». Retirer le congé de Lucas en fin de scénario.

## Suivi

La colonne « Pré-recette auto » vient de `npm run test:recette` (`tests/browser/recette.spec.ts`, dernier passage le 2026-10-22 sur `main` : 30 tests verts ; R-06 et R-21 non automatisés) ; elle ne remplace pas votre passage : la colonne « Statut » reste à vous.

| Id | Titre | Faisable aujourd'hui | Pré-recette auto | Statut |
|---|---|---|---|---|
| R-01 | Accès protégé par une connexion | oui | OK | — |
| R-02 | En-tête applicatif et utilisateur connecté | oui | OK | — |
| R-03 | Densité d'affichage à 3 niveaux | oui | OK (RT-050 corrigé) | — |
| R-04 | Jauge d'allocation par personne | oui | OK | — |
| R-05 | Formulaires en fenêtre superposée | oui | OK (RT-049 corrigé) | — |
| R-06 | Première allocation depuis un compte vide | oui (compte vide) | non automatisé | — |
| R-07 | Création d'une personne | oui | OK | — |
| R-08 | Création client et projet | oui | OK | — |
| R-09 | Propriétés d'un projet et équipe | oui | OK | — |
| R-10 | Poser une allocation par glisser | oui | OK | — |
| R-11 | Saisie rapide | oui | OK | — |
| R-12 | Éditer un bloc, changer de projet | oui | OK | — |
| R-13 | Fenêtre unique projet et congé | oui | OK | — |
| R-14 | Couleur du projet depuis le bloc | oui | OK | — |
| R-15 | Surbooking détecté et résolu | oui (sans « Trouver quelqu'un ») | OK | — |
| R-16 | Jeu chiffré de capacité | oui | OK | — |
| R-17 | Déplacer, étirer, dupliquer, supprimer, annuler | oui | OK (RT-047 corrigé) | — |
| R-18 | Congé sur allocations (BR-04) | oui | OK | — |
| R-19 | Fériés par pays | oui | OK | — |
| R-20 | Retrait d'équipe (BR-10) | oui | OK | — |
| R-21 | Import CSV | oui | non automatisé | — |
| R-22 | Recherche, filtres, vues | oui | OK | — |
| R-23 | Notifications in-app | oui | OK | — |
| R-24 | Rôles et isolation | oui | OK (RT-048 corrigé) | — |
| R-25 | Conflit d'édition concurrent | oui | OK | — |
| R-26 | Palette de recherche Ctrl+K | oui | OK | — |
| R-27 | Réglages > Compte : début de semaine | oui | OK | — |
| R-28 | Colonne Accès (Personnes) | oui | OK | — |
| R-29 | Co-gestion de projet | oui | OK | — |
| R-30 | Appui long tactile | oui | OK | — |
| R-31 | Portée d'une série | oui | OK | — |
| R-32 | Portée d'un groupe | oui | OK | — |
| R-33 | Manipuler un congé comme un bloc | oui | non automatisé (spec navigateur `timeoffs.spec.ts` sur la démo) | — |

Ces statuts de pré-recette seront mis à jour après le dernier passage.
