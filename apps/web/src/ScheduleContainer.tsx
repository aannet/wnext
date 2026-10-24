// Conteneur du Schedule branché sur l'API : abonne l'écran à la source de données (schedule-source), affiche le
// chargement, les erreurs (codes stables de @wnext/contracts, traduits ici) et un statut discret du temps réel.
// La source est créée par l'appelant (main.tsx) : le conteneur la démarre au montage et l'arrête au démontage.
// Il porte aussi l'historique d'annulation de la session (schedule/history), abonné aux changements étrangers de la source.
// Repères de page (axe landmark-one-main, page-has-heading-one, region) : tout le contenu, barre d'outils comprise, est
// dans <main>, titré par un <h1> visible (traduit) qui ouvre le sous-header de l'écran (titre + barre d'outils). L'en-tête
// applicatif, la cloche des notifications et le menu utilisateur vivent dans la coque (shell/).
import type { I18n } from "@lingui/core";
import type { Me } from "@wnext/contracts";
import { todayIn, viewAt } from "@wnext/engine";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { ScheduleSource, ScheduleSourceState, SourceErrorCode } from "./data/schedule-source";
import type { ViewsSource } from "./data/views-source";
import type { MessageKey } from "./i18n";
import { ScheduleScreen, type ScheduleMemory } from "./ScheduleScreen";
import { historyForSource } from "./schedule/history";
import type { SlotCatalog } from "./schedule/slot-editor-ui";
import { GUTTER_PX } from "./schedule/scroller";
import { Button } from "./design";

export interface ScheduleContainerProps {
  i18n: I18n;
  source: ScheduleSource;
  /** Vues sauvegardées ; absent : pas de barre de vues. */
  views?: ViewsSource;
  /** Horloge (tests) ; la date du jour est calculée dans le fuseau du compte dès qu'il est connu, et revérifiée chaque minute. */
  now?: () => Date;
  widthPx: number;
  heightPx: number;
  /** Session OIDC : sur 401, propose de se reconnecter (absent en mode dev, sans session à rouvrir). */
  onReconnect?: () => void;
  /** Lecture seule (member, guest : GET /me) : ni gestes, ni annulation, ni congés, ni saisie rapide. */
  readOnly?: boolean;
  /** Zoom et position gardés quand on quitte le Planning (PO-02), tenus par l'appelant ; absent : rien n'est gardé. */
  memory?: ScheduleMemory;
  /** Référentiel des projets de la pop-in du créneau (projets autorisés, tâches, couleur) ; absent : projets de la source. */
  catalog?: SlotCatalog;
  /** Utilisateur connecté : projets proposés selon ses droits (BR-33). */
  me?: Pick<Me, "role" | "person"> & Partial<Pick<Me, "user">>;
  /** Ouvre la fiche d'un projet choisi dans la recherche (écran Projets) ; absent : la recherche ne propose que des personnes. */
  onOpenProject?(projectId: string): void;
  /** Personne à révéler à l'ouverture (recherche lancée d'un autre écran, ?personne=, RT-059). */
  reveal?: { personId: string; onDone?(): void };
}

const SHOWN_ERRORS = new Set<SourceErrorCode>(["UNAUTHENTICATED", "FORBIDDEN", "RATE_LIMITED"]);
const errorKey = (code: SourceErrorCode): MessageKey => `schedule.error.${SHOWN_ERRORS.has(code) ? code as "UNAUTHENTICATED" : "INTERNAL_ERROR"}`;
const realtimeKey = (s: ScheduleSourceState["realtime"]): MessageKey =>
  s === "live" ? "schedule.realtime.live" : s === "stopped" ? "schedule.realtime.offline" : "schedule.realtime.reconnecting";

/**
 * Statut du temps réel (RT-032, Q12 amendée) : connecté, une puce verte seule (nom accessible « En direct », infobulle qui
 * explique) ; en reconnexion (orange) ou hors connexion (rouge), la puce et un texte visible.
 */
export function RealtimeStatus({ i18n, state }: { i18n: I18n; state: ScheduleSourceState["realtime"] }) {
  const label = i18n._(realtimeKey(state));
  return state === "live"
    ? <span role="status" className="wn-realtime wn-realtime-live" title={i18n._("schedule.realtime.live.hint")}><span className="wn-visually-hidden">{label}</span></span>
    : <span role="status" className={`wn-realtime wn-realtime-${state}`}><span className="wn-realtime-text">{label}</span></span>;
}

/** Période de vérification du changement de jour (onglet laissé ouvert la nuit). */
const TODAY_CHECK_MS = 60_000;
const systemNow = () => new Date();

export function ScheduleContainer({ i18n, source, views, now = systemNow, widthPx, heightPx, onReconnect, readOnly = false, memory, catalog, me, onOpenProject, reveal }: ScheduleContainerProps) {
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

  const status = <RealtimeStatus i18n={i18n} state={state.realtime} />;
  const error = state.error && <div role="alert" className="wn-error">{t(errorKey(state.error))}</div>;
  const reconnect = state.error === "UNAUTHENTICATED" && onReconnect && <Button type="button" variant="primary" onClick={onReconnect}>{t("auth.retry")}</Button>;

  const title = <h1 tabIndex={-1} className="wn-subheader-title">{t("app.title")}</h1>;

  // RT-048 : un member ne voit que sa personne liée ; sans personne liée, la grille serait vide sans explication.
  if (me?.role === "member" && !me.person) {
    return (
      <main className="wn-schedule-container">
        <div className="wn-subheader">{title}</div>
        <section className="wn-soon wn-empty" aria-labelledby="wn-sempty-title">
          <h2 id="wn-sempty-title">{t("access.own.title")}</h2>
          <p>{t("access.own.body")}</p>
        </section>
      </main>
    );
  }
  if (!state.data) {
    return (
      <main className="wn-schedule-container" aria-busy={state.loading}>
        <div className="wn-subheader">{title}</div>
        {error ?? <div className="wn-loading">{t("schedule.loading")}</div>}
        {reconnect}
        {status}
      </main>
    );
  }
  return (
    <main className="wn-schedule-container" aria-busy={state.loading}>
      {error}
      {reconnect}
      <ScheduleScreen i18n={i18n} data={state.data} today={today} widthPx={widthPx} heightPx={heightPx} onViewChange={source.setViewport}
        {...(readOnly ? {} : { editor: undo.history.editor, history: undo.history, records: source, ...(catalog ? { catalog } : {}) })} {...(views ? { views } : {})} {...(memory ? { memory } : {})}
        {...(me ? { me } : {})} {...(onOpenProject ? { onOpenProject } : {})} {...(reveal ? { reveal } : {})}
        heading={title}
        actions={(
          <div className="wn-statusbar">
            {status}
            {state.loading && <span className="wn-loading">{t("schedule.loading")}</span>}
          </div>
        )} />
    </main>
  );
}
