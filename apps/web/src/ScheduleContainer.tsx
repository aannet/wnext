// Conteneur du Schedule branché sur l'API : abonne l'écran à la source de données (schedule-source), affiche le
// chargement, les erreurs (codes stables de @wnext/contracts, traduits ici) et un statut discret du temps réel.
// La source est créée par l'appelant (main.tsx) : le conteneur la démarre au montage et l'arrête au démontage.
// Il porte aussi l'historique d'annulation de la session (schedule/history), abonné aux changements étrangers de la source.
// Repères de page (axe landmark-one-main, page-has-heading-one, region) : tout le contenu, barre d'outils comprise, est
// dans <main>, titré par un <h1> visuellement masqué (traduit).
import type { I18n } from "@lingui/core";
import { todayIn, viewAt } from "@wnext/engine";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { ImportSource } from "./data/import-source";
import { ImportDialog } from "./imports/import-dialog";
import type { NotificationsSource } from "./data/notifications-source";
import { NotificationBell, NotificationsPanel } from "./notifications/notifications-ui";
import type { ScheduleSource, ScheduleSourceState, SourceErrorCode } from "./data/schedule-source";
import type { ViewsSource } from "./data/views-source";
import type { MessageKey } from "./i18n";
import { ScheduleScreen } from "./ScheduleScreen";
import { historyForSource } from "./schedule/history";
import { GUTTER_PX } from "./schedule/scroller";

export interface ScheduleContainerProps {
  i18n: I18n;
  source: ScheduleSource;
  /** Vues sauvegardées ; absent : pas de barre de vues. */
  views?: ViewsSource;
  /** Horloge (tests) ; la date du jour est calculée dans le fuseau du compte dès qu'il est connu, et revérifiée chaque minute. */
  now?: () => Date;
  widthPx: number;
  heightPx: number;
  /** Session OIDC : affiche « Se déconnecter » (absent en mode dev, sans session à fermer). */
  onLogout?: () => void;
  /** Import CSV (US-1.2) : bouton « Importer » dans la barre d'état ; absent (rôle sans droit d'import) : pas de bouton. */
  imports?: ImportSource;
  /** Notifications in-app (US-7.3) : cloche dans la barre d'état ; absent : pas de cloche. */
  notifications?: NotificationsSource;
}

const SHOWN_ERRORS = new Set<SourceErrorCode>(["UNAUTHENTICATED", "FORBIDDEN", "RATE_LIMITED"]);
const errorKey = (code: SourceErrorCode): MessageKey => `schedule.error.${SHOWN_ERRORS.has(code) ? code as "UNAUTHENTICATED" : "INTERNAL_ERROR"}`;
const realtimeKey = (s: ScheduleSourceState["realtime"]): MessageKey =>
  s === "live" ? "schedule.realtime.live" : s === "stopped" ? "schedule.realtime.offline" : "schedule.realtime.reconnecting";

/** Période de vérification du changement de jour (onglet laissé ouvert la nuit). */
const TODAY_CHECK_MS = 60_000;
const systemNow = () => new Date();

export function ScheduleContainer({ i18n, source, views, now = systemNow, widthPx, heightPx, onLogout, imports, notifications }: ScheduleContainerProps) {
  const t = (k: MessageKey) => i18n._(k);
  const state = useSyncExternalStore(source.subscribe, source.getState);
  const timezone = state.data?.account.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const [today, setToday] = useState(() => todayIn(timezone, now()));
  const undo = useMemo(() => historyForSource(source), [source]);
  useEffect(() => undo.connect(), [undo]);

  useEffect(() => {
    // Même date : React ignore la mise à jour (aucun rendu) ; nouvelle date : poussée à l'écran sans recréer la grille.
    const check = () => setToday(todayIn(timezone, now()));
    check();
    const id = setInterval(check, TODAY_CHECK_MS);
    return () => clearInterval(id);
  }, [timezone, now]);

  useEffect(() => {
    // Vue initiale identique à celle de l'écran (jour, centrée sur aujourd'hui, zone de dates après la colonne des noms) :
    // le premier chargement n'attend pas le rendu.
    source.setViewport(viewAt(today, "day", widthPx - GUTTER_PX));
    source.start();
    return () => source.stop();
  }, [source]);

  const status = (
    <span role="status" className={`wn-realtime wn-realtime-${state.realtime}`}>{t(realtimeKey(state.realtime))}</span>
  );
  const error = state.error && <div role="alert" className="wn-error">{t(errorKey(state.error))}</div>;

  const title = <h1 className="wn-visually-hidden">{t("app.title")}</h1>;
  const logout = onLogout && <button type="button" className="wn-logout" onClick={onLogout}>{t("auth.logout")}</button>;
  const [importing, setImporting] = useState(false);
  const importButton = useRef<HTMLButtonElement>(null);
  const closeImport = () => { setImporting(false); importButton.current?.focus(); };
  const [notifying, setNotifying] = useState(false);
  const bell = useRef<HTMLButtonElement>(null);
  const closeNotifications = () => { setNotifying(false); bell.current?.focus(); };

  if (!state.data) {
    return (
      <main className="wn-schedule-container" aria-busy={state.loading}>
        {title}
        {error ?? <div className="wn-loading">{t("schedule.loading")}</div>}
        {status}
        {logout}
      </main>
    );
  }
  return (
    <main className="wn-schedule-container" aria-busy={state.loading}>
      {title}
      <div className="wn-statusbar">
        {status}
        {state.loading && <span className="wn-loading">{t("schedule.loading")}</span>}
        {notifications && <NotificationBell i18n={i18n} source={notifications} open={notifying} buttonRef={bell} onToggle={() => (notifying ? closeNotifications() : setNotifying(true))} />}
        {imports && <button ref={importButton} type="button" className="wn-import-open" aria-haspopup="dialog" onClick={() => setImporting(true)}>{t("import.open")}</button>}
        {logout}
      </div>
      {error}
      {notifications && notifying && <NotificationsPanel i18n={i18n} source={notifications} onClose={closeNotifications} />}
      {imports && importing && <ImportDialog i18n={i18n} source={imports} onClose={closeImport} />}
      <ScheduleScreen i18n={i18n} data={state.data} today={today} widthPx={widthPx} heightPx={heightPx} onViewChange={source.setViewport}
        editor={undo.history.editor} history={undo.history} records={source} {...(views ? { views } : {})} />
    </main>
  );
}

/** Connexion OIDC impossible (state invalide, fournisseur injoignable, échange refusé) : message et nouvel essai. */
export function AuthFailure({ i18n, onRetry }: { i18n: I18n; onRetry: () => void }) {
  return (
    <main className="wn-schedule-container">
      <h1 className="wn-visually-hidden">{i18n._("app.title")}</h1>
      <div role="alert" className="wn-error">{i18n._("auth.error")}</div>
      <button type="button" onClick={onRetry}>{i18n._("auth.retry")}</button>
    </main>
  );
}
