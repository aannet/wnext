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

Le système est plat. Le fond est blanc, le texte anthracite, et une seule couleur d'accent, le pétrole, sert aux actions principales et à la période courante. Les ombres n'apparaissent que pour les popovers et le panneau latéral. Tout le reste se sépare par une bordure de 1 px.

Le caractère voulu pour les composants est « franc et tactile » (décision du 2026-10-23). Ce caractère n'est pas encore implémenté : aujourd'hui, le retour au survol et à l'appui ne passe que par la couleur (voir Components).

**Key Characteristics:**
- Fond blanc, texte anthracite, une seule couleur d'accent.
- Plat au repos : bordure de 1 px, ombre seulement pour popover et tiroir.
- Information non chromatique : tentatif (hachures et pointillé), dépassement (hachures rouges, cadre, ligne).
- Densité à trois niveaux à hauteurs fixes, pas d'ajustement à la fenêtre.
- Thème clair uniquement : le mode sombre est hors périmètre.

## Colors

Palette sobre : neutres froids et un seul accent. Les couleurs de capacité et d'alerte sont des états, jamais des décorations.

### Primary
- **Pétrole profond** (#0e7490) : l'accent de marque. Bouton principal, période courante, focus de sélection. Contraste 5,4:1 sur blanc, texte blanc dessus. Utilisé sur peu d'éléments à la fois.
- **Pétrole profond survolé** (#0b5c72) : survol du bouton principal. Plus foncé que l'accent, car un éclaircissement passait sous WCAG AA (4,42:1).

### Secondary
- **Vert contrôle** (#1e8e3e) : capacité saine (80 à 100 %). Toujours accompagné d'une forme ou d'un libellé.
- **Ambre avertissement** (#b45309) : avertissement de capacité et de congé en attente.
- **Rouge alerte** (#b91c1c) : dépassement de capacité (au-delà de 100 %), variante destructive pleine avec texte blanc (5,9:1).
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

Grille du Planning : personnes en lignes, jours en colonnes, en-tête collant. Trois densités à hauteurs fixes (`density.ts`) :
- **Compact** : bloc à 48 px par journée, bande de capacité à 14 px.
- **Standard** (défaut) : bloc à 72 px, bande à 20 px.
- **Aéré** : bloc à 96 px, bande à 24 px, avatars de 36 px.

La page occupe 100 % de la hauteur de la fenêtre et ne défile pas. Seule la grille défile, dans son conteneur. La barre d'outils passe à la ligne au besoin. Les week-ends et jours non ouvrés sont hachurés en vue jour. La période courante est soulignée d'un trait pétrole.

Espacements sur une base de 4 px : 2, 4, 8, 12, 16, 24, 32, 48. Marges latérales de 16 px.

## Elevation & Depth

Système plat. Au repos, aucune surface n'a d'ombre : la séparation passe par une bordure de 1 px (`--color-border`, `--color-border-strong`) et par les fonds (`--color-surface-sunken`).

### Shadow Vocabulary
- **Popover** (`box-shadow: 0 4px 16px rgb(0 0 0 / 0.12)`) : menus, popovers d'édition, listes ouvertes (Combobox).
- **Drawer** (`box-shadow: -8px 0 24px rgb(0 0 0 / 0.16)`) : panneau latéral projet ou personne.
- **Armed** (`box-shadow: 0 4px 10px rgb(0 0 0 / 0.35)`) : bloc armé au toucher. Hors spec, conservé pour le tactile.

### Named Rules
**The Flat-By-Default Rule.** Une surface est plate au repos. Une ombre n'apparaît qu'en réponse à un état superposé (popover, tiroir, bloc armé).

**The Overlay Scrim Rule.** Une fenêtre modale pose un voile `rgb(17 24 39 / 0.45)` sous elle et passe au-dessus de la grille (z-index 60).

## Shapes

Rayons à quatre niveaux : 4 px pour les champs et puces (`sm`), 6 px pour les boutons, blocs et champs (`md`), 8 px pour popovers et cartes (`lg`), 999 px pour avatars et pastilles (`full`). Les blocs d'allocation ont un rayon de 3 px. Les bordures font 1 px, sauf le bord gauche des congés (3 px) et le contour de focus (2 px).

Forme de l'interface : rectangulaire, arrondie légèrement. Aucune forme organique.

## Components

Chaque composant part du caractère sobre actuel. Le caractère « franc et tactile » voulu n'est pas encore implémenté : la section précise l'écart.

### Buttons
- **Shape:** rayon 6 px (`md`), hauteur 32 px (défaut), 28 px (dense), 44 px (tactile). Padding horizontal 12 px.
- **Primary:** fond pétrole, texte blanc, bordure de même couleur. Sans ombre.
- **Hover / Focus:** survol du primaire : fond pétrole foncé (`accent-hover`), transition de couleur de 80 ms. Focus : contour 2 px encre, décalé de 2 px.
- **Outline:** fond blanc, bordure forte, texte anthracite. Survol : fond papier froid. État enfoncé : fond papier froid et graisse 600.
- **Destructive:** fond rouge alerte plein, texte blanc. Réservé aux confirmations (BR-04, BR-10, BR-31).
- **Link:** nom d'une ligne (projet, personne) qui ouvre sa fiche. Sans cadre, souligné au survol.
- **Gap to the intended character (not implemented):** le caractère « franc et tactile » demande un retour au survol et à l'appui plus marqué (léger déplacement ou élévation). Aujourd'hui, seul le changement de couleur existe. À traiter en raffinement, sans changer les formes.

### Chips (filtres)
- **Style:** fond papier froid, bordure 1 px, rayon plein. Texte 12 px.
- **State:** le retrait est un petit bouton circulaire de 20 px. Survol : fond bordure.

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
- **Time off:** fond de la teinte du type de congé, bord gauche 3 px, en attente en tirets et hachures blanches, refusé barré.

### Capacity band
- **Under:** gris ardoise. **OK:** fond neutre et ligne de capacité. **Over:** hachures rouges sur fond rouge clair, cadre rouge, ligne encre. Affiche la charge en texte (caption) quand la bascule est active.

### Navigation
- **Style:** barre d'en-tête sobre, bordure basse 1 px ; le bouton « Aujourd'hui » suit les boutons de la barre d'outils du Planning.
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
