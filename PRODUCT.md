# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

Déjà fixée par le dépôt, pas de question ouverte : React + Vite (`apps/web`), Tailwind et tokens de design (ADR-009), Lingui pour l'i18n (ADR-005), API `node:http` + `pg` (`apps/api`), contrats `packages/contracts` (ADR-003).

## Users

Équipes de livraison des agences de 20 à 100 personnes, surtout créa et marketing : PMO, resource managers, ops et finance. Le tableur est le concurrent n°1. Le produit ne vise pas les 10–500 personnes tous secteurs avant ce lancement.

## Product Purpose

Planning de ressources (personnes × projets × dates) avec capacité calculée : qui est disponible, sur quoi, et où il y a surbooking. Le planning est le système de vérité de la livraison. Succès visé : placer quelqu'un sur un projet en moins de 10 secondes sans surbooker personne (North star UX du dossier, à instrumenter).

## Positioning

Une capacité calculée avec congés et jours fériés intégrés d'emblée, et fiable : un chiffre faux détruit la confiance. S'y ajoutent la vitesse de placement et, plus tard, le lien planning → temps réel → marge dans un seul système. Le produit ne remplace ni le CRM, ni l'outil de gestion de tâches, ni le back-office finance.

## Operating Context

Le planning se pilote en vue Schedule (personnes × jours, semaines, mois), souvent à la souris, au clavier et au tactile. Les mises à jour doivent apparaître en temps réel chez tous les clients connectés. Les alternatives sans glisser-déposer et la vue Liste/Table sont des usages réels, pas des options.

## Capabilities and Constraints

- MVP T1 : Schedule et capacité (allocations, congés, fériés, tentatif vs confirmé). Projets au socle ; budgets, temps réel vs planifié et rapports en T2–T3.
- Règles qui s'imposent à toute l'interface : BR-01 (surbooking signalé, jamais bloqué), BR-04 (congé sur allocations : avertissement et report assisté, pas de suppression silencieuse), BR-10 (retrait d'une personne d'un projet : confirmation avec résumé), BR-07 (heures tentatives comptées à part).
- Mobile : web responsive d'abord, pas d'application native avant T3.
- Facturation du produit exclue (ADR-004), pas de plans ni de sièges dans l'interface.
- Langue par défaut : français ; anglais à la sortie (i18n dès le départ, aucune chaîne en dur).
- Non décidé : pays et langues de lancement au-delà du FR et de l'EN, hébergement UE obligatoire, tarification (valeurs Float à revérifier).

## Brand Commitments

Le nom WNEXT est définitif. Aucune voix de marque imposée à ce stade. Float est une référence d'ergonomie, pas un modèle à copier : pas de nom, ni de direction artistique (vert fluo) de Float, ni d'argument de compatibilité API.

## Evidence on Hand

Aucune preuve réelle à ce jour : pas de clients, pas de témoignages, pas de chiffres produit. Ne jamais inventer de citation, de client, de taux d'efficacité ou de benchmark. Les chiffres cités dans le dossier concernent Float et doivent être traités comme des références externes.

## Product Principles

- Vitesse avant tout : le placement doit rester plus rapide que le tableur.
- Un chiffre de capacité doit être juste, ou ne pas être affiché.
- Aucune action destructive silencieuse : avertir, proposer, confirmer.
- Chaque geste de glisser-déposer a une alternative clavier et tactile.
- S'intégrer aux outils existants (CRM, gestion de tâches, finance) au lieu de les remplacer.

## Accessibility & Inclusion

WCAG 2.2 AA exigé dès le MVP : contraste texte 4,5:1, éléments d'interface 3:1, indication non chromatique (tentatif, surbooking), focus visible, annonces `aria-live` pour sauvegarde, rollback et temps réel, vue Liste/Table comme alternative lecteur d'écran, axe-core en CI.
