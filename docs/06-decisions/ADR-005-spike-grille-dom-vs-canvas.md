# ADR-005 — Spike grille Schedule : DOM virtualisé (A) vs canvas (B), et choix i18n

Statut : **accepté** (décision d'Alec, 2026-10-19) : **DOM virtualisé optimisé (A2)** pour le Schedule, canvas en repli seulement si le banc P3 sur un poste réel rate le budget ; **Lingui** pour l'i18n (§ i18n, réserves (a) à (d) à vérifier à la mise en place). Les résultats de spike ci-dessous restent indicatifs.
Complète : ADR-002 (§6 blocs, « Spike à lancer avant P1 »), `docs/factory/strategy.md` (critères P3 : 300 x 12 mois, scroll p95 >= 50 fps, interaction < 100 ms).
Code et données brutes : `spikes/grille/` (jetable, hors production). Rien n'a été publié en ligne.

## 1. Hypothèse

Une grille 300 personnes x 365 jours, avec blocs multi-jours à hauteur variable (hauteur = % de capacité, empilement vertical), drag / resize, zoom jour/semaine/mois et bouton « Aujourd'hui », tient le budget :
- défilement p95 >= 50 images/s (frame p95 <= 20 ms) ;
- interaction < 100 ms (ADR-002 §5 : INP p95 < 100 ms, zoom < 150 ms, drag/resize à 60 i/s).

Option **A** (proposition de l'ADR-002) : moteur de layout TypeScript pur + blocs en DOM, virtualisés. Option **B** : rendu canvas. A a été réalisée en premier ; **B a été réalisée aussi** parce que les mesures de A sont ambiguës (passe sur la machine de test, échoue dès que le CPU est ralenti, voir §4).

## 2. Ce qui a été construit

Même moteur `src/engine.ts` pour A et B (pur, sans DOM) : génération seedée (seed 42, 13 948 allocations, 1 à 15 jours, 25 à 100 % de capacité, ~20 % de chevauchements), empilement glouton, détection de sur-allocation (▲).

| | A (DOM) `src/main.ts` | B (canvas) `src/main-canvas.ts` |
|---|---|---|
| Lignes | virtualisées par `Virtualizer` de `@tanstack/virtual-core` | calcul direct des lignes visibles |
| Colonnes | **fenêtre manuelle** (pas de second `Virtualizer`) : blocs hors fenêtre +-800 px retirés | blocs hors viewport ignorés |
| Rendu | un `div` par bloc visible, en-tête reconstruit à chaque scroll | un `<canvas>` sticky à la taille du viewport, redessiné à chaque frame de scroll |
| Gestes | pointer events (déplacer, étirer à droite et à gauche, hauteur) | hit-test manuel (déplacer, étirer à droite, hauteur) |
| Non réalisé | accessibilité (`role=grid`), clavier, tactile, undo, DPR > 1, édition sur place | idem, plus étirement à gauche, texte riche |

A n'est **pas optimisé** (réécriture de `style.cssText` des blocs, `innerHTML` de l'en-tête à chaque frame). B n'a pas de mise à l'échelle DPR.

## 3. Méthode

- Playwright 1.64.1, Chromium 156 headless (bundle Playwright), build de production (`vite build` + `vite preview`), viewport 1600 x 900, un contexte neuf par run, **5 runs** par configuration, médiane [min-max] rapportée.
- Défilement : 4 s par axe (horizontal 24 px/frame, vertical 18 px/frame, diagonal), piloté dans la page par `requestAnimationFrame` ; temps inter-frames mesuré par rAF ; « coût render » = durée de la fonction `render()` (JS seul).
- Drag / resize / hauteur : vrais événements souris Playwright (`mouse.move` toutes les ~16 ms, 120 pas). « événement -> rendu » = `performance.now() - event.timeStamp` en fin du handler (JS, **hors paint**). Event Timing API (`PerformanceObserver type:'event'`, résolution 8 ms, seuil 16 ms) pour l'INP approximé.
- Zoom (3 niveaux) et « Aujourd'hui » : 6 cycles ; durée clic -> 2 `requestAnimationFrame` (inclut donc ~33 ms de quantification vsync).
- Mémoire : `JSHeapUsedSize` via CDP après GC. Ralentissement CPU simulé : `Emulation.setCPUThrottlingRate` x1, x4, x6.
- Scripts : `bench/run.mjs` (`VARIANT=A|B THROTTLE=n RUNS=5`), `bench/summarize.mjs` ; JSON bruts dans `results/`.

**Machine et conditions** : Intel i7-10750H (6 coeurs / 12 threads), 15 Go, WSL2 (noyau 6.6.87.2), Chromium headless, **sans GPU** : le rendu GL passe par SwiftShader (logiciel). Une seule machine, une seule session, le même jour. Ces chiffres ne valent pas pour un poste réel avec GPU et écran haute densité.

## 4. Mesures brutes (médiane [min-max] sur 5 runs, ms sauf mention)

### Premier rendu, mémoire, DOM

| Mesure | A x1 | A x4 | A x6 | B x1 | B x4 | B x6 |
|---|---|---|---|---|---|---|
| Premier rendu (donnees + 2 rAF) | 74.8 [72.5-76.3] | 319 [283-339] | 453 [419-497] | 51.9 [30.4-53.4] | 168 [157-210] | 244 [216-343] |
| Heap JS initial (Mo) | 2.6 | 2.6 | 2.6 | 2.4 | 2.4 | 2.4 |
| Heap JS final (Mo) | 3.5 | 3.5 | 3.5 | 3.3 | 3.3 | 3.3 |
| Noeuds DOM (initial / apres scroll) | 982 / 1235 | 982 / 1286 | 982 / 975 | 16 / 16 | 16 / 16 | 16 / 16 |

Génération des données : ~11 ms (x1). Le heap ne contient que le modèle (14 k objets) ; il ne reflète pas la mémoire native (DOM, bitmaps), non mesurée.

### Défilement (frame p95, part de frames > 20 ms, coût `render()` p95)

| Mesure | A x1 | A x4 | A x6 | B x1 | B x4 | B x6 |
|---|---|---|---|---|---|---|
| H : frame p95 | 16.8 | 66.6 [50.1-66.7] | 99.9 | 16.7 | 16.7 | 16.7 |
| H : part > 20 ms | 0 | 100 % | 100 % | 0 | 0 | 0 |
| H : coût render p95 | 6.5 [5.9-6.7] | 34.7 | 59.2 | 0.6 | 2.4 | 3.1 |
| V : frame p95 | 16.8 [16.7-33.3] | 66.7 | 116.6 | 16.7 | 16.7 | 16.7 |
| V : coût render p95 | 8.0 [7.5-16.7] | 44.8 | 67.9 | 0.6 | 2.3 | 3.2 |
| Diag. : frame p95 | 16.7 | 66.7 | 100.0 | 16.7 | 16.8 | 16.7 |
| Diag. : coût render p95 / max | 8.1 / 10.2 | 42.3 / 47.9 | 66.3 / 86.2 | 0.5 / 0.7 | 2.2 / 3.4 | 3.1 / 4.2 |
| Diag. : longtasks (> 50 ms) | 0 | 35 [25-47] | 47 | 0 | 0 | 0 |

Lecture : à x1 les deux options sont au plafond de 60 i/s (16.7 ms, quantification vsync headless : la frame p95 ne discrimine pas, le coût `render()` si). Fps p95 équivalent : A x1 ~59.9, A x4 ~15 (0 % de frames sous 20 ms), A x6 ~10 ; B ~60 partout.

### Drag, resize, hauteur

| Mesure | A x1 | A x4 | A x6 | B x1 | B x4 | B x6 |
|---|---|---|---|---|---|---|
| Drag : frame p95 | 16.7 | 16.7 | 16.7 | 16.8 | 16.7 | 16.8 |
| Drag : événement -> fin du handler p95 | 11.9 | 21.1 [0.0-21.5] | 21.2 | 12.9 | 9.4 [8.5-18.1] | 20.2 |
| Drag : Event Timing max | 24 | 32 | 32 [32-48] | 16 | 24 | 32 |
| Resize droite : Event Timing max | 24 [16-24] | 32 [16-72] | 32 [32-40] | 16 | 24 | 32 |
| Hauteur : événement -> handler p95 | 11.9 | 0.0 [0.0-20.9] | 15.9 | 12.9 | 17.9 | 20.1 |

Anomalies à signaler : dans A, `renderCost` n'est pas enregistré pendant le drag (le drag appelle `drawRow`, pas `render()`), donc aucun coût de rendu de drag n'est rapporté pour A ; les valeurs « 0.0 » d'événement -> handler (A x4, résize/hauteur) viennent de l'écart entre `event.timeStamp` et `performance.now()` sous throttling et sont **peu fiables**. Le drag d'A reste sous 100 ms et à ~60 i/s dans toutes les configurations testées, mais la métrique est grossière (le drag ne re-layoute qu'une ou deux lignes de ~25 blocs).

