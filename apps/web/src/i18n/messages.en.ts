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
  "schedule.loading": "Loading…",
};
