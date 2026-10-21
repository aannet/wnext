# Design — principes d'UX et de composants WNEXT

Statut : vivant. Ce document consigne les principes d'interface décidés par Alec en recette. Il complète `direction.md` (identité visuelle) et `docs/review/ux-ui.md` (spec). En cas de conflit, les décisions d'Alec et les ADR l'emportent.

## Kit de composants

- **shadcn/ui** (ADR-010), sur Tailwind v4 (ADR-009). Le code vit dans `apps/web/src/design/ui/` et reste modifiable.
- Les couleurs passent uniquement par `apps/web/src/design/tokens.css`. Aucune couleur en dur ailleurs (`npm run lint:raw-colors`).
- Les noms sémantiques de shadcn (`bg-primary`, `border-input`, `ring-ring`…) sont des alias de nos tokens, sans valeur propre.
- Boutons : toujours le composant `Button` (`design/`), variantes `primary`, `secondary`, `danger`, taille `sm` pour les actions de ligne. Jamais de `<button>` stylé à la main.
- Champs (texte, liste, zone de texte) : style shadcn posé une fois dans la couche `base` de `styles.css`. Un écran n'ajoute que sa mise en page (largeur, grille).
- Reset Tailwind (preflight) actif depuis L-G : aucun style par défaut du navigateur n'est garanti (marges, listes, titres).
- Encore natifs : onglets, groupes radio (densité, couleur), menu de l'avatar, cloche et liens de tableau. `Popover` (L-J) est sur Base UI : portail, placement et retournement par Base UI, clic sur l'ancre ignoré.
- Survol d'un bouton plein (primaire, danger) : fond plus foncé (`--color-primary-hover`, `--color-destructive-hover`), jamais une transparence qui éclaircit (contraste AA).
- En-tête d'écran en deux niveaux (Planning, RT-025) : niveau 1 pour le titre, la vue et les créations ; niveau 2 (barre d'outils) pour les filtres (bouton avec compteur, puces retirables, panneau dépliable) et la navigation. Les réglages d'affichage (densité, charge) sont dans un menu « Affichage ».
- Tableau triable (Personnes, RT-031) : l'en-tête de colonne est un bouton, `aria-sort` sur la colonne triée, flèche dessinée en CSS ; un regroupement se fait par `tbody` avec une ligne d'en-tête `th scope="rowgroup"`.
- Statut temps réel (Q12) : une puce seule quand tout va bien (nom accessible et infobulle) ; puce et texte visibles en cas de problème.
- `Combobox` (L-K) : Combobox de Base UI, liste dans un portail au-dessus des fenêtres (`--z-menu`). Liste ouverte, Échap la ferme ; fermée, Échap remonte à la fenêtre sans vider le choix.
- Grille (L-I) : séparateurs de colonnes `--wn-grid-line` ; jours non travaillés `--wn-nonwork-hatch`, selon l'horaire de chaque personne (jamais un calendrier commun dans le corps) ; période courante marquée par l'accent, un soulignement et `aria-current="date"`, jamais par la couleur seule. Les fonds de la grille sont des couches CSS (un nœud par ligne au plus), pas un nœud par jour.
- Contrôle visuel d'un changement de CSS global : `node scripts/captures-ecrans.mjs <dossier>` (démo, serveur Vite lancé), avant et après.

## Fenêtres superposées

### Un clic hors d'un drawer le ferme

Décision d'Alec, recette n°2 (RT-023). Valable pour tout drawer (`Sheet` shadcn) du produit : projets, personnes, allocations, réglages.

- Un clic sur le voile, hors du panneau, ferme le drawer. Ce clic est consommé : il n'active ni le bloc ni la cellule situés dessous.
- Un clic dans le panneau ne le ferme pas, y compris dans les listes, menus, combobox et infobulles affichés en portail.
- Le clic ne compte comme extérieur que s'il commence et finit sur le voile : une sélection de texte qui déborde du panneau ne ferme pas.
- Échap ferme le drawer, sauf si un menu ou une liste est ouvert dans le panneau : Échap ferme alors d'abord ce menu.
- Le focus revient à l'élément qui a ouvert le drawer ; à défaut, à la grille.
- Modifications non enregistrées : clic extérieur, Échap et × demandent « Abandonner les modifications ? » [Continuer] [Abandonner]. Sans modification, la fermeture est directe (Q7, validé le 2026-10-21).
- Les confirmations bloquantes (BR-04, BR-10, BR-31) sont des `AlertDialog` et ne se ferment pas au clic extérieur.

État du code (L-G, L-K) : `design/Dialog.tsx` ferme un drawer au clic sur le voile, jamais une modale. Le deuxième clic d'un double clic n'est pas une demande de fermeture : le premier a pu ouvrir le drawer depuis un bloc. `onEscape` sert à revenir d'une étape (avertissement BR-04), sans confirmation.

### Pop-in ou drawer

- **Popover** : une action rapide et ancrée à un élément (choix d'un projet, par exemple).
- **Drawer** : une édition d'entité (projet, personne, allocation). Décision RT-024 : l'édition d'une allocation passe du modal à un drawer, comme pour les projets. La création passe par le même drawer (Q8) ; le bloc provisoire reste visible dans la grille pendant la saisie.
- **Modal** (`AlertDialog`) : seulement pour une confirmation bloquante (BR-04, BR-10, BR-31).

## Grille (Schedule)

- Séparateurs gris clair entre les colonnes (jour, semaine, mois) — RT-026.
- Le jour, la semaine ou le mois courant est mis en évidence dans l'en-tête — RT-027.
- Les jours non ouvrés sont hachurés selon l'horaire de chaque personne (`work_days_hours`, 0 h le week-end par défaut) ; l'en-tête grise les colonnes du samedi et du dimanche ; pas de réglage pour les masquer en P6 — RT-028, Q9.
- Toggle « Charge » (menu Affichage, état en mémoire, désactivé au rechargement) : la charge chiffrée de la personne (« 6 h » ou « 75 % ») s'affiche dans chaque colonne de temps ; la jauge de la colonne de gauche reste permanente — RT-030, Q11.

## Textes

- Indicateur temps réel minimaliste (RT-032, Q12) : puce verte **sans libellé** quand la connexion est bonne (nom accessible et infobulle « En direct : les changements de l'équipe apparaissent sans recharger la page ») ; puce orange + « Reconnexion… » ou puce rouge + « Hors connexion » dès qu'il y a un problème. Le changement d'état est annoncé (`aria-live="polite"`) ; la couleur n'est jamais seule à porter un problème.
- Les réponses de l'API portent des codes d'erreur ; l'UI traduit (ADR-003).