### Zoom, « Aujourd'hui », INP approximé

| Mesure | A x1 | A x4 | A x6 | B x1 | B x4 | B x6 |
|---|---|---|---|---|---|---|
| Zoom : clic -> 2 rAF p50 / max | 50.9 / 77.4 [max 76-150] | 240 / 358 | 405 / 582 | 28.6 / 29.3 | 24.5 / 27.7 | 26.2 / 34.5 |
| Aujourd'hui : p50 / max | 28.3 / 30.4 | 117 / 134 | 189 / 229 | 28.7 / 28.9 | 25.3 / 26.8 | 23.6 / 25.9 |
| Event Timing du clic, max (INP approx.) | 88 [88-168] | 376 [344-400] | 600 | 16 | 32 [24-72] | 40 |

A fait un zoom en détruisant puis recréant toutes les lignes visibles (non optimisé). Un run A x1 a mesuré 168 ms d'Event Timing sur un clic de zoom et 150 ms de zoom max : instable.

## 5. Comparaison à l'objectif

| Critère | A x1 | A x4 | B x1 / x4 / x6 |
|---|---|---|---|
| Scroll p95 >= 50 i/s | oui (coût render 6.5-8 ms p95, sur 16.7 de budget, hors style/layout/paint) | **non** (~15 i/s, longtasks) | oui |
| Drag / resize < 100 ms et 60 i/s | oui (mesure grossière) | oui | oui |
| Zoom < 150 ms | oui, mais max 150 ms observé | **non** (240 ms p50) | oui |
| INP du clic < 100 ms | oui en médiane (88), un run à 168 | **non** | oui |

