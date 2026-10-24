# Revue UX/UI senior — Float clone

Légende : **[BLOQUANT]** à trancher avant le prototype Schedule · **[IMPORTANT]** MVP (P0) · **[CONFORT]** P1+.
Sources : dossier §4, §3.3, §5.3 ; `schema.sql.txt` (allocations, timeoffs, holidays, people).

---

## 1. Revue des 8 principes et des parcours

| # | Principe | Verdict | Remarque / correctif |
|---|---|---|---|
| 1 | Surface unique (Schedule) | OK | **[IMPORTANT]** « 5 onglets » : prévoir aussi Settings/Account hors nav principale et un panneau projet latéral (pas un 6e onglet). |
| 2 | Tout en drag-and-drop, sans modal | À nuancer | **[BLOQUANT]** Le DnD seul exclut clavier/tactile/lecteurs d'écran (WCAG 2.1.1, 2.5.7). Chaque geste DnD doit avoir une alternative : popover avec champs dates/heures + commandes clavier (§2.9). |
| 3 | Temps réel, <100 ms local | OK | **[IMPORTANT]** Définir le comportement de conflit (deux clients modifient le même bloc) : « last write wins » + toast « X a modifié ce bloc » et présence/curseurs en V1.x. |
| 4 | Info en un coup d'œil | Risque | **[IMPORTANT]** Cumul de signaux (couleur projet + tentatif + barre de capacité + congés + surbooking) : définir une hiérarchie stricte (§2.5) et un nombre de canaux visuels max par cellule. Le rouge de capacité ne doit jamais être une couleur projet (générer la palette projet hors teintes sémantiques). |
| 5 | Zéro friction de saisie | OK | **[CONFORT]** Raccourcis : afficher une aide `?` et un palette de commandes `Ctrl/Cmd+K`. Vues sauvegardées absentes du schéma (voir §6). |
| 6 | Progressivité | OK | **[IMPORTANT]** Concrétiser : mode « Compact/Simple » (ligne 32 px, un seul champ heures/jour, % et répétition masqués) + onboarding qui pose la 1re allocation en <5 min (KPI §5.4). |
| 7 | Mobile = lecture + 3 actions | OK | Voir §4.1. Ajouter « jamais de popup sans fermer » comme règle de lint du design system. |
| 8 | Confiance par annulabilité | OK | **[BLOQUANT]** Préciser la portée de l'undo : pile d'actions locale par session (≥20), avec les actions serveur inversibles (déplacer/redimensionner/créer/supprimer). Les suppressions en cascade (BR-10) ne sont pas annulables par simple Ctrl+Z : confirmation explicite obligatoire. |

