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
  "schedule.capacity.none": "{period} : aucune capacité, rien de planifié",
  "schedule.capacity.cell": "{period} : {planned, number} h planifiées sur {capacity, number} h de capacité{tentative, plural, =0 {} other {, dont # h tentatives}}{over, plural, =0 {} other {, surcharge de # h}}{days, plural, =0 {} =1 {} other { sur # jours}}",
  "schedule.loading": "Chargement…",
  "schedule.error.UNAUTHENTICATED": "Session expirée ou absente : reconnectez-vous.",
  "schedule.error.FORBIDDEN": "Vous n’avez pas accès à ce planning.",
  "schedule.error.RATE_LIMITED": "Trop de requêtes : nouvel essai dans un instant.",
  "schedule.error.INTERNAL_ERROR": "Le planning n’a pas pu être chargé. Réessayez plus tard.",
  "schedule.realtime.live": "Temps réel : connecté",
  "schedule.realtime.reconnecting": "Temps réel : reconnexion…",
  "schedule.realtime.offline": "Temps réel : hors ligne",
} as const;

export type MessageKey = keyof typeof fr;