## 6. Limites de la mesure

- Une machine, WSL2, headless, SwiftShader, sans écran réel : le **paint et le composite GPU ne sont pas représentatifs** (en réel le canvas peut coûter plus ou moins en raster, notamment avec DPR 2 ; le DOM profite du compositing GPU).
- La fréquence de frames est quantifiée à 60 Hz par le headless : la frame p95 ne montre pas la marge réelle ; seul le ralentissement CPU simulé (x4, x6) la révèle. `setCPUThrottlingRate` est une approximation du CPU lent, pas d'un vrai appareil.
- Le coût `render()` de A ne comprend pas style/layout/paint du navigateur, donc sous-estime le coût réel ; celui de B ne comprend pas le raster du canvas.
- Défilement scripté (pas de molette / trackpad / inertie réels), 4 s par essai ; pas de test avec 500+ lignes, ni 36 mois, ni des rangées plus denses.
- Scénarios de drag simples ; pas de détection de collision sur toute la grille ; pas de temps réel (WebSocket) ni d'UI complète autour.
- A non optimisé, B sans DPR/texte riche/accessibilité : **la comparaison de coût est donc favorable à B en mesure, défavorable à B en fonctionnalités**. Mesure d'INP via Event Timing à 8 ms de résolution, pas l'INP de production.
- Pas de mesure sur Firefox / Safari.

