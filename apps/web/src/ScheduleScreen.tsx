// Écran Schedule (ADR-002 §2-3, ADR-005 : DOM A2). React ne porte que la coquille (barre d'outils) ; la grille et l'en-tête
// de dates sont dessinés par le contrôleur de défilement (schedule/scroller), hors réconciliation.
//  * Défilement horizontal continu (molette, trackpad, Maj + molette, barre, flèches gauche / droite) ; zoom jour /
//    semaine / mois au centre conservé ; précédent / suivant d'une période du zoom et « Aujourd'hui » (bouton et touche T)
//    en défilement doux ; date du jour fournie dans le fuseau du compte (todayIn).
//  * Tout texte visible vient du catalogue i18n (lint : npm run lint:ui-strings) ; les noms de personnes et de projets
//    sont des données.
//  * Édition par gestes (pointeur et clavier, schedule/block-editor) si un éditeur est fourni ; sinon lecture seule.
//    Entrée sur la grille donne le focus à un bloc, Échap sur un bloc le rend à la grille.
import type { I18n } from "@lingui/core";
import type { ScheduleResponse } from "@wnext/contracts";
import type { HeaderCell, Viewport, Zoom } from "@wnext/engine";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { ScheduleEditor } from "./data/allocation-edits";
import type { MessageKey } from "./i18n";
import { createBlockEditor } from "./schedule/block-editor";
import { capacityLabeler } from "./schedule/capacity-label";
import { useScheduleEdits } from "./schedule/edits-ui";
import { createScroller, type Clock, type Scroller } from "./schedule/scroller";

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
  /** Écritures (source branchée sur l'API ou démo locale) ; absent : lecture seule. */
  editor?: ScheduleEditor;
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

export function ScheduleScreen({ i18n, data, today, widthPx, heightPx, onViewChange, clock, editor }: ScheduleScreenProps) {
  const t = (k: MessageKey, values?: Record<string, unknown>) => i18n._(k, values);
  const [zoom, setZoom] = useState<Zoom>("day");
  const gridRef = useRef<HTMLDivElement>(null);
  const scroller = useRef<Scroller | null>(null);
  const viewChange = useRef(onViewChange);
  viewChange.current = onViewChange;
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  const focusKey = (key: string) => {
    const grid = gridRef.current;
    const el = grid?.querySelector<HTMLElement>(`.wn-block[data-key="${key}"]`);
    (el ?? grid)?.focus({ preventScroll: true });
  };
  const edits = useScheduleEdits(i18n, editor, data, focusKey);
  const editsRef = useRef(edits);
  editsRef.current = edits;
  const editorRef = useRef(editor);
  editorRef.current = editor;

  useEffect(() => {
    const s = createScroller({
      root: gridRef.current!, data, today, widthPx, heightPx, clock, zoom: zoomRef.current, label: headerFormatter(i18n.locale),
      onViewChange: (v) => viewChange.current?.(v),
      capacityLabel: capacityLabeler(i18n),
    });
    scroller.current = s;
    const blocks = createBlockEditor({
      root: gridRef.current!, host: s.host, clock, enabled: () => editorRef.current !== undefined,
      onCommit: (r) => editsRef.current.onCommit(r), onPreview: (p) => editsRef.current.onPreview(p),
    });
    return () => { blocks.destroy(); s.destroy(); scroller.current = null; };
  }, [today, i18n.locale]);
  useEffect(() => { scroller.current?.setData(data); }, [data]);
  useEffect(() => { scroller.current?.resize(widthPx, heightPx); }, [widthPx, heightPx]);

  const zoomTo = (z: Zoom) => { scroller.current?.setZoom(z); setZoom(z); };
  const onKeyDown = (e: KeyboardEvent) => {
    const s = scroller.current;
    if (!s) return;
    const onBlock = e.target !== e.currentTarget;
    if (onBlock && e.key === "Escape") { e.preventDefault(); gridRef.current?.focus({ preventScroll: true }); return; }
    if (!onBlock && e.key === "Enter") {
      const first = gridRef.current?.querySelector<HTMLElement>(".wn-block[data-key]");
      if (first) { e.preventDefault(); first.focus({ preventScroll: true }); }
      return;
    }
    if (e.key === "t" || e.key === "T") s.today();
    else if (onBlock) return;
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
      {edits.element}
    </div>
  );
}
