# Direction visuelle WNEXT (D0, P6)

Statut : retenue, 2026-10-21. **Accent choisi par Alec : B, pétrole `#0E7490`** (Q-09 close) ; focus en encre.
Sources :
- références d'Alec dans `docs/recette/notes/2026-10-21-note-1/` (`ref-1` et `ref-3` sont la même image) ;
- retours RT-001 à RT-018 de `docs/recette/registre.md` ;
- contraintes du dossier §4.3 et de `docs/review/ux-ui.md` §2 et §3.

## Ce que montrent les références

Les trois images sont des captures de Float, l'écran Schedule et la vue équipe d'un projet. On en retient la **structure et l'ergonomie**, pas l'identité : le dossier §6 cite le risque IP (nom, DA, wording), et WNEXT ne vise pas la compatibilité avec Float.

| Observé | Ce qu'on en tire pour WNEXT | Retour lié |
|---|---|---|
| Barre latérale gauche claire : logo et nom de l'app, cloche avec son compteur, navigation à icônes au trait (Schedule, Projets, Personnes…), un groupe « données » repliable (rôles, clients…), l'avatar de l'utilisateur en bas | La coque WNEXT a un en-tête qui porte le nom de l'app et la navigation, avec l'utilisateur à droite comme le demande RT-003. Les référentiels sont regroupés sous Réglages. La barre latérale reste une variante possible au lot L-B | RT-001, RT-003, RT-012 |
| En-tête de l'écran : grand titre (« Schedule »), puis vues, filtre, ‹ ›, « Aujourd'hui », zoom, densité et un bouton + plein à droite | Sous-header de l'écran : titre de 20 px en 600, contrôles regroupés, une seule action primaire pleine (accent) à droite, le reste en boutons secondaires à bordure fine | RT-001, RT-015 |
| Lignes **aérées** (environ 6 personnes visibles) : avatar rond, nom en 500, rôle en gris, étiquette de lieu en pastille | La densité « aérée » de L-C. Pastille du département ou du lieu. Avatar à initiales si pas de photo | RT-005, RT-006 |
| Pourcentage d'utilisation par personne dans une pastille à droite du nom, en rouge au-delà de 100 %, et infobulle « 120 % utilized / 5h overtime » | Jauge et pourcentage sur la période visible (Q3). Le dépassement se montre par le texte, la couleur et une icône, jamais par la couleur seule | RT-008 |
| Blocs en couleur pleine et saturée, rayon d'environ 6 px, libellé « Projet / Client » sur plusieurs lignes, pastille « 80 % » ou « 6h » en bas à droite | Blocs de rayon 6 px, libellé sur 1 à 3 lignes selon la hauteur, pastille d'heures ou de % en chiffres tabulaires. Texte noir ou blanc calculé (déjà dans `block-colors.ts`) | RT-006 |
| Bloc non facturable ou tentatif : contour seul en pointillés, fond clair, texte de la couleur du projet | Correspond déjà au rendu tentatif de WNEXT (pointillés + hachures). On le garde | — |
| Congés et jours non ouvrés en **hachures** grises fines ; « Vacation » écrit dans la zone | Hachures légères pour les week-ends et les congés, et le libellé du type de congé dans la zone (US-5.1, RT-017) | RT-017 |
| Neutres froids (gris bleutés), fond blanc, séparateurs très légers, presque aucune ombre sauf autour de l'app | Même registre : fond `--bg` presque blanc, surfaces blanches, bordures à 1 px, ombre seulement sur les fenêtres superposées (RT-009) | RT-009 |
| Typographie sans serif géométrique douce, deux graisses visibles | Inter variable, en 400, 500 et 600 (dossier §4.3) | — |

## Principes retenus

1. **Calme autour, couleur dedans.** La couleur appartient aux projets, sur les blocs. L'interface autour reste neutre : l'accent ne sert qu'à l'action primaire, au focus et à la sélection.
2. **Aéré par défaut, dense à la demande.** Trois densités (Q1 : hauteurs fixes calibrées pour environ 12, 8 et 6 personnes visibles). La densité par défaut est l'intermédiaire, environ 8 personnes.
3. **Hiérarchie typographique nette** : titre d'écran en 20/28 et 600, nom en 13 ou 14 et 500, méta en 12 dans `--text-muted`, toutes les heures en tabulaire.
4. **Formes douces et sobres** : rayons de 6 px (blocs), 8 px (cartes, fenêtres) et 999 (avatars, pastilles). Pas d'ombre dans la grille.
5. **Fenêtres superposées**, jamais insérées dans le flux de la page : popover ancré au bloc pour l'édition rapide, modale pour les confirmations BR-04 et BR-10, tiroir pour les fiches projet et personne.
6. **Lisible sans la couleur** : dépassement signalé par une icône et « +5 h », tentatif par des pointillés et des hachures, congé par des hachures et un libellé.

## Accent de marque (Q-09) : 4 candidats

Contraintes :
- au moins 4,5:1 en texte sur blanc ;
- distinct de `--cap-ok` (vert `#1E8E3E`), de `--cap-warn` (orange) et de `--cap-over` (rouge) ;
- **distinct du bleu vif de Float**, à cause du risque IP ;
- pas confondu avec le bleu `--focus` actuel (`#1D4ED8`) : si l'accent est bleu, on redéfinit le focus.

| Candidat | Valeur (clair) | Texte sur accent | Caractère |
|---|---|---|---|
| A — Indigo | `#4F46E5` | blanc | Technique, moderne, assez proche des outils SaaS ; à distinguer du focus |
| B — Pétrole | `#0E7490` | blanc | Calme et professionnel ; assez loin du vert `--cap-ok` (teinte cyan) |
| C — Prune | `#7C3AED` | blanc | Identité marquée et peu courante dans la catégorie ; vigilance avec les projets violets |
| D — Encre | `#1F2937` (et l'actuel `#334155`) | blanc | Monochrome, éditorial : la seule couleur vient des projets ; très sobre |

`comparatif-accents.html` applique chaque candidat à une maquette du Schedule (en-tête, sous-header, lignes aérées, blocs, popover d'édition) et affiche les contrastes calculés. Alec choisit, puis l'accent remplace la valeur provisoire dans `apps/web/src/design/tokens.css`.
