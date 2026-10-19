// Catalogue de référence (FR). Identifiants explicites, syntaxe ICU ; apostrophe typographique (’) pour ne pas
// déclencher l'échappement ICU. Toute chaîne visible de apps/web vient d'ici (lint : npm run lint:ui-strings).
export const fr = {
  "app.title": "Planning",
  "schedule.grid.label": "Planning des personnes",
  "schedule.toolbar.label": "Navigation dans le planning",
  "schedule.today": "Aujourd’hui",
  "schedule.prev": "Période précédente",
  "schedule.next": "Période suivante",
  "schedule.zoom.label": "Zoom",
  "schedule.zoom.day": "Jour",
  "schedule.zoom.week": "Semaine",
  "schedule.zoom.month": "Mois",
  "schedule.people.count": "{count, plural, one {# personne} other {# personnes}}",
  "schedule.loading": "Chargement…",
} as const;

export type MessageKey = keyof typeof fr;
