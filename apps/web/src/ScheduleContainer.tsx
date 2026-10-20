// Conteneur du Schedule branché sur l'API : abonne l'écran à la source de données (schedule-source), affiche le
// chargement, les erreurs (codes stables de @wnext/contracts, traduits ici) et un statut discret du temps réel.
// La source est créée par l'appelant (main.tsx) : le conteneur la démarre au montage et l'arrête au démontage.
// Il porte aussi l'historique d'annulation de la session (schedule/history), abonné aux changements étrangers de la source.
// Repères de page (axe landmark-one-main, page-has-heading-one, region) : tout le contenu, barre d'outils comprise, est
// dans <main>, titré par un <h1> visuellement masqué (traduit).
import type { I18n } from "@lingui/core";
import { todayIn, viewAt } from "@wnext/engine";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { ScheduleSource, ScheduleSourceState, SourceErrorCode } from "./data/schedule-source";
import type { MessageKey } from "./i18n";
import { ScheduleScreen } from "./ScheduleScreen";
import { historyForSource } from "./schedule/history";
import { GUTTER_PX } from "./schedule/scroller";

export interface ScheduleContainerProps {
  i18n: I18n;
  source: ScheduleSource;
  /** Horloge (tests) ; la date du jour est calculée dans le fuseau du compte dès qu'il est connu, et revérifiée chaque minute. */
  now?: () => Date;
  widthPx: number;
  heightPx: number;
  /** Session OIDC : affiche « Se déconnecter » (absent en mode dev, sans session à fermer). */
  onLogout?: () => void;
}

const SHOWN_ERRORS = new Set<SourceErrorCode>(["UNAUTHENTICATED", "FORBIDDEN", "RATE_LIMITED"]);
const errorKey = (code: SourceErrorCode): MessageKey => `schedule.error.${SHOWN_ERRORS.has(code) ? code as "UNAUTHENTICATED" : "INTERNAL_ERROR"}`;
const realtimeKey = (s: ScheduleSourceState["realtime"]): MessageKey =>
  s === "live" ? "schedule.realtime.live" : s === "stopped" ? "schedule.realtime.offline" : "schedule.realtime.reconnecting";

/** Période de vérification du changement de jour (onglet laissé ouvert la nuit). */
const TODAY_CHECK_MS = 60_000;
const systemNow = () => new Date();

export function ScheduleContainer({ i18n, source, now = systemNow, widthPx, heightPx, onLogout }: ScheduleContainerProps) {
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
        {logout}
      </div>
      {error}
      <ScheduleScreen i18n={i18n} data={state.data} today={today} widthPx={widthPx} heightPx={heightPx} onViewChange={source.setViewport}
        editor={undo.history.editor} history={undo.history} />
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
