// Conteneur du Schedule branché sur l'API : abonne l'écran à la source de données (schedule-source), affiche le
// chargement, les erreurs (codes stables de @wnext/contracts, traduits ici) et un statut discret du temps réel.
// La source est créée par l'appelant (main.tsx) : le conteneur la démarre au montage et l'arrête au démontage.
import type { I18n } from "@lingui/core";
import { todayIn, viewAt } from "@wnext/engine";
import { useEffect, useSyncExternalStore } from "react";
import type { ScheduleSource, ScheduleSourceState, SourceErrorCode } from "./data/schedule-source";
import type { MessageKey } from "./i18n";
import { ScheduleScreen } from "./ScheduleScreen";
import { GUTTER_PX } from "./schedule/scroller";

export interface ScheduleContainerProps {
  i18n: I18n;
  source: ScheduleSource;
  /** Instant courant ; la date du jour est calculée dans le fuseau du compte dès qu'il est connu. */
  now: Date;
  widthPx: number;
  heightPx: number;
}

const SHOWN_ERRORS = new Set<SourceErrorCode>(["UNAUTHENTICATED", "FORBIDDEN", "RATE_LIMITED"]);
const errorKey = (code: SourceErrorCode): MessageKey => `schedule.error.${SHOWN_ERRORS.has(code) ? code as "UNAUTHENTICATED" : "INTERNAL_ERROR"}`;
const realtimeKey = (s: ScheduleSourceState["realtime"]): MessageKey =>
  s === "live" ? "schedule.realtime.live" : s === "stopped" ? "schedule.realtime.offline" : "schedule.realtime.reconnecting";

export function ScheduleContainer({ i18n, source, now, widthPx, heightPx }: ScheduleContainerProps) {
  const t = (k: MessageKey) => i18n._(k);
  const state = useSyncExternalStore(source.subscribe, source.getState);
  const timezone = state.data?.account.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const today = todayIn(timezone, now);

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

  if (!state.data) {
    return (
      <div className="wn-schedule-container" aria-busy={state.loading}>
        {error ?? <div className="wn-loading">{t("schedule.loading")}</div>}
        {status}
      </div>
    );
  }
  return (
    <div className="wn-schedule-container" aria-busy={state.loading}>
      <div className="wn-statusbar">
        {status}
        {state.loading && <span className="wn-loading">{t("schedule.loading")}</span>}
      </div>
      {error}
      <ScheduleScreen i18n={i18n} data={state.data} today={today} widthPx={widthPx} heightPx={heightPx} onViewChange={source.setViewport} editor={source} />
    </div>
  );
}
