---
name: WNEXT
description: Planning de ressources sobre et fiable, où la capacité se lit d'un coup d'œil.
colors:
  accent: "#0e7490"
  accent-hover: "#0b5c72"
  accent-foreground: "#ffffff"
  background: "#ffffff"
  surface-sunken: "#f9fafb"
  border: "#e3e5e0"
  border-strong: "#d1d5db"
  text: "#1f2328"
  text-soft: "#374151"
  text-muted: "#5b6168"
  focus-ink: "#1f2937"
  ink: "#111827"
  cap-under: "#6b7c93"
  cap-ok: "#1e8e3e"
  cap-warn: "#b45309"
  cap-over: "#b91c1c"
  cap-confirmed: "#1d4ed8"
  danger-text: "#991b1b"
  danger-bg: "#fef2f2"
typography:
  body:
    fontFamily: "system-ui, sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: "20px"
  form:
    fontFamily: "system-ui, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: "20px"
  label:
    fontFamily: "system-ui, sans-serif"
    fontSize: "12px"
    fontWeight: 500
    lineHeight: "16px"
  caption:
    fontFamily: "system-ui, sans-serif"
    fontSize: "11px"
    fontWeight: 400
    lineHeight: "16px"
  heading:
    fontFamily: "system-ui, sans-serif"
    fontSize: "16px"
    fontWeight: 600
    lineHeight: "24px"
  title:
    fontFamily: "system-ui, sans-serif"
    fontSize: "20px"
    fontWeight: 600
    lineHeight: "28px"
  kpi:
    fontFamily: "system-ui, sans-serif"
    fontSize: "28px"
    fontWeight: 600
    lineHeight: "36px"
rounded:
  sm: "4px"
  md: "6px"
  lg: "8px"
  full: "999px"
spacing:
  xxs: "2px"
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "24px"
  xxl: "32px"
  xxxl: "48px"
components:
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.accent-foreground}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    padding: "0 12px"
    height: "32px"
  button-primary-hover:
    backgroundColor: "{colors.accent-hover}"
    textColor: "{colors.accent-foreground}"
  button-outline:
    backgroundColor: "{colors.background}"
    textColor: "{colors.text}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    padding: "0 12px"
    height: "32px"
  input-default:
    backgroundColor: "{colors.background}"
    textColor: "{colors.text}"
    typography: "{typography.form}"
    rounded: "{rounded.md}"
    padding: "0 8px"
    height: "32px"
  chip-filter:
    backgroundColor: "{colors.surface-sunken}"
    textColor: "{colors.text}"
    typography: "{typography.label}"
    rounded: "{rounded.full}"
    padding: "2px 4px 2px 8px"
---

# Design System: WNEXT

## Overview

**Creative North Star: "Le registre calme"**

WNEXT est un outil de travail de professionnel : un registre tenu à jour, où les chiffres sont justes et où rien ne crie. Le planning se lit comme un tableau de bord sobre. La couleur sert à distinguer les projets et à signaler un dépassement, jamais à décorer. La densité est maîtrisée : trois niveaux de lignes (compact, standard, aéré) pour afficher douze personnes à l'écran sur un écran 1920 × 1080.

Le système est plat. Le fond est blanc, le texte anthracite, et une seule couleur d'accent, le pétrole, sert aux actions principales et à la période courante. Les ombres n'apparaissent que pour les popovers, le panneau latéral et le survol d'un objet manipulable (bloc du Planning). Tout le reste se sépare par une bordure de 1 px.

Le caractère voulu pour les composants est « franc et tactile » (décision du 2026-10-23). Il est en place dans le Planning : un bouton s'enfonce d'un pixel à l'appui, un bloc se soulève d'un pixel au survol de la souris (RT-062). Le survol d'un bouton reste une variation de couleur (voir Components).

**Key Characteristics:**
- Fond blanc, texte anthracite, une seule couleur d'accent.
- Plat au repos : bordure de 1 px, ombre seulement pour popover, tiroir et bloc survolé ou armé.
- Information non chromatique : tentatif (hachures et pointillé), dépassement (hachures rouges, cadre, ligne).
- Densité à trois niveaux à hauteurs fixes, pas d'ajustement à la fenêtre.
- Thème clair uniquement : le mode sombre est hors périmètre.

## Colors

Palette sobre : neutres froids et un seul accent. Les couleurs de capacité et d'alerte sont des états, jamais des décorations.

