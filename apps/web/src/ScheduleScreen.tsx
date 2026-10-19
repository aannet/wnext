// Écran Schedule (ADR-002 §2-3, ADR-005 : DOM A2). React ne porte que la coquille (barre d'outils, en-têtes) ; la grille
// est dessinée par createGridRenderer, appelé directement au défilement, sans réconciliation.
//  * Zoom jour / semaine / mois au centre conservé, précédent / suivant d'une largeur de vue, « Aujourd'hui » (bouton et
//    touche T), date du jour fournie dans le fuseau du compte (todayIn).
//  * Tout texte visible vient du catalogue i18n (lint : npm run lint:ui-strings) ; les noms de personnes et de projets
//    sont des données.
import type { I18n } from "@lingui/core";
import type { ScheduleResponse } from "@wnext/contracts";
import { dayNumber, goToday, headerCells, page, setZoom, viewAt, visibleRange, type HeaderCell, type Viewport, type Zoom } from "@wnext/engine";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { MessageKey } from "./i18n";
import { createGridRenderer, type GridRenderer } from "./schedule/grid-dom";
import { buildGrid } from "./schedule/grid-model";

export interface ScheduleScreenProps {
  i18n: I18n;
  data: ScheduleResponse;
  /** Date du jour dans le fuseau du compte. */
  today: string;
  widthPx: number;
  heightPx: number;
  /** Vue courante (montage, zoom, navigation) : la source de données y charge les blocs manquants. */
  onViewChange?(view: Viewport): void;
}

const ZOOMS: readonly Zoom[] = ["day", "week", "month"];

function headerLabel(c: HeaderCell, locale: string): string {
  const d = new Date(`${c.from}T00:00:00Z`);
  const opts: Intl.DateTimeFormatOptions = c.kind === "day" ? { weekday: "short", day: "numeric" }
    : c.kind === "week" ? { day: "numeric", month: "short" } : { month: "long", year: "numeric" };
  return new Intl.DateTimeFormat(locale, { ...opts, timeZone: "UTC" }).format(d);
}

export function ScheduleScreen({ i18n, data, today, widthPx, heightPx, onViewChange }: ScheduleScreenProps) {
  const t = (k: MessageKey, values?: Record<string, unknown>) => i18n._(k, values);
  const [view, setView] = useState(() => viewAt(today, "day", widthPx));
  const range = visibleRange(view);
  const model = useMemo(() => buildGrid(data, range, view.pxPerDay), [data, range.from, range.to, view.pxPerDay]);
  const cells = headerCells(range, view.zoom, data.account.weekStart);
  const gridRef = useRef<HTMLDivElement>(null);
  const renderer = useRef<GridRenderer | null>(null);

  useEffect(() => {
    renderer.current = createGridRenderer(gridRef.current!);
    return () => { renderer.current?.destroy(); renderer.current = null; };
  }, []);
  useEffect(() => { renderer.current?.render(model, gridRef.current!.scrollTop, heightPx); }, [model, heightPx]);
  useEffect(() => { onViewChange?.(view); }, [view, onViewChange]);

  const onKeyDown = (e: KeyboardEvent) => { if (e.key === "t" || e.key === "T") setView((v) => goToday(v, today)); };
  const x0 = dayNumber(range.from);

  return (
    <div className="wn-schedule">
      <div role="toolbar" aria-label={t("schedule.toolbar.label")} className="wn-toolbar">
        <button type="button" onClick={() => setView((v) => page(v, -1))}>{t("schedule.prev")}</button>
        <button type="button" onClick={() => setView((v) => goToday(v, today))}>{t("schedule.today")}</button>
        <button type="button" onClick={() => setView((v) => page(v, 1))}>{t("schedule.next")}</button>
        <span>{t("schedule.zoom.label")}</span>
        {ZOOMS.map((z) => (
          <button key={z} type="button" aria-pressed={view.zoom === z} onClick={() => setView((v) => setZoom(v, z))}>
            {t(`schedule.zoom.${z}`)}
          </button>
        ))}
        <span>{t("schedule.people.count", { count: data.people.length })}</span>
      </div>
      <div className="wn-header" style={{ position: "relative", height: 32 }}>
        {cells.map((c) => (
          <div key={c.from} role="columnheader" data-from={c.from} className="wn-colheader"
            style={{ position: "absolute", left: Math.max(0, dayNumber(c.from) - x0) * view.pxPerDay }}>
            {headerLabel(c, i18n.locale)}
          </div>
        ))}
      </div>
      <div ref={gridRef} role="grid" aria-label={t("schedule.grid.label")} tabIndex={0} onKeyDown={onKeyDown}
        className="wn-grid" style={{ overflow: "auto", height: heightPx }}
        onScroll={(e) => renderer.current?.render(model, e.currentTarget.scrollTop, heightPx)} />
    </div>
  );
}
