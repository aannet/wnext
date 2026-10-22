// Notifications in-app (FR-10, US-7.3) : cloche de la barre d'état et panneau.
//  * Cloche : bouton « Notifications » avec le nombre de non lues ; le compteur est aussi annoncé (aria-live poli) quand il change,
//    y compris par le temps réel (message `notifications`).
//  * Panneau (popover ancré à la cloche ; Échap, clic extérieur ou « Fermer » le ferme et rend le focus à la cloche) : la liste, la plus récente d'abord,
//    « Marquer comme lue » par notification, « Tout marquer comme lu », et les préférences par type (désabonnement).
//  * Textes composés ici depuis le type et les compteurs regroupés du contrat (« 2 allocations créées · 1 allocation modifiée »).
import type { I18n } from "@lingui/core";
import type { Notification, NotificationType } from "@wnext/contracts";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { NotificationsSource } from "../data/notifications-source";
import { Button, PopoverPanel, PopoverTrigger } from "../design";
import type { MessageKey } from "../i18n";

const TYPES: readonly NotificationType[] = ["allocation_changed", "timeoff_decided", "edit_conflict"];
const COUNTERS = ["created", "updated", "deleted", "approved", "declined"] as const;
const ENTITIES = new Set(["allocations", "timeoffs", "people"]);

export function notificationText(i18n: I18n, n: Notification, day: (iso: string) => string): { title: string; details: string } {
  const t = (k: MessageKey, v?: Record<string, unknown>) => i18n._(k, v);
  const actor = n.actor?.name ?? t("notifications.someone");
  const entity = t(ENTITIES.has(n.entity) ? (`notifications.entity.${n.entity}` as MessageKey) : "notifications.entity.other");
  const title = t(`notifications.${n.type}`, { actor, entity });
  const parts = COUNTERS.filter((c) => n.counts[c] > 0).map((c) => t(`notifications.count.${c}`, { count: n.counts[c] }));
  if (n.startDate) parts.push(t("notifications.from", { date: day(n.startDate) }));
  return { title, details: parts.join(" · ") };
}

export function NotificationBell({ i18n, source, buttonRef }: {
  i18n: I18n; source: NotificationsSource; buttonRef: React.RefObject<HTMLButtonElement | null>;
}) {
  const state = useSyncExternalStore(source.subscribe, source.getState);
  useEffect(() => { void source.refresh(); }, [source]);
  const count = state.unreadCount;
  return (
    <>
      <PopoverTrigger ref={buttonRef} className="wn-notifications-open">
        {i18n._("notifications.open")}
        {count > 0 && <span className="wn-badge" aria-hidden="true">{count > 99 ? "99+" : count}</span>}
      </PopoverTrigger>
      <span className="wn-visually-hidden" aria-live="polite" data-testid="notifications-live">{i18n._("notifications.badge", { count })}</span>
    </>
  );
}

export function NotificationsPanel({ i18n, source, onClose }: { i18n: I18n; source: NotificationsSource; onClose(): void }) {
  const t = (k: MessageKey, v?: Record<string, unknown>) => i18n._(k, v);
  const state = useSyncExternalStore(source.subscribe, source.getState);
  const [busy, setBusy] = useState(false);
  const title = useRef<HTMLHeadingElement>(null);
  useEffect(() => { void source.refresh(); void source.loadPreferences(); title.current?.focus(); }, [source]);
  const day = useMemo(() => { const f = new Intl.DateTimeFormat(i18n.locale, { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" }); return (iso: string) => f.format(new Date(`${iso}T00:00:00Z`)); }, [i18n.locale]);
  const when = useMemo(() => new Intl.DateTimeFormat(i18n.locale, { dateStyle: "short", timeStyle: "short" }), [i18n.locale]);
  const run = async (fn: () => Promise<void>) => { setBusy(true); try { await fn(); } finally { setBusy(false); } };

  return (
    <PopoverPanel id="wn-notifications-panel" className="wn-notifications" labelledBy="wn-notifications-title" busy={busy}>
      <h2 id="wn-notifications-title" tabIndex={-1} ref={title}>{t("notifications.title")}</h2>
      {state.error && <p role="alert" className="wn-dialog-error">{t("notifications.error")}</p>}
      {state.loaded && state.items.length === 0 && <p>{t("notifications.empty")}</p>}
      {state.items.length > 0 && (
        <ul className="wn-notification-list">
          {state.items.map((n) => {
            const { title: head, details } = notificationText(i18n, n, day);
            const unread = n.readAt === null;
            return (
              <li key={n.id} className={unread ? "wn-notification wn-notification-unread" : "wn-notification"}>
                <p className="wn-notification-title">{head}</p>
                {details && <p className="wn-notification-details">{details}</p>}
                <p className="wn-notification-time">
                  <time dateTime={n.createdAt}>{when.format(new Date(n.createdAt))}</time>
                  {unread && <span className="wn-notification-flag">{t("notifications.unread")}</span>}
                </p>
                {unread && <Button size="sm" type="button" disabled={busy} onClick={() => void run(() => source.markRead(n.id))}>{t("notifications.markRead")}</Button>}
              </li>
            );
          })}
        </ul>
      )}
      <div className="flex gap-2">
        <Button disabled={busy || state.unreadCount === 0} onClick={() => void run(() => source.markAllRead())}>{t("notifications.markAllRead")}</Button>
        <Button onClick={onClose}>{t("notifications.close")}</Button>
      </div>
      {state.preferences && (
        <fieldset className="wn-notification-prefs">
          <legend>{t("notifications.prefs.legend")}</legend>
          {TYPES.map((type) => {
            const enabled = state.preferences!.find((p) => p.type === type)?.enabled ?? true;
            return (
              <label key={type}>
                <input type="checkbox" checked={enabled} disabled={busy} onChange={(e) => void run(() => source.setPreference(type, e.target.checked))} />
                {" "}{t(`notifications.prefs.${type}`)}
              </label>
            );
          })}
        </fieldset>
      )}
    </PopoverPanel>
  );
}