## 7. Second tour (A optimisé, B complet, B + overlay a11y)

Conditions : DPR 2, ralentissement CPU x1 / x4 / x6 (proxy du poste lent, **le poste de référence P3 n'est pas défini**), Chromium headless, i7-10750H, WSL2, SwiftShader sans GPU, 5 runs. Données brutes : `spikes/grille/results/r2-*.json` ; synthèse : `node spikes/grille/bench/summarize2.mjs`.

- **A2** : DOM virtualisé optimisé. **B2** : canvas complet (DPR 2). **B3** : canvas + overlay DOM `role=grid` (fenêtre visible).

| Mesure (médiane) | A2 x1 / x4 / x6 | B2 x1 / x4 / x6 | B3 x1 / x4 |
|---|---|---|---|
| Scroll horizontal, i/s p95 | 59,9 / 59,5 / 59,5 | 59,5 / **15** / **10** | 59,9 / **15** |
| Scroll vertical, i/s p95 | 59,9 / 59,9 / 59,9 | 59,5 / **15** / **10** | 59,9 / **15** |
| Scroll diagonal, i/s p95 | 59,9 / 59,5 / **29,9** | 59,9 / 15 / 10 | 59,5 / 15 |
| Longtasks cumulées en scroll | 0 ms (x6 diagonal : 104 ms) | ~4 000 ms à x4 et x6 | ~4 000 ms à x4 |
| Coût JS de rendu en drag, p95 | 0,2 / 1,0 / 1,5 ms | 0,3 / 1,1 / 1,8 ms | 0,4 / 1,5 ms |
| Zoom, p50 | 28 / 87 / 137 ms | 28 / 32 / 37 ms | 29 / 44 ms |
| Clic, Event Timing max | 104 / 184 / 224 ms | 24 / 40 / 64 ms | 24 / 88 ms |
| Premier rendu | 56 / 249 / 338 ms | 74 / 311 / 462 ms | 77 / 326 ms |
| Nœuds DOM après scroll | 548 / 546 / 540 | 17 | ~220 à 250 (dont ~200 à 230 overlay) |

Lecture :
- **Renversement par rapport au premier tour.** Une fois optimisé, A tient ~60 i/s en scroll horizontal et vertical jusqu'à x6 ; seule la diagonale à x6 passe à ~30 i/s. À DPR 2, B s'effondre au scroll (15 i/s à x4, 10 i/s à x6) alors que son coût JS de rendu reste faible (≤ 2,5 ms) : le temps est perdu hors JS, très probablement dans la rastérisation d'un canvas à DPR 2 **en rendu logiciel (SwiftShader)**. Cette cause n'est pas prouvée ; sur un poste avec GPU, le résultat peut être très différent.
- B garde l'avantage sur le zoom et le clic.
- Le surcoût de l'overlay d'accessibilité est faible (~200 nœuds, 0,1 à 1,1 ms de JS au scroll).

Limites propres à ce tour : une machine, headless, sans GPU ; **B3 à x6 non mesuré** ; la métrique de clic (Event Timing, résolution 8 ms) est grossière (104 ms dès x1 pour A2) ; **les vérifications d'accessibilité automatisées (`bench/a11y.mjs`) n'ont pas de résultat enregistré** et aucun lecteur d'écran réel n'a été testé ; le coût de rendu de A pendant le drag est désormais enregistré (colonne « drag »).

## 8. Recommandation (mise à jour après le second tour)

1. **Choix par défaut : DOM virtualisé optimisé (A2).** Il tient le budget de scroll jusqu'à x6 sans GPU, l'accessibilité (`role=grid`, focus, lecteurs d'écran) y est native, et un seul moteur de rendu est à maintenir. Point faible à surveiller : scroll diagonal à x6 (~30 i/s) et clic (max 224 ms à x6).
2. **Le canvas est le repli**, à n'envisager que si le banc P3 sur un poste réel avec GPU montre que A2 rate le budget. Dans ce cas, le canvas devra être mesuré sur ce même poste (le résultat défavorable de B ci-dessus est possiblement dû à l'absence de GPU).
3. Le moteur de layout TypeScript pur (commun à A et B) reste valable et indépendant du choix de rendu.
4. **Décision à confirmer** lors du benchmark de la phase P3 : fixer un poste de référence (CPU, RAM, GPU) et y mesurer A2. Ce choix amende ADR-001 n°9 (« canvas + overlay DOM ») et confirme la direction DOM d'ADR-002.

## 9. Recommandation du premier tour (périmée, conservée pour trace)

> Remplacée par la section 8 : elle reposait sur un A non optimisé et un B sans DPR 2 ni accessibilité.

1. **Le DOM seul (A) ne tient pas le budget de façon robuste** : il passe sur une machine de développement rapide (marge d'un facteur ~2 sur le coût JS de rendu) et échoue à x4 de ralentissement CPU, sur le scroll, le zoom et l'INP du clic. Ces chiffres ne prouvent pas que des optimisations (réutilisation des nœuds, suppression des réécritures de style, transform au lieu de left/top, en-tête par canvas ou CSS) ne suffiraient pas ; **elles n'ont pas été essayées**.
2. **Le canvas (B) a un coût de rendu environ 10x plus faible et une courbe plate** sous ralentissement, au prix de l'accessibilité et de l'édition sur place, que l'ADR-002 §6 cherchait à préserver.
3. Recommandation : **conserver l'architecture de l'ADR-001 n°9 « canvas + overlay DOM »** (qui est aussi celle de la phase P3 de la factory) : grille et blocs en canvas ; DOM uniquement pour le bloc focalisé / en édition, les poignées, le popover, et un arbre `role=grid` / `aria` réduit pour les lecteurs d'écran. Le moteur de layout TypeScript pur (commun à A et B dans ce spike) reste valable tel quel. Le choix final dépend du **poste cible** : si le plancher matériel est un poste rapide avec GPU, un A optimisé reste envisageable et plus simple pour l'accessibilité.
4. À faire avant P3 (non fait ici) : mesurer sur un vrai poste avec GPU et DPR 2, essayer un A optimisé avec le même banc (`bench/run.mjs`), tester le canvas avec accessibilité, 500+ personnes et 36 mois. Fixer un matériel de référence dans le critère P3 : « 60 fps » sans machine de référence n'est pas vérifiable.

## 10. Bibliothèques : versions et licences (vérifiées le 2026-10-18 via `npm view`)

| Paquet | Version | Licence |
|---|---|---|
| vite | 8.3.4 | MIT |
| typescript | 7.0.2 | Apache-2.0 |
| @playwright/test | 1.64.1 | Apache-2.0 |
| @tanstack/virtual-core | 3.19.6 | MIT (fichier LICENSE lu) |
| react-intl | 12.1.4 | BSD-3-Clause |
| @formatjs/intl | 6.1.3 | MIT |
| @formatjs/cli / eslint-plugin-formatjs | 6.16.34 / 8.1.1 | MIT |
| @lingui/core, react, cli | 6.10.0 | MIT (LICENSE de core lu) |
| @lingui/swc-plugin / @lingui/vite-plugin | 6.7.1 / 6.10.0 | MIT |

Toutes permissives. Le moteur de layout, lui, n'a aucune dépendance. Les licences sont celles déclarées par le registre npm ; seuls les fichiers LICENSE de TanStack, Playwright, TypeScript, Vite et `@lingui/core` ont été ouverts, pas ceux des dépendances transitives.

## 11. i18n : FormatJS vs Lingui

Sources : `npm view`, API de téléchargements npm, bundles de test construits dans un dossier temporaire (hors dépôt). Fichiers de test jetables, ne pas les considérer comme un benchmark.

| Critère | FormatJS (`react-intl` 12.1.4 / `@formatjs/intl` 6.1.3) | Lingui (6.10.0) |
|---|---|---|
| Format de message | ICU MessageFormat (parseur `@formatjs/icu-messageformat-parser`) | ICU MessageFormat (compilé à la build en tableaux) |
| Poids mesuré, minifié, brut / gzip, bundle Vite jetable, message pluriel + variable + date | noyau `@formatjs/intl` : 62.0 Ko / 14.7 Ko ; avec React (`IntlProvider` + `FormattedMessage`) : 367.5 Ko / 92.3 Ko, dont React seul 297.5 Ko / 75.6 Ko, soit **~16.7 Ko gzip** pour FormatJS | noyau `@lingui/core` : 7.2 Ko / 2.7 Ko ; avec React (`I18nProvider` + `Trans`) : 310.1 Ko / 79.8 Ko, soit **~4.2 Ko gzip** |
| Caveat sur le poids | message ICU en **chaîne**, parseur embarqué ; une précompilation en AST (existe selon mes connaissances, **non vérifiée ni testée ici**) réduirait ce poids | messages écrits à la main au format compilé de Lingui (non produits par `lingui compile`) : ordre de grandeur, pas une mesure de bout en bout |
| Extraction / lint | `@formatjs/cli`, `eslint-plugin-formatjs` (existent, MIT, publiés 2026-10) ; règles de lint « pas de chaîne en dur » : **non vérifiées** | `@lingui/cli` (extraction/compilation) ; `pseudolocale` listé dans ses dépendances ; lint « pas de chaîne en dur » : **non vérifié** |
| Pseudo-localisation | non vérifiée dans ce spike | présente (dépendance `pseudolocale` du CLI), fonctionnement non testé |
| Outillage build | plugins `babel-plugin-formatjs`, `@formatjs/ts-transformer` | macros via Babel ou `@lingui/swc-plugin` / `@lingui/vite-plugin` : **intégration à Vite non testée** |
| Maintenance (dates `time.modified` du registre) | `react-intl` 2026-10-05, `@formatjs/cli` 2026-10-09 | `@lingui/core` 2026-10-16, `@lingui/swc-plugin` 2026-10-08 |
| Téléchargements npm, semaine du 2026-10-10 au 16 | `react-intl` 1 774 423 ; `@formatjs/intl` 1 929 614 | `@lingui/core` 1 059 812 |
| React | peer `react >= 18` | peer `react` 16.14 à 19 |
| Licence | BSD-3-Clause (react-intl), MIT | MIT |

Lecture, limitée à ce qui est vérifié : les deux sont maintenus activement et permissifs ; Lingui est nettement plus léger au runtime dans nos bundles de test (avec la réserve de la précompilation FormatJS non testée), FormatJS a plus de téléchargements et un écosystème d'outils plus large. **Recommandation provisoire : Lingui**, pour le poids runtime et les messages précompilés, **sous réserve** de vérifier avant P1 : (a) intégration macro/SWC/Vite avec la chaîne de build retenue, (b) règle de lint « pas de chaîne en dur » exigée par ADR-002 §4, (c) test de pseudo-localisation en CI, (d) rendu des pluriels FR/EN et formats `Intl` dans un vrai composant. Si (a) ou (b) échoue, FormatJS reste l'alternative sûre. Le moteur de layout n'a pas de chaîne de texte (ADR-003 : codes d'erreur, pas de chaînes UI), donc le choix i18n ne touche que la couche web.
