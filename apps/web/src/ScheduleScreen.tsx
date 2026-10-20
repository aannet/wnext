// Écran Schedule (ADR-002 §2-3, ADR-005 : DOM A2). React ne porte que la coquille (barre d'outils) ; la grille et l'en-tête
// de dates sont dessinés par le contrôleur de défilement (schedule/scroller), hors réconciliation.
//  * Défilement horizontal continu (molette, trackpad, Maj + molette, barre, flèches gauche / droite) ; zoom jour /
//    semaine / mois au centre conservé ; précédent / suivant d'une période du zoom et « Aujourd'hui » (bouton et touche T)
//    en défilement doux ; date du jour fournie dans le fuseau du compte (todayIn).
//  * Tout texte visible vient du catalogue i18n (lint : npm run lint:ui-strings) ; les noms de personnes et de projets
//    sont des données.
import type { I18n } from "@lingui/core";
import type { ScheduleResponse } from "@wnext/contracts";
import type { HeaderCell, Viewport, Zoom } from "@wnext/engine";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { MessageKey } from "./i18n";
import { capacityLabeler } from "./schedule/capacity-label";
import { createScroller,type Clock, type Scroller } from "./schedule/scroller";

export interface ScheduleScreenProps {
  i18n: I18n;
  data: ScheduleResponse;
  /** Date du jour dans le fuseau du compte. */
  today: string;
  widthPx: number;
  heightPx: number;
  /** Vue courante (montage, défilement, zoom) : la source de données y charge les blocs manquants et voisins. */
  onViewChange?(view: Viewport): void;
  /** Horloge du défilement (tests) ; par défaut requestAnimationFrame et minuteries du navigateur. */
  clock?: Partial<Clock>;
}

const ZOOMS: readonly Zoom[] = ["day", "week", "month"];

function headerFormatter(locale: string) {
  const fmt = {
    day: new Intl.DateTimeFormat(locale, { weekday: "short", day: "numeric", timeZone: "UTC" }),
    week: new Intl.DateTimeFormat(locale, { day: "numeric", month: "short", timeZone: "UTC" }),
    month: new Intl.DateTimeFormat(locale, { month: "long", year: "numeric", timeZone: "UTC" }),
  };
  return (c: HeaderCell) => fmt[c.kind].format(new Date(`${c.from}T00:00:00Z`));
}

export function ScheduleScreen({ i18n, data, today, widthPx, heightPx, onViewChange, clock }: ScheduleScreenProps) {
  const t = (k: MessageKey, values?: Record<string, unknown>) => i18n._(k, values);
  const [zoom, setZoom] = useState<Zoom>("day");
  const gridRef = useRef<HTMLDivElement>(null);
  const scroller = useRef<Scroller | null>(null);
  const viewChange = useRef(onViewChange);
  viewChange.current = onViewChange;
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;

  useEffect(() => {
    const s = createScroller({
      root: gridRef.current!, data, today, widthPx, heightPx, clock, zoom: zoomRef.current, label: headerFormatter(i18n.locale),
      onViewChange: (v) => viewChange.current?.(v),
      capacityLabel: capacityLabeler(i18n),
    });
    scroller.current = s;
    return () => { s.destroy(); scroller.current = null; };
  }, [today, i18n.locale]);
  useEffect(() => { scroller.current?.setData(data); }, [data]);
  useEffect(() => { scroller.current?.resize(widthPx, heightPx); }, [widthPx, heightPx]);

  const zoomTo = (z: Zoom) => { scroller.current?.setZoom(z); setZoom(z); };
  const onKeyDown = (e: KeyboardEvent) => {
    const s = scroller.current;
    if (!s) return;
    if (e.key === "t" || e.key === "T") s.today();
    else if (e.key === "ArrowLeft" || e.key === "ArrowRight") { e.preventDefault(); s.nudge(e.key === "ArrowLeft" ? -1 : 1); }
  };

  return (
    <div className="wn-schedule">
      <div role="toolbar" aria-label={t("schedule.toolbar.label")} className="wn-toolbar">
        <button type="button" onClick={() => scroller.current?.step(-1)}>{t("schedule.prev")}</button>
        <button type="button" onClick={() => scroller.current?.today()}>{t("schedule.today")}</button>
        <button type="button" onClick={() => scroller.current?.step(1)}>{t("schedule.next")}</button>
        <span>{t("schedule.zoom.label")}</span>
        {ZOOMS.map((z) => (
          <button key={z} type="button" aria-pressed={zoom === z} onClick={() => zoomTo(z)}>
            {t(`schedule.zoom.${z}`)}
          </button>
        ))}
        <span>{t("schedule.people.count", { count: data.people.length })}</span>
      </div>
      <div ref={gridRef} role="grid" aria-label={t("schedule.grid.label")} tabIndex={0} onKeyDown={onKeyDown}
        className="wn-grid" style={{ overflow: "auto", height: heightPx, width: widthPx }} />
    </div>
  );
}
