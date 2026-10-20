// Catalogue anglais : mêmes clés que le catalogue FR, imposé par le type.
import type { MessageKey } from "./messages.fr";

export const en: Record<MessageKey, string> = {
  "app.title": "Schedule",
  "schedule.grid.label": "People schedule",
  "schedule.toolbar.label": "Schedule navigation",
  "schedule.today": "Today",
  "schedule.prev": "Previous period",
  "schedule.next": "Next period",
  "schedule.zoom.label": "Zoom",
  "schedule.zoom.day": "Day",
  "schedule.zoom.week": "Week",
  "schedule.zoom.month": "Month",
  "schedule.people.count": "{count, plural, one {# person} other {# people}}",
  "schedule.capacity.none": "{period}: no capacity, nothing planned",
  "schedule.capacity.cell": "{period}: {planned, number} h planned of {capacity, number} h capacity{tentative, plural, =0 {} other {, of which # h tentative}}{over, plural, =0 {} other {, overload of # h}}{days, plural, =0 {} =1 {} other { over # days}}",
  "schedule.loading": "Loading…",
  "schedule.error.UNAUTHENTICATED": "Your session has expired or is missing: please sign in again.",
  "schedule.error.FORBIDDEN": "You do not have access to this schedule.",
  "schedule.error.RATE_LIMITED": "Too many requests: retrying shortly.",
  "schedule.error.INTERNAL_ERROR": "The schedule could not be loaded. Please try again later.",
  "schedule.realtime.live": "Live updates: connected",
  "schedule.realtime.reconnecting": "Live updates: reconnecting…",
  "schedule.realtime.offline": "Live updates: offline",
};