**Parcours §4.2** (projet → allocation → conflit → ajustement → timesheet → rapport) : cohérent. Manques :
- **[IMPORTANT]** L'étape « Créer un projet + budget » est lourde (5 types de budget) : limiter le flux de création à nom, client, couleur, dates, tentatif/confirmé ; budget différé (progressivité).
- **[IMPORTANT]** « Voir conflit » → « basculer sur un profil dispo » : il faut un point d'entrée visible depuis l'alerte (bouton « Trouver quelqu'un de dispo » filtrant par rôle/tags/dispo ; préfigure Smart Assign FR-17).
- **[IMPORTANT]** Parcours absents : demande/approbation de congé (BR-04 avec report assisté), onboarding/import (KPI time-to-value <1 j), déverrouillage de timesheet (BR-12), suppression de personne de projet (BR-10).
- North star « <10 s, sans surbooker » : à instrumenter (temps entre ouverture du Schedule et allocation posée).

Observations liées au modèle (impact UX) :
- Une allocation = **une seule personne** (`person_id`) sur une plage `start_date..end_date`. Une « allocation multi-personnes » (FR-03) est donc N lignes : l'UI doit les grouper visuellement (ou les lier) et proposer « modifier toutes / seulement celle-ci ». **[IMPORTANT]**
- Une allocation couvre une plage avec la même charge/jour : un bloc est un rectangle continu. Le fractionnement par week-end/férié/congé doit être rendu côté client (le bloc « saute » les jours non ouvrés) sans multiplier les lignes. **[IMPORTANT]**
- `percent` : en mode %, les heures affichées dépendent de la capacité de la personne ; afficher « 50 % (4 h) ».

---

## 2. Spec — écran Schedule

### 2.1 Structure
- Barre haute : sélecteur de vue sauvegardée, recherche, filtres, zoom (Jour/Semaine/Mois), « Aujourd'hui », navigation ‹ ›, bouton `+ Allocation`, toggle densité, présence.
- Colonne gauche (sticky, 240 px, redimensionnable) : groupes (département/rôle/projet selon regroupement) repliables → ligne personne : avatar, nom, rôle, **jauge de capacité** (barre 4 px sous le nom) + % de charge de la période visible. Placeholders avec icône distincte (hors couleur).
- Grille (scroll H+V, en-têtes sticky) : colonnes = jours (ou semaines/mois selon zoom), lignes = personnes.
- Ligne de synthèse optionnelle en pied/haut (« Total équipe : heures vs capacité par jour »).
- Panneau projet latéral (budget, équipe, phases), ouvert sur clic du nom de projet, sans quitter le Schedule. **[CONFORT]**

### 2.2 Dimensions & densité
- Ligne personne : ~~40 px par défaut (cf. dossier), « compact » 32 px, « confortable » 48 px~~. *Amendé le 2026-10-21 (recette P6, RT-005 à RT-007, cadrage n°1 Q1 : hauteurs fixes, pas d'ajustement à la fenêtre) : trois densités, ligne sans empilement = blocs à 100 % de la journée + bande de capacité : **Compacte** 62 px (48 + 14), **Standard** 92 px (72 + 20, défaut), **Aérée** 120 px (96 + 24), soit 12 / 8 / 6 personnes entières sur l'écran de référence 1920 × 1080 (zone de lignes mesurée à 787 px). En Aérée, avatar, textes (échelle des tokens), jauge et blocs grossissent aussi. Contrôle segmenté dans la barre d'outils, mémorisé dans le navigateur et porté par les vues sauvegardées (`filters.density`). Code : `apps/web/src/schedule/density.ts`.* Ligne s'agrandit en hauteur si blocs empilés (chevauchement de plusieurs projets le même jour : empilement vertical, hauteur de bloc ∝ heures/capacité du jour en vue Jour, fixe en vues Semaine/Mois).
- Colonne jour : 64 px (Jour), 120 px/semaine (Semaine, 5 sous-colonnes de 24 px), mois = agrégat en barres de charge. Largeur min. d'un bloc cliquable : 24 px.
- Week-ends et jours non ouvrés (`work_days_hours` = 0) : fond hachuré léger, non cibles de drop (BR-01).

### 2.3 Blocs d'allocation (rendu)
- Rectangle arrondi (r=6), fond = couleur projet (teinte pleine, texte à contraste AA calculé), contenu : **code projet/nom**, initiales ou nom de personne selon regroupement, **heures/jour** (chiffres tabulaires). Texte tronqué avec tooltip.
- **Tentatif** (`status='tentative'`) : fond transparent à 25 % + bordure pointillée 1.5 px + hachures diagonales + icône « ? » : trois canaux dont deux non chromatiques (WCAG 1.4.1). **[IMPORTANT]**
- **Confirmé** : fond plein, bordure none.
- Non facturable (`billable=false`) : liseré gauche différent (pas de teinte) **[CONFORT]**.
- Répété (`repeat_state ≠ none`) : icône ↻ ; hover affiche la série. **[CONFORT]**
- Allocation en % : badge « % ».
- Sélection : anneau 2 px accent + poignées ; focus clavier : anneau 2 px + offset 2 px (distinct de la sélection par forme).
- Débordement de plage visible (début/fin hors fenêtre) : bord coupé en zigzag/chevron.

### 2.4 Création, déplacement, redimensionnement (DnD)
| Geste | Comportement | Prio |
|---|---|---|
| Cliquer-glisser sur cellule vide | Crée un bloc sur la plage ; au relâchement, popover (projet, heures/jour ou %, tentatif/confirmé, nom). Projet par défaut = dernier utilisé. | **[BLOQUANT]** |
| Glisser un bloc | Déplace (dates et/ou personne) ; **ghost** à la position cible + infobulle « Lun 12 → Mer 14, Alice » ; snap au jour ; saute les jours non ouvrés. Drop interdit hors lignes valides. | **[BLOQUANT]** |
| Poignées gauche/droite | Resize début/fin, snap au jour (1 jour minimum). Poignée verticale pour heures/jour **[CONFORT]**. | **[BLOQUANT]** |
| `Alt`/`Ctrl` + glisser | Duplique (curseur « copy »). | **[IMPORTANT]** |
| Split | Raccourci `S` ou menu : coupe au jour sous le curseur/sélectionné. | **[IMPORTANT]** |
| Sélection multiple | `Shift`+clic, rectangle de sélection ; déplacement groupé. | **[CONFORT]** |
| Auto-scroll | Pendant un drag, bord de grille ⇒ scroll horizontal/vertical accéléré. | **[IMPORTANT]** |
| Échap pendant drag | Annule sans effet. | **[IMPORTANT]** |

Règle BR-01 : **jamais de blocage** sur dépassement de capacité ; la cible affiche l'état résultant (voir 2.5) pendant le drag (prévisualisation « Bob passera à 120 % »).

### 2.5 États de capacité (par personne × jour)
Barre de charge par cellule/colonne (fine, en bas de cellule) + jauge récapitulative sur la ligne. Seuils (paramétrables compte) :
| État | Règle (charge = Σ alloc / dispo) | Visuel | Non-chromatique |
|---|---|---|---|
| Sous-allocation | < 80 % | gris/bleu neutre (pas vert criard) | libellé « 4 h libres » au survol |
| OK | 80–100 % | vert | coche discrète en tooltip |
| Limite | = 100 % exact | vert plein | — |
| Sur-allocation | > 100 % | rouge `#D32F2F` + trait supérieur hachuré + icône ▲ | « +2 h » affiché |
| Dispo = 0 (congé plein/férié) | n/a | cellule grisée + motif | libellé congé |
Note : le dossier §4.1 parle de vert/orange/rouge ; définir clairement orange = 90–100 % (limite) vs rouge > 100 %. **[IMPORTANT]** (à valider PM, cf. §6). *Orange 90–100 % non retenu : seuils décidés le 2026-10-18 (sous < 80 %, paramétrable par compte ; sur > 100 %, fixe).*
- Le surbooking est « non intrusif mais identifiable » : pas de modal ni de bandeau, uniquement bordure/hachures + compteur dans l'en-tête de ligne ; clic sur l'icône ⇒ liste des allocations en conflit + actions (« Déplacer », « Réduire », « Trouver quelqu'un »).
- Heures de la personne : calcul via `daily_capacity()` serveur ; le client ne recalcule que l'optimiste (delta local), réconcilié par le push serveur.

### 2.6 Congés et jours fériés
- Congé (`timeoffs`) : bloc plein-hauteur de ligne, fond neutre + motif (rayures) + icône par type ; libellé « Vacances ». Demi-journée/partiel (`scope='partial'`) : hauteur ∝ heures. **[IMPORTANT]**
- En attente (`pending`) : bordure pointillée + « ⏳ » ; refusé : masqué (visible dans l'historique) ; approuvé : plein. `deducted=false` : indiquer « non déduit ». **[IMPORTANT]**
- Jour férié : colonne entière teintée (équipe/pays) avec nom au survol de l'en-tête ; ne s'applique qu'aux personnes concernées (le dossier le fait par pays — voir schéma `people.country` manquant, §6).
- **BR-04** : ajouter un congé plein-jour sur des allocations existantes ⇒ dialogue unique : « 3 allocations impactées (liste) → [Reporter automatiquement au prochain jour dispo] [Réduire] [Garder (sur-allocation)] [Annuler] ». Jamais de suppression silencieuse. **[BLOQUANT]**

### 2.7 Zoom jour/semaine/mois
- **Jour** : 1–3 semaines visibles, heures par jour sur le bloc, resize au jour.
- **Semaine** : 6–12 semaines, une colonne/semaine avec 5 sous-colonnes ; bloc = barre continue ; heures/jour sur survol.
- **Mois** : 12 mois ; le bloc devient barre d'agrégat (charge moyenne), édition limitée au déplacement/resize par semaine. Modification fine ⇒ zoom auto vers Semaine au double-clic.
- Zoom : `Ctrl+molette`, boutons +/−, raccourcis `1/2/3`. Conserver la date centrale au changement de zoom. Snap aux semaines au scroll (§4.3). **[IMPORTANT]**
- Perf : rendu virtualisé (lignes + colonnes), blocs rendus par plage (une ligne SQL = un bloc, pas de découpage par jour).

### 2.8 Filtres, recherche, regroupement, vues sauvegardées
- Recherche instantanée (<100 ms) : personnes, projets, clients, tags ; `/` pour focus.
- Filtres combinables (ET entre catégories, OU au sein d'une catégorie) : département, rôle, tag, type de personne, projet, client, statut tentatif/confirmé, état de capacité (« surbookés seulement »). Chips supprimables + compteur. **[IMPORTANT]**
- Regroupement : département / rôle / projet / aucun ; tri : nom, charge, rôle.
- **Vues sauvegardées** : filtres + regroupement + zoom + densité + fenêtre temporelle relative (« 4 semaines à partir d'aujourd'hui »). Personnelles ou partagées (Admin). Pas de table dans le schéma → à ajouter. **[IMPORTANT]**
- État dans l'URL (deep-link, partage). **[IMPORTANT]**

### 2.9 Raccourcis clavier (proposition)
| Touche | Action |
|---|---|
| Flèches | Déplacer le focus de cellule/bloc |
| `Entrée` | Ouvrir popover du bloc/cellule focus |
| `Alt+Flèches` | Déplacer le bloc d'un jour / d'une ligne (équivalent DnD) **[BLOQUANT]** |
| `Shift+Flèches` | Étendre/rétrécir (resize) |
| `N` | Nouvelle allocation sur cellule focus |
| `Ctrl/Cmd+C / V` | Copier / coller allocation |
| `Ctrl/Cmd+D` | Dupliquer |
| `S` | Split |
| `Suppr` | Supprimer (toast Annuler) |
| `Ctrl/Cmd+Z / Shift+Z` | Undo / redo |
| `T` | Aujourd'hui |
| `1 / 2 / 3` | Zoom Jour / Semaine / Mois |
| `[` `]` | Période précédente/suivante |
| `/`, `Ctrl+K`, `?` | Recherche, palette commandes, aide |
| `Échap` | Fermer popover / annuler drag / désélectionner |

### 2.10 Optimistic UI & temps réel
- Toute mutation s'applique localement immédiatement (<100 ms), avec ID temporaire ; indicateur discret « synchronisé / en cours » (icône nuage) en barre haute. **[BLOQUANT]**
- Échec serveur : rollback animé du bloc + toast erreur avec « Réessayer » ; si 409/conflit, afficher la version serveur. Hors ligne : file d'attente de mutations avec bannière « Hors ligne – X modifications en attente ». **[IMPORTANT]**
- Push temps réel <1 s (§3.3) : bloc modifié par autrui s'anime brièvement (pulse 600 ms) ; si l'utilisateur est en train de glisser ce même bloc, ne pas le remplacer ; notification « mis à jour ».
- Le bloc « atterrit » : transition 120–160 ms ease-out (léger rebond ≤ 4 px) ; désactivée avec `prefers-reduced-motion`.
- Séquencement : requêtes par bloc ordonnées (dernière écriture gagne côté client pour un même bloc).
- Lectures bornées par fenêtre visible + marge (préchargement ±2 pages) ; skeletons pour les lignes non chargées.

---

### 2.11 Amendements ADR-002 (exigences utilisateur)
- **Hauteur de bloc = part de la capacité du jour** (6 h / 8 h = 75 %) ; largeur = durée, y compris un bloc d'une seule journée. Plusieurs blocs d'une personne s'empilent ; la somme > 100 % de la hauteur de ligne matérialise la sur-allocation (▲, BR-01).
- **Gestes** : déplacer, étirer/réduire à gauche et à droite (dates), poignée haut/bas (heures ou %), dupliquer (Alt + glisser), couper. Équivalent clavier pour chacun.
- **Saisie rapide** : barre de saisie en langage simple (« Refonte 6h lun-mer ») avec aperçu du bloc en direct ; création par glisser sur cellules vides sans dialogue ; édition sur place des valeurs.
- **Zoom** jour/semaine/mois : contrôle segmenté permanent, point central conservé. **Navigation** : défilement horizontal continu passé et futur, bouton « Aujourd'hui » (`T`), aller à une date.
- **i18n** : textes qui s'allongent sans casser les blocs, propriétés CSS logiques, durées décimales au séparateur local.
- Détail et justification : `docs/06-decisions/ADR-002-identite-zoom-navigation-i18n-fluidite.md`.

## 3. Design tokens & design system

### 3.1 Couleurs (valeurs proposées, à valider par contrôle de contraste)
Tokens sémantiques (jamais de couleur en dur dans les composants) :

| Token | Clair | Sombre | Usage |
|---|---|---|---|
| `--bg` | `#FAFAF8` | `#121314` | fond app |
| `--surface` | `#FFFFFF` | `#1B1D1F` | cartes, popovers |
| `--surface-sunken` | `#F1F2EF` | `#16181A` | grille, zones non ouvrées |
| `--border` | `#E3E5E0` | `#2C2F33` | séparateurs |
| `--text` | `#1F2328` | `#E8EAED` | texte (≥ 12:1) |
| `--text-muted` | `#5B6168` | `#A3A9B0` | secondaire (≥ 4.5:1) |
| `--accent` | `#16A34A`* | `#4ADE80` | action primaire (*accent vif de marque) |
| `--accent-fg` | `#06220F` | `#06220F` | texte sur accent (le blanc sur vert vif échoue AA) |
| `--cap-under` | `#6B7C93` | `#8FA3BD` | sous-allocation |
| `--cap-ok` | `#1E8E3E` | `#4CC38A` | OK |
| `--cap-warn` | `#B45309` | `#F5A524` | limite |
| `--cap-over` | `#C62828` | `#FF6B6B` | sur-allocation |
| `--timeoff` | `#D8DADF` + motif | `#34383E` + motif | congé |
| `--focus` | `#1D4ED8` | `#8AB4FF` | anneau focus 2 px |

- Accent : le vert fluo type Float a un contraste faible sur blanc ; choisir un accent saturé mais utilisable en texte/bouton (≥ 4.5:1) ; il ne doit pas entrer en collision avec `--cap-ok`. **[IMPORTANT]** (décision marque, §6).
- **Palette projet** (`projects.color`, CHAR(7)) : ~16 teintes pré-générées en OKLCH (L≈0.62, C≈0.12, hue espacées de 22,5°), en excluant la zone rouge ≈ `--cap-over`. Le texte du bloc (blanc/anthracite) est calculé automatiquement pour ≥ 4.5:1 ; si la couleur choisie par l'utilisateur échoue, le bloc est assombri/éclairci en rendu (la valeur stockée reste inchangée). Couleur libre autorisée avec avertissement. **[BLOQUANT]** (le schéma accepte tout hex ; la règle de contraste est d'UI).
- Dark mode : pas d'inversion mécanique ; réduire la saturation de 10–15 % et recalculer le texte sur blocs ; suivre `prefers-color-scheme` + bascule manuelle ; motifs (hachures) inchangés. **[IMPORTANT]**

### 3.2 Typographie
- Famille : Inter (variable) avec fallback `system-ui`; `font-variant-numeric: tabular-nums` partout où figurent des heures.
- Échelle (px/line-height) : 11/16 (légende dense, usage rare), **12/16** (blocs, en-têtes grille), **13/20** (corps dense, défaut Schedule), 14/20 (formulaires), 16/24 (titres de section), 20/28 (titre de page), 28/36 (KPI rapports). Plancher 12 px sauf légende.
- Graisses : 400, 500, 600 uniquement. Pas d'italique décoratif.

### 3.3 Espacements, formes, mouvement
- Base 4 px : `2, 4, 8, 12, 16, 24, 32, 48`.
- Rayons : 4 (inputs, chips), 6 (blocs), 8 (popovers, cartes), 999 (avatars/pills).
- Élévation : popover `0 4px 16px rgba(0,0,0,.12)`, le reste flat (bordure 1 px). En sombre, élévation par clarté de surface.
- Z-index : grille 0 / en-têtes sticky 10 / popover 30 / toast 50 / modal 60.
- Mouvement : durées 80 / 120 / 200 ms ; easing `cubic-bezier(.2,.8,.2,1)` ; tout réduit à ≤ 1 ms si `prefers-reduced-motion`.
- Hauteurs contrôles : 28 (dense), 32 (défaut), 44 (cible tactile mobile).

### 3.4 Composants du design system
**Primitives** : Button (primaire/secondaire/ghost/danger, tailles), IconButton, Input, NumberInput (heures décimales), DateRangePicker, Select/Combobox (recherche), Checkbox/Radio/Switch, Tag/Chip, Avatar (+ placeholder), Badge, Tooltip, Popover, Menu contextuel, Modal (dernier recours), Drawer/Side panel, Toast (avec Annuler), Banner (hors ligne/erreur), Tabs, Skeleton, Spinner, Empty state, ProgressBar.
**Schedule** : `ScheduleGrid` (virtualisée), `TimelineHeader` (jour/sem/mois, fériés), `PersonRow` (+ jauge capacité), `AllocationBlock` (variantes : confirmé/tentatif/%/répété/sélectionné/focus/ghost), `TimeOffBlock`, `HolidayColumn`, `CapacityBar`, `ResizeHandle`, `AllocationPopover`, `ConflictPanel`, `FilterBar` + `SavedViewMenu`, `ZoomControl`, `PresenceAvatars`, `SyncIndicator`, `ShortcutHelp`, `CommandPalette`.
**Domaine** : `ProjectColorPicker` (palette contrastée), `ProjectSidebar` (budget/équipe/phases), `TimesheetRow/Grid`, `TimeoffRequestForm`, `ReassignDialog` (BR-04), `RemoveFromProjectDialog` (BR-10 : récap des suppressions), `UtilizationTable`, `BudgetBurnBar`, `DeltaChip` (dérive vs baseline).
Livrables : Storybook avec états (hover/focus/disabled/erreur/chargement), tests a11y automatisés (axe) en CI, tokens exportés (CSS vars + JSON). **[IMPORTANT]**

---

## 4. Mobile, accessibilité, états

### 4.1 Mobile (FR-14, P1)
- **[IMPORTANT]** Pas de grille 2D en mobile : vue **Mon planning** en liste agenda (jour/semaine) + vue **Équipe** en liste par personne avec jauge ; zoom/pinch non requis.
- 3 actions : (1) consulter son planning ; (2) **logger son temps en 2 taps** (carte du jour pré-remplie « Confirmer » / « Ajuster » ; BR-11) ; (3) demander un congé (type, dates, envoi).
- Édition d'allocation sur mobile : lecture seule au MVP **[CONFORT]** ; éditer via popover simple (dates/heures) en V1.x.
- Cibles ≥ 44 px, barre d'onglets inférieure (Planning, Temps, Congés, Profil), toute feuille modale avec bouton Fermer visible + geste de balayage + Échap (défaut Float à corriger).
- Responsive desktop : < 1024 px, colonne gauche réduite à avatars ; < 768 px bascule vers vues liste. PWA/notifications push en P1.

### 4.2 Accessibilité (WCAG 2.2 AA)
- **[BLOQUANT]** La grille Schedule : `role="grid"`, lignes `row`, cellules `gridcell`, blocs focusables (`tabindex` roving) avec `aria-label` complet : « Projet Refonte, Alice, du lundi 12 au mercredi 14, 6 h/jour, confirmé ». Un seul tab-stop pour la grille, flèches à l'intérieur.
- **[BLOQUANT]** Alternatives aux drags : `Alt+Flèches` déplacer, `Shift+Flèches` redimensionner, popover avec champs date/heure (WCAG 2.5.7 Dragging Movements). Tactile : appui long pour déplacer + poignées ≥ 24 px (2.5.8).
- Contraste : texte ≥ 4.5:1, éléments UI/graphiques ≥ 3:1 (bordures de blocs, barres de capacité) ; vérifié en clair et en sombre ; blocs sur couleur projet calculés automatiquement.
- Aucune information par la couleur seule : tentatif (motif + pointillé + icône), surbooking (icône ▲ + « +2 h »), congé (motif + libellé), états d'approbation (icône + texte).
- Focus visible 2 px, non masqué par en-têtes sticky (2.4.11) ; ordre de tabulation : barre haute → liste → grille → panneaux.
- Annonces `aria-live="polite"` pour : sauvegarde, rollback, mise à jour temps réel, sur-allocation créée. Toasts : persistance suffisante (≥ 6 s ou jusqu'à fermeture) et focus non volé.
- `prefers-reduced-motion`, `prefers-contrast`, zoom 200 % sans perte (reflow 320 px pour hors-grille), taille de texte utilisateur respectée (rem).
- Alternative tabulaire : vue **Liste/Table** du Schedule (personne, projet, dates, heures) accessible lecteur d'écran et exportable. **[IMPORTANT]**
- Tests : axe en CI, revue manuelle NVDA/VoiceOver sur 3 parcours, audit avant GA.

### 4.3 États vides / erreurs / chargement
| Contexte | Vide | Chargement | Erreur |
|---|---|---|---|
| Schedule (0 personne) | Illustration légère + « Ajoutez vos premières personnes » + [Importer CSV] [Ajouter] | Skeleton lignes + en-têtes réels | Bannière avec « Réessayer » ; grille en cache conservée |
| Personne sans allocation | Ligne vide avec bandeau « Libre » + clic/drag pour créer | Skeleton de blocs | — |
| Filtres sans résultat | « Aucun résultat » + [Réinitialiser filtres] | — | — |
| Projet sans équipe | CTA « Ajouter des personnes » | — | — |
| Rapports (période vide) | Explication + lien vers Schedule | Skeleton tableau/graphe | Message + code incident |
| Timesheet | « Rien de planifié cette semaine » + [Ajouter une ligne] | Skeleton | Soumission échouée : conserver la saisie |
- Messages d'erreur : cause en langage clair + action ; jamais de code seul ; erreurs de formulaire inline (icône + texte + `aria-describedby`).
- Mutation échouée sur un bloc : rollback + toast ; bloc marqué « non synchronisé » tant que non résolu.
- Chargement progressif : l'ossature de la grille s'affiche en < 1 s, données par fenêtre ; indicateur d'actualisation n'empêche pas l'interaction.
- Permissions : Member voit seulement ses assignations (FR-09) → états vides expliquant « Vous n'avez pas accès à cette vue » ; Guest = lecture seule, poignées/drop masqués plutôt que désactivés.
- **[IMPORTANT]** i18n : FR par défaut ; durées en décimal (BR-11), formats de date locaux, début de semaine configurable (le schéma indexe lundi=0).

---

## 5. Parcours à fluidifier et wireframes

### 5.1 Parcours prioritaires
1. **[BLOQUANT] Première allocation** : à l'ouverture d'un compte vide → assistant 3 étapes (équipe, premier projet, premier bloc posé par drag guidé). Cible < 5 min.
2. **[BLOQUANT] Détection → résolution d'un surbooking** : alerte sur ligne → ConflictPanel → [Trouver quelqu'un] filtre auto (rôle + dispo sur la plage) → drag/choix → résolu, sans quitter la grille.
3. **[IMPORTANT] Congé sur allocations** (BR-04) : dialogue de report assisté (voir 2.6).
4. **[IMPORTANT] Timesheet « Yep »** : une carte par jour, bouton unique « Confirmer la semaine » ; ajustements inline ; soumission = verrouillage avec explication (BR-12).
5. **[IMPORTANT] Retrait d'une personne d'un projet** (BR-10) : dialogue avec récap (« 12 allocations, 34 h loggées seront supprimées »), saisie de confirmation si > N éléments, lien « Plutôt réaffecter ».
6. **[CONFORT] Import** CSV/tableur avec mapping et prévisualisation (time-to-value < 1 j).
7. **[CONFORT] Duplication de projet / de semaine** avec options.

### 5.2 Wireframe A — Schedule (vue Semaine)
```
┌──────────────────────────────────────────────────────────────────────────────────┐
│ Float*  [Schedule][Projects][People][Time][Reports]        🔍 /  ⌘K   ● Synchro  │
├──────────────────────────────────────────────────────────────────────────────────┤
│ Vue: [Design team ▾]  Filtres: [Rôle: Designer ×] [Surbookés ×] [+]              │
│ [‹] [Aujourd'hui] [›]   Oct 2026      Zoom: (Jour|■Semaine|Mois)   [+ Allocation]│
├───────────────────┬──────────────────────────────────────────────────────────────┤
│                   │  S41 12-16   │  S42 19-23   │  S43 26-30   │  S44 02-06     │
│                   │ L M M J V    │ L M M J V    │ L M M J V    │ L M M J V      │
├───────────────────┼──────────────────────────────────────────────────────────────┤
│▾ Design (4)       │                                                              │
│ (A) Alice  ▓▓▓░░  │ [▓▓ Refonte 6h ▓▓▓▓▓▓][░ ? Pitch 4h (tentatif) ░░░░]          │
│     Designer 85%  │        ▲ capacité OK                                         │
│ (B) Bob    ▓▓▓▓▲  │ [▓▓ Refonte 8h ▓▓▓][▓ App 4h ▓▓▓▓▓]   ▲ +4h sur-alloué       │
│     Designer 120% │ ········································ [//Vacances//////]  │
│ (C) Chloé  ▓░░░░  │ [▓ App 3h ▓▓▓]                       « 5 h libres »          │
│ (·) Designer ?    │                                                              │
│     Placeholder   │                                                              │
├───────────────────┼──────────────────────────────────────────────────────────────┤
│ Total équipe      │ ▂▅▇▆▅ │ ▅▇█▇▅ │ ▃▄▅▄▂ │ ▂▃▃▂▁   (charge vs capacité)         │
└───────────────────┴──────────────────────────────────────────────────────────────┘
 Légende: ▓ confirmé  ░ tentatif (pointillé)  // congé  ▲ sur-allocation
```

### 5.3 Wireframe B — Popover d'allocation (clic sur un bloc)
```
        ┌─────────────────────────────────────────┐
        │ Refonte site — Acme            [⋯] [✕] │
        │ Alice Martin                            │
        │ Dates   [12/10/26] → [14/10/26]  3 j    │
        │ Charge  (●) Heures/jour [ 6.0 ]  ( ) %  │
        │ Statut  (●) Confirmé   ( ) Tentatif     │
        │ Phase   [Concept ▾]   Tâche [ — ▾ ]     │
        │ Nom     [Concepting________________]    │
        │ ☑ Facturable    ↻ Répéter: [Jamais ▾]   │
        │ ⚠ Alice: 120 % le 13/10  [Voir conflit] │
        │ Notes   [__________________________]    │
        │ [Supprimer]        [Annuler] [Enregistrer]│
        └─────────────────────────────────────────┘
        Enregistrement auto à la sortie de champ ; Échap ferme.
```

### 5.4 Wireframe C — Timesheet (mobile, « Yep ») + congé
```
┌──────────────────────┐   ┌──────────────────────┐
│ ‹ Semaine 42      ✕  │   │ Demande de congé  ✕  │
├──────────────────────┤   ├──────────────────────┤
│ Lun 19    7,5 h  ✓   │   │ Type  [Vacances ▾]   │
│  ▓ Refonte  6,0 h    │   │ Du    [26/10/26]     │
│  ▓ App      1,5 h    │   │ Au    [30/10/26]     │
│ Mar 20    8,0 h  ✓   │   │ ◉ Journée entière    │
│ Mer 21    8,0 h  ○   │   │ ○ Partiel [ 4 ] h/j  │
│  ▓ Refonte  8,0 h    │   │ ⚠ 3 allocations      │
│   [Ajuster] [Yep ✓]  │   │   impactées (voir)   │
│ Jeu 22    — à venir  │   │ Note  [__________]   │
├──────────────────────┤   │ [Annuler] [Envoyer]  │
│ [ Confirmer semaine ]│   └──────────────────────┘
├──────────────────────┤
│ Planning|Temps|Congés│
└──────────────────────┘
```

---

## 6. Questions ouvertes

1. **[BLOQUANT]** Seuils d'état de capacité : sous < 80 %, OK 80–100 %, limite 100 %, sur > 100 % — valides ? Paramétrables par compte ou globaux ? Orange = « limite » (dossier §4.1) est-il bien ≤ 100 % ?
2. **[BLOQUANT]** Portée de l'undo/redo (session locale vs. historique serveur) et traitement des cascades BR-10.
3. **[BLOQUANT]** Stratégie de conflit temps réel : last-write-wins par bloc, ou verrouillage optimiste (`modified_at`) avec écran de résolution ?
4. **[IMPORTANT]** Schéma : pas de table pour les **vues sauvegardées** (nom, propriétaire, partage, JSON de filtres), ni de préférences utilisateur (densité, thème), ni de notifications (FR-10), ni de lien de groupe pour allocations multi-personnes. À ajouter.
5. **[IMPORTANT]** `people.country` absent : sans lui, les fériés par pays ne s'affichent pas dans la grille (déjà noté dans CLAUDE.md).
6. **[IMPORTANT]** Couleur d'accent de marque : vert fluo façon Float (contraste insuffisant) ou nouvelle identité ? Impacte aussi la distinction avec `--cap-ok`.
7. **[IMPORTANT]** Un jour de semaine sans capacité (temps partiel) : accepter un drop (BR-01 dit « ne peut être posée que sur jour ouvré ») ? Proposer un message ou un blocage doux.
8. **[IMPORTANT]** Mode % : affichage heures dérivées ; que devient l'allocation en % si la capacité de la personne change (`work_days_hours` modifié) ?
9. **[IMPORTANT]** Allocations qui se chevauchent pour une même personne : empilées verticalement dans la ligne (hauteur variable) ou en sous-lignes fixes ? Impact virtualisation.
10. **[CONFORT]** Partage de vues/URLs avec Guests (lecture seule) : périmètre et anonymisation (taux, coûts masqués).
11. **[CONFORT]** Langues et localisation au MVP (FR seul ou FR/EN) ; début de semaine configurable.
12. **[CONFORT]** Édition d'allocation sur mobile : lecture seule jusqu'à quand ?