### Primary
- **Pétrole profond** (#0e7490) : l'accent de marque. Bouton principal, période courante, focus de sélection. Contraste 5,4:1 sur blanc, texte blanc dessus. Utilisé sur peu d'éléments à la fois.
- **Pétrole profond survolé** (#0b5c72) : survol du bouton principal. Plus foncé que l'accent, car un éclaircissement passait sous WCAG AA (4,42:1).

### Secondary
- **Vert contrôle** (#1e8e3e) : capacité saine (80 à 100 %, 100 % compris). Toujours accompagné d'une forme ou d'un libellé.
- **Ambre avertissement** (#b45309) : congé en attente. La jauge de capacité ne l'emploie plus (décision D2 du 2026-10-23 : plus d'orange).
- **Rouge alerte** (#b91c1c) : dépassement de capacité (au-delà de 100 %, jour par jour), variante destructive pleine avec texte blanc (5,9:1).
- **Bleu confirmé** (#1d4ed8) : part confirmée dans la bande de capacité, distincte du tentatif.

### Tertiary
- **Gris ardoise** (#6b7c93) : capacité sous-allouée (sous 80 %).

### Neutral
- **Papier froid** (#f9fafb) : zones vides de la bande de capacité, fond des champs désactivés et des panneaux.
- **Encre franche** (#111827) : contour de focus d'un bloc, ligne de capacité, poignées de geste.
- **Anthracite** (#1f2328) : texte principal. **Texte soft** (#374151) : aide et statut. **Texte atténué** (#5b6168) : libellés secondaires.
- **Bordure** (#e3e5e0) : séparateurs de grille. **Bordure forte** (#d1d5db) : contour des champs, popovers, boîtes de dialogue.
- **Anneau de focus** (#1f2937) : encre plutôt que bleu, pour ne pas brouiller l'accent (14,7:1 sur blanc).

### Named Rules
**The One Voice Rule.** Le pétrole est l'unique couleur d'action et d'accent. Une seconde couleur vive dans un même écran ne se justifie que pour un état (dépassement, avertissement).

**The Project Colour Rule.** Les couleurs de projet vivent dans les blocs seulement, générées en OKLCH à clarté et chroma constants (L 0,62, C 0,12). Les teintes proches du rouge d'alerte (environ 27°) et du pétrole (environ 223°) sont exclues, et le texte du bloc est noir ou blanc selon le contraste (4,58:1 minimum).

**The No Raw Colour Rule.** Aucune couleur littérale hors de `apps/web/src/design/tokens.css` (garde-fou `lint:raw-colors`, dans `make check`).

## Typography

**Display Font:** system-ui, sans-serif (non chargée : la pile reste celle de l'écran actuel). Inter est prévue par la spec et n'est pas encore branchée.
**Body Font:** system-ui, sans-serif.
**Label/Mono Font:** la même pile. Les heures et montants utilisent les chiffres tabulaires (`font-variant-numeric: tabular-nums`).

**Character:** neutre et lisible, faite pour des données denses. Une seule famille, trois graisses (400, 500, 600).

### Hierarchy
- **KPI** (600, 28px, 36px) : chiffres de synthèse, rares.
- **Title** (600, 20px, 28px) : titre d'écran et de panneau.
- **Heading** (600, 16px, 24px) : titre de section, en-tête de fenêtre.
- **Form** (400, 14px, 20px) : champs de saisie et libellés de formulaire.
- **Body** (400, 13px, 20px) : texte courant et corps dense du Schedule, défaut.
- **Label** (500, 12px, 16px) : libellés de colonne, puces, méta-données.
- **Caption** (400, 11px, 16px) : texte de bande de capacité et annotations.

### Named Rules
**The Tabular Hours Rule.** Toute durée et tout pourcentage s'affiche en chiffres tabulaires, pour que les colonnes restent alignées.

## Layout

Grille du Planning : personnes en lignes, jours en colonnes, en-tête collant. Trois densités à hauteurs fixes (`density.ts`), bande de capacité comprise :
- **Compact** : bloc à 48 px par journée, bande de capacité à 14 px.
- **Standard** (défaut) : bloc à 72 px, bande à 20 px.
- **Aéré** : bloc à 96 px, bande à 24 px, avatars de 36 px.

Bascule « Charge » (menu Affichage, RT-052) : active par défaut, état en mémoire seulement. Éteinte, toute la bande de capacité disparaît (graphique et chiffres, dépassements compris) et chaque ligne perd la hauteur de la bande ; la jauge de la colonne Personnes reste le signal de surcharge.

Barre du Planning (recette n°4, « Planning cible ») : une seule ligne au-dessus de la grille, le titre puis la barre d'outils (Filtres et puces, statut du temps réel, Annuler, Rétablir, navigation, zoom, Affichage), qui passe à la ligne au besoin. Ni saisie rapide ni boutons de création (RT-057, RT-060) : la création passe par la grille (clic, glisser, appui long) et par la touche N. Une grille sans aucun bloc porte une seule indication, 12 px `--text-muted`, au-dessus d'elle (« Cliquez ou glissez dans la grille pour planifier »). Le nombre de personnes affichées est dans le coin au-dessus de la colonne Personnes (12 px, graisse 500, `--text-muted`, zone `aria-live` polie ; RT-061).

La page occupe 100 % de la hauteur de la fenêtre et ne défile pas. Seule la grille défile, dans son conteneur. La barre d'outils passe à la ligne au besoin. Les week-ends et jours non ouvrés sont hachurés en vue jour. La colonne courante est teintée de pétrole à 10 % ; un trait « maintenant » (2 px pétrole, liseré blanc de 1 px) marque le début du jour courant sur toute la hauteur des lignes, au-dessus des blocs, au prorata du jour en vue semaine et mois (RT-055). Décoratif : il ne capte pas le pointeur et n'est pas annoncé (l'en-tête porte `aria-current`).

Espacements sur une base de 4 px : 2, 4, 8, 12, 16, 24, 32, 48. Marges latérales de 16 px.

## Elevation & Depth

Système plat. Au repos, aucune surface n'a d'ombre : la séparation passe par une bordure de 1 px (`--color-border`, `--color-border-strong`) et par les fonds (`--color-surface-sunken`).

### Shadow Vocabulary
- **Popover** (`box-shadow: 0 4px 16px rgb(0 0 0 / 0.12)`) : menus, popovers d'édition, listes ouvertes (Combobox).
- **Drawer** (`box-shadow: -8px 0 24px rgb(0 0 0 / 0.16)`) : panneau latéral projet ou personne.
- **Armed** (`box-shadow: 0 4px 10px rgb(0 0 0 / 0.35)`) : bloc armé au toucher. Hors spec, conservé pour le tactile.
- **Hover** (`--shadow-hover`, `box-shadow: 0 2px 6px rgb(0 0 0 / .18)`) : bloc du Planning survolé à la souris (RT-062).

### Named Rules
**The Flat-By-Default Rule.** Une surface est plate au repos. Une ombre n'apparaît qu'en réponse à un état superposé (popover, tiroir, bloc armé) ou au survol d'un objet manipulable à la souris (bloc du Planning). Une carte, un bouton ou un champ restent plats au survol.

**The Overlay Scrim Rule.** Une fenêtre modale pose un voile `rgb(17 24 39 / 0.45)` sous elle et passe au-dessus de la grille (z-index 60).

## Shapes

Rayons à quatre niveaux : 4 px pour les champs et puces (`sm`), 6 px pour les boutons, blocs et champs (`md`), 8 px pour popovers et cartes (`lg`), 999 px pour avatars et pastilles (`full`). Les blocs d'allocation ont un rayon de 3 px. Les bordures font 1 px, sauf le bord gauche des congés (3 px) et le contour de focus (2 px).

Forme de l'interface : rectangulaire, arrondie légèrement. Aucune forme organique.

## Components

Chaque composant part du caractère sobre actuel. Le caractère « franc et tactile » est en place dans le Planning (boutons à l'appui, blocs au survol) ; ailleurs, les composants gardent le caractère sobre.

### Buttons
- **Shape:** rayon 6 px (`md`), hauteur 32 px (défaut), 28 px (dense), 44 px (tactile). Padding horizontal 12 px.
- **Primary:** fond pétrole, texte blanc, bordure de même couleur. Sans ombre.
- **Hover / Focus:** survol du primaire : fond pétrole foncé (`accent-hover`), transition de couleur de 80 ms. Focus : contour 2 px encre, décalé de 2 px.
- **Outline:** fond blanc, bordure forte, texte anthracite. Survol : fond papier froid. État enfoncé : fond papier froid et graisse 600.
- **Destructive:** fond rouge alerte plein, texte blanc. Réservé aux confirmations (BR-04, BR-10, BR-31).
- **Link:** nom d'une ligne (projet, personne) qui ouvre sa fiche. Sans cadre, souligné au survol.
- **Tactile (en place dans le Planning) :** à l'appui, le bouton descend d'un pixel (`translateY(1px)`), transition de 80 ms. Le survol d'un bouton ne se déplace pas et ne prend pas d'ombre : seuls les objets manipulables (blocs) se soulèvent au survol (Flat-By-Default Rule).

### Chips (filtres)
- **Style:** fond papier froid, bordure 1 px, rayon plein. Texte 12 px.
- **State:** le retrait est un petit bouton circulaire de 20 px. Survol : fond bordure.

### Panneau Filtres et vues sauvegardées (RT-058)
- **Bouton :** « Filtres », « Filtres (N) » avec des filtres actifs, suivi du nom de la vue active (« Filtres · Studio ») et d'un ● `--color-warn-text` si elle est modifiée (doublé d'un texte masqué « (vue modifiée) »).
- **Panneau :** papier froid, bordure 1 px, rayon 6 px, padding 12 px, en colonne : « Vue » (liste) en tête, puis les filtres (listes, tri, « Effacer les filtres »), puis les actions d'enregistrement en pied, séparées par un filet (Enregistrer la vue…, Mettre à jour, Renommer…, Supprimer…). Une vue garde zoom et densité.

### DataTable (listes Projets, Personnes, Clients ; RT-053)
- **Composant unique :** `apps/web/src/design/ui/data-table.tsx` ; les trois écrans le montent, seules les colonnes, les filtres et les actions changent. Clients ne vit que dans Réglages.
- **Barre d'outils :** recherche à gauche (`type=search`, nom accessible = placeholder), emplacement des filtres (sélecteurs ou puces) ensuite, action primaire à droite (`Nouveau …`, masquée à qui ne peut pas écrire).
- **Lignes et en-têtes :** lignes de 40 px, séparateurs `--color-border-subtle`, survol `--surface-sunken`, ligne ouverte (`data-current`) idem. En-têtes 12 px graisse 500, `--text-muted`, 32 px de haut.
- **Tri :** côté client. Un en-tête triable est un bouton (Tab, Entrée, Espace) ; premier clic croissant, second décroissant ; `aria-sort` sur l'en-tête actif seulement, flèche en CSS.
- **Colonne d'actions :** à droite, 48 px, menu « … » (`dropdown-menu.tsx`), nom accessible « Actions pour {nom} ». Actions non destructives d'abord, destructive en dernier (texte `--color-danger-text`, filet au-dessus) avec confirmation (Modal, bouton danger, focus sur la confirmation). La colonne disparaît si aucune ligne n'a d'action (lecture seule). Après confirmation ou annulation, le focus revient au menu de la ligne, sinon à la table : jamais sur `<body>`.
- **États vides :** liste vide (titre, texte, action de création) ou résultat filtré vide (titre, texte, « Réinitialiser » ou « Effacer les filtres ») ; la barre d'outils reste.
- **Regroupement :** optionnel (`groups`), un `tbody` par groupe, en-tête de groupe sur toutes les colonnes (Personnes par équipe, RT-031).

### Cards / Containers
- **Corner Style:** 8 px pour les popovers et cartes, 6 px pour les panneaux de filtres.
- **Background:** blanc sur fond blanc, ou papier froid pour les panneaux.
- **Shadow Strategy:** plate, sauf popover et tiroir.
- **Border:** 1 px bordure ou bordure forte.
- **Internal Padding:** 12 px pour les panneaux, 8 px pour les contenus denses.

### Inputs / Fields
- **Style:** bordure forte 1 px, fond blanc, rayon 6 px, hauteur minimale 32 px, padding horizontal 8 px. Textarea : padding 4 px vertical.
- **Focus:** contour 2 px anneau de focus, décalé de 1 px.
- **Error:** bordure rouge alerte (`aria-invalid`). **Disabled:** opacité 60 %.

### Schedule blocks
- **Shape:** rayon 3 px, couleur de projet en fond, texte noir ou blanc calculé. Bord 1 px.
- **Tentative:** fond teinté, bordure pointillée et hachures diagonales. Trois canaux, dont deux non chromatiques.
- **Focus / armed:** contour encre 2 px ; poignées de geste de 6 px.
- **Hover (souris seulement, `(hover: hover) and (pointer: fine)`) :** soulèvement d'1 px (propriété `translate`, qui se compose avec le `transform` de position) et ombre `--shadow-hover`, en 80 ms. Mouvement réduit : l'ombre seule. Rien pendant un glisser ni sur un bloc armé. La ligne n'a plus `contain: paint` (elle rognait l'ombre) : `contain: size layout style` et `isolation: isolate`.
- **Time off:** fond de la teinte du type de congé, bord gauche 3 px, en attente en tirets et hachures blanches, refusé barré.

### Capacity band
- **Under:** gris ardoise. **OK:** fond neutre et ligne de capacité. **Over:** hachures rouges sur fond rouge clair, cadre rouge, ligne encre. Affiche la charge en texte (caption). La bascule « Charge » affiche ou masque toute la bande (voir Layout).

### Gauge (colonne Personnes)
- **Paliers (D2, 2026-10-23) :** gris ardoise sous le seuil de sous-allocation (80 % par défaut, réglable par compte) ; vert de ce seuil à 100 % compris ; rouge dès qu'un jour de la période affichée dépasse sa capacité (> 100 %, BR-38), même si la somme de la période reste sous 100 %. Plus d'orange : 100 % exact s'affiche en vert.
- **Redondance :** en dépassement, glyphe ▲ et « +N h » (N = somme des dépassements journaliers) ; infobulle « N jours en surcharge ». Jauge et bande d'une même ligne sont toujours d'accord.
- **Barre :** 6 px dans les trois densités (4 px auparavant en compacte et standard), pourcentage de la période en chiffres tabulaires.

### Column header
- **Une rangée de 32 px (D7) :** fond papier froid (`--surface-sunken`) distinct du corps, texte anthracite graisse 600 (15:1), bordure basse forte. Période courante (jour, semaine, mois) en pastille pétrole, texte blanc (5,4:1).

### Navigation
- **Style:** barre d'en-tête sobre, bordure basse 1 px ; le bouton « Aujourd'hui » suit les boutons de la barre d'outils du Planning.
- **En-tête commun, à droite :** « Rechercher » avec sa pastille `Ctrl K` (`⌘K` sur Mac ; RT-059, recherche globale sur tous les écrans), la cloche des notifications, l'aide des raccourcis (bouton carré « ? » de 32 px, nom accessible « Raccourcis clavier », RT-064), Réglages, « Bonjour {prénom} », l'avatar.
- **Aide des raccourcis :** fenêtre modale, trois groupes (Partout, Grille du planning, Bloc sélectionné) ; chaque ligne : touches en pastilles `kbd` (bordure forte 1 px, rayon 4 px, fond papier froid, 11 px) à gauche, action à droite, filet 1 px entre les lignes. La liste vient de `apps/web/src/shell/shortcuts.ts`, la source des gestionnaires de touches. Touche « ? » hors d'un champ.
- **Import :** une seule entrée, Réglages > Import (owner, admin ; RT-054) ; les états vides de Personnes et de Projets y mènent par un lien.
- **Mobile (not implemented):** aucune navigation mobile dans le code. La spec (`docs/review/ux-ui.md` §4.1) prévoit une barre inférieure à quatre onglets, pas encore construite.

## Do's and Don'ts

### Do:
- **Do** réserver le pétrole à l'accent et aux actions principales (règle One Voice).
- **Do** doubler chaque couleur d'état par une forme ou un libellé (tentatif, dépassement).
- **Do** garder les cibles tactiles à 44 px minimum ; 32 px sur bureau.
- **Do** utiliser les tokens (`--color-*`, `--space-*`, `--radius-*`) et jamais de valeur en dur.
- **Do** écrire les textes via Lingui (FR par défaut, EN à la sortie) et tenir compte de l'allongement des libellés.

### Don't:
- **Don't** introduire de vert fluo ni de dégradé décoratif : Float en est la référence à éviter.
- **Don't** utiliser le rouge alerte pour un bloc de projet (la palette l'exclut).
- **Don't** ajouter d'ombre au repos sur une carte, un bouton ou un champ.
- **Don't** masquer un état derrière la couleur seule (WCAG 1.4.1).
- **Don't** utiliser un bleu pour le focus : l'anneau est encre, pour ne pas concurrencer l'accent.
