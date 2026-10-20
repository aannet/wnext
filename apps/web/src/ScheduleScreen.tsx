// Écran Schedule (ADR-002 §2-3, ADR-005 : DOM A2). React ne porte que la coquille (barre d'outils) ; la grille et l'en-tête
// de dates sont dessinés par le contrôleur de défilement (schedule/scroller), hors réconciliation.
//  * Défilement horizontal continu (molette, trackpad, Maj + molette, barre, flèches gauche / droite) ; zoom jour /
//    semaine / mois au centre conservé ; précédent / suivant d'une période du zoom et « Aujourd'hui » (bouton et touche T)
//    en défilement doux ; date du jour fournie dans le fuseau du compte (todayIn), mise à jour sans recréer la grille.
//  * Tout texte visible vient du catalogue i18n (lint : npm run lint:ui-strings) ; les noms de personnes et de projets
//    sont des données.
//  * Édition par gestes (pointeur et clavier, schedule/block-editor) si un éditeur est fourni ; sinon lecture seule.
//    Entrée sur la grille donne le focus à un bloc, Échap sur un bloc le rend à la grille.
//  * Annuler / Rétablir (BR-40) si un historique est fourni (schedule/history) : boutons de la barre d'outils, désactivés
//    si la pile est vide, et raccourcis Ctrl+Z, Ctrl+Maj+Z, Ctrl+Y (Cmd sur Mac) écoutés sur le document, ignorés dans un
//    champ de saisie ou une boîte de dialogue. Le résultat est annoncé dans la région aria-live des écritures.
//  * Congés (BR-04, schedule/timeoff-ui) si une source d'écritures est fournie (`records`) : bouton « Nouveau congé » et
//    touche C sur la grille (sur un bloc : sa personne et son premier jour ; sur un congé, ou un jour couvert par un congé :
//    modification), clic ou Entrée sur un congé pour le modifier, double clic sur une case vide pour en créer un.
//  * Saisie rapide (schedule/quick-entry-ui) si une source d'écritures est fournie : barre au-dessus de la grille, touche
//    « / » ou N sur la grille (sur un bloc : sa personne), création annulable par Ctrl+Z.
//  * Vues sauvegardées (schedule/views-ui) si une source de vues est fournie : filtres (département, rôle, projet, personne, tri)
//    appliqués côté client aux lignes (schedule/view-filters) ; seule la grille reçoit les données filtrées, les éditeurs gardent
//    les données complètes.
import type { I18n } from "@lingui/core";
import type { ScheduleResponse } from "@wnext/contracts";
import { dayNumber, fromDayNumber, type HeaderCell, type Viewport, type Zoom } from "@wnext/engine";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent } from "react";
import type { ScheduleEditor } from "./data/allocation-edits";
import type { ScheduleSource } from "./data/schedule-source";
import type { ViewsSource } from "./data/views-source";
import type { MessageKey } from "./i18n";
import { createBlockEditor } from "./schedule/block-editor";
import { blockLabeler } from "./schedule/block-label";
import { timeoffLabeler } from "./schedule/timeoff-label";
import { capacityLabeler } from "./schedule/capacity-label";
import { useScheduleEdits, type FocusTarget } from "./schedule/edits-ui";
import type { History, HistoryDirection, HistoryResult, HistoryState } from "./schedule/history";
import { createScroller, type Clock, type Scroller } from "./schedule/scroller";
import { useTimeoffEdits } from "./schedule/timeoff-ui";
import { QuickEntry, type QuickEntryHandle } from "./schedule/quick-entry-ui";
import { applyViewFilters, type ViewFilters } from "./schedule/view-filters";
import { ViewsBar } from "./schedule/views-ui";

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
  /** Historique d'annulation (dont `editor` est en principe l'éditeur enregistreur) ; absent : ni boutons ni raccourcis. */
  history?: History;
  /** Vues sauvegardées (filtres nommés) ; absent : ni barre de vues ni filtres. */
  views?: ViewsSource;
  /** Écritures brutes de la source (congés, report assisté) ; absent : congés en lecture seule. */
  records?: Pick<ScheduleSource, "getState" | "updateAllocation" | "splitOccurrence" | "createTimeoff" | "updateTimeoff" | "deleteTimeoff"
    | "createAllocation" | "deleteAllocation" | "loggedTime"> & Partial<Pick<ScheduleSource, "listProjects" | "onProjectsChange">>;
}

const ZOOMS: readonly Zoom[] = ["day", "week", "month"];
const NO_HISTORY: HistoryState = { canUndo: false, canRedo: false, undoLabel: null, redoLabel: null };
const noSubscribe = () => () => {};
const LABELS: Record<string, string> = { "allocation.move": "move", "allocation.resize": "resize", "allocation.load": "load", "allocation.create": "create" };

/** Cible où Ctrl+Z appartient au navigateur (champ de saisie) ou à une boîte de dialogue ouverte. */
function ownsUndo(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  return t.isContentEditable || t.matches("input, textarea, select") || t.closest("[role=dialog]") !== null;
}

/** Raccourci d'historique d'un événement clavier (Ctrl ou Cmd, sans Alt), ou null. */
export function historyShortcut(e: Pick<globalThis.KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey">): HistoryDirection | null {
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return null;
  const k = e.key.toLowerCase();
  if (k === "z") return e.shiftKey ? "redo" : "undo";
  if (k === "y" && !e.shiftKey) return "redo";
  return null;
}

function headerFormatter(locale: string) {
  const fmt = {
    day: new Intl.DateTimeFormat(locale, { weekday: "short", day: "numeric", timeZone: "UTC" }),
    week: new Intl.DateTimeFormat(locale, { day: "numeric", month: "short", timeZone: "UTC" }),
    month: new Intl.DateTimeFormat(locale, { month: "long", year: "numeric", timeZone: "UTC" }),
  };
  return (c: HeaderCell) => fmt[c.kind].format(new Date(`${c.from}T00:00:00Z`));
}

export function ScheduleScreen({ i18n, data, today, widthPx: initialWidthPx, heightPx: initialHeightPx, onViewChange, clock, editor, history, records, views }: ScheduleScreenProps) {
  const t = (k: MessageKey, values?: Record<string, unknown>) => i18n._(k, values);
  const [zoom, setZoom] = useState<Zoom>("day");
  const [filters, setFilters] = useState<ViewFilters>({});
  // Lignes affichées : personnes filtrées (et triées) ; `data` reste la référence des éditeurs et des listes de choix.
  const shown = useMemo(() => applyViewFilters(data, filters), [data, filters]);
  const gridRef = useRef<HTMLDivElement>(null);
  const scroller = useRef<Scroller | null>(null);
  const viewChange = useRef(onViewChange);
  viewChange.current = onViewChange;
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  // Focus après une écriture : `at` (personne et dates du bloc tel qu'écrit) retrouve le bloc même si sa clé a changé
  // (occurrence sortie d'une série : nouvelle allocation). Si les données à jour ne sont pas encore dessinées, la demande
  // attend le prochain setData, une seule fois. Le focus parti hors de la grille n'est pas repris.
  const pendingFocus = useRef<{ key: string; at: FocusTarget } | null>(null);
  const focusAt = (key: string, at: FocusTarget): boolean => {
    const grid = gridRef.current;
    const hits = scroller.current?.host.model()?.rows.find((r) => r.personId === at.personId)?.blocks
      .filter((b) => b.startDate === at.startDate && b.endDate === at.endDate) ?? [];
    const hit = hits.find((b) => b.key === key) ?? hits[0];
    const el = hit && grid?.querySelector<HTMLElement>(`.wn-block[data-key="${hit.key}"]`);
    if (!grid || !el) return false;
    const active = document.activeElement;
    if (el !== active && (active === null || active === document.body || grid.contains(active))) el.focus({ preventScroll: true });
    return true;
  };
  const focusKey = (key: string, at?: FocusTarget) => {
    if (at) { if (!focusAt(key, at)) pendingFocus.current = { key, at }; return; }
    const grid = gridRef.current;
    const el = grid?.querySelector<HTMLElement>(`.wn-block[data-key="${key}"]`);
    (el ?? grid)?.focus({ preventScroll: true });
  };
  const edits = useScheduleEdits(i18n, editor, data, focusKey, history !== undefined);
  const editsRef = useRef(edits);
  editsRef.current = edits;
  const stack = useSyncExternalStore(history?.subscribe ?? noSubscribe, history?.getState ?? (() => NO_HISTORY));
  const describeStep = (r: HistoryResult): string => {
    const v = { direction: r.direction };
    if (r.ok && r.label.startsWith("timeoff.")) return t("schedule.history.timeoff", { ...v, label: r.label.slice("timeoff.".length) });
    if (r.ok) return t("schedule.history.done", { ...v, label: LABELS[r.label] ?? "other" });
    if (!r.dropped) return t("schedule.history.retry", v);
    return t(r.error === "VERSION_CONFLICT" || r.error === "NOT_FOUND" ? `schedule.history.failed.${r.error}` : "schedule.history.failed.other", v);
  };
  const stepRef = useRef<(d: HistoryDirection) => void>(() => {});
  stepRef.current = (d) => {
    if (!history) return;
    void history[d]().then((r) => { if (r) editsRef.current.announce(describeStep(r)); });
  };
  useEffect(() => {
    if (!history) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      const d = historyShortcut(e);
      if (!d || ownsUndo(e.target)) return;
      e.preventDefault();
      stepRef.current(d);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [history]);
  const dataRef = useRef(data);
  dataRef.current = data;
  const timeoffs = useTimeoffEdits(
    i18n, records && { editor: records, data: () => records.getState().data ?? dataRef.current, record: history?.record }, data,
    (text) => editsRef.current.announce(text), () => gridRef.current?.focus({ preventScroll: true }),
  );
  /** Personne et jour visés par une touche C (bloc focalisé, sinon première ligne au centre de la vue). */
  const openTimeoffAt = (target: EventTarget | null) => {
    const s = scroller.current;
    if (!s) return;
    const off = s.host.timeoffAt?.(target);
    if (off) { timeoffs.openEdit(off.timeoff.timeoffId); return; }
    const hit = s.host.blockAt(target);
    const personId = hit?.row.personId ?? s.host.model()?.rows[0]?.personId;
    if (personId) timeoffs.openAt(personId, hit?.block.startDate ?? fromDayNumber(Math.floor(s.view().center)));
  };
  /** Double clic sur une case vide : personne de la ligne, jour de la colonne. */
  const onDoubleClick = (e: { target: EventTarget; clientX: number; clientY: number }) => {
    const s = scroller.current;
    const m = s?.host.model();
    if (!s || !m || s.host.blockAt(e.target)) return;
    if (s.host.timeoffAt?.(e.target)) return;
    const r = s.host.surface.getBoundingClientRect();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    const row = m.rows.find((w) => y >= w.top && y < w.top + w.heightPx);
    const origin = s.host.xOfDate(m.from);
    if (!row || x < origin) return;
    timeoffs.openAt(row.personId, fromDayNumber(dayNumber(m.from) + Math.floor((x - origin) / m.pxPerDay)));
  };
  const quickRef = useRef<QuickEntryHandle>(null);
  const editorRef = useRef(editor);
  editorRef.current = editor;

  // Le scroller est créé une seule fois : la date du jour et la locale lui sont poussées (setToday, setLabels), sans perdre
  // la position.
  const labelsFor = (i: I18n) => ({ label: headerFormatter(i.locale), capacityLabel: capacityLabeler(i), blockLabel: blockLabeler(i), timeoffLabel: timeoffLabeler(i) });
  const labelled = useRef(i18n);
  // widthPx/heightPx ne sont que la taille initiale : ensuite la grille remplit l'espace restant (CSS flex) et un
  // ResizeObserver pousse sa taille au scroller (fenêtre redimensionnée, barres ou filtres dépliés). Sans ResizeObserver
  // (jsdom), la taille initiale reste.
  const [size, setSize] = useState({ widthPx: initialWidthPx, heightPx: initialHeightPx });
  const { widthPx, heightPx } = size;
  useEffect(() => {
    const s = createScroller({
      root: gridRef.current!, data: shown, today, widthPx, heightPx, clock, zoom: zoomRef.current, ...labelsFor(i18n),
      onViewChange: (v) => viewChange.current?.(v),
    });
    labelled.current = i18n;
    scroller.current = s;
    const blocks = createBlockEditor({
      root: gridRef.current!, host: s.host, clock, enabled: () => editorRef.current !== undefined,
      onCommit: (r) => editsRef.current.onCommit(r), onPreview: (p) => editsRef.current.onPreview(p),
    });
    return () => { blocks.destroy(); s.destroy(); scroller.current = null; };
  }, []);
  useEffect(() => { scroller.current?.setToday(today); }, [today]);
  useEffect(() => {
    if (labelled.current.locale === i18n.locale) return;
    labelled.current = i18n;
    scroller.current?.setLabels(labelsFor(i18n));
  }, [i18n.locale]);
  useEffect(() => {
    scroller.current?.setData(shown);
    const p = pendingFocus.current;
    pendingFocus.current = null;
    if (p) focusAt(p.key, p.at);
  }, [shown]);
  useEffect(() => { scroller.current?.resize(widthPx, heightPx); }, [widthPx, heightPx]);
  useEffect(() => {
    const el = gridRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => {
      const r = entries[entries.length - 1]?.contentRect;
      if (!r || r.width <= 0 || r.height <= 0) return;
      const next = { widthPx: Math.round(r.width), heightPx: Math.round(r.height) };
      setSize((cur) => (cur.widthPx === next.widthPx && cur.heightPx === next.heightPx ? cur : next));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const zoomTo = (z: Zoom) => { scroller.current?.setZoom(z); setZoom(z); };
  const onKeyDown = (e: KeyboardEvent) => {
    const s = scroller.current;
    if (!s) return;
    const onBlock = e.target !== e.currentTarget;
    if (onBlock && e.key === "Escape") { e.preventDefault(); gridRef.current?.focus({ preventScroll: true }); return; }
    if (records && (e.key === "/" || e.key === "n" || e.key === "N") && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      quickRef.current?.focus(s.host.blockAt(e.target)?.row.personId);
      return;
    }
    if (records && (e.key === "c" || e.key === "C") && !e.ctrlKey && !e.metaKey && !e.altKey) { e.preventDefault(); openTimeoffAt(e.target); return; }
    if (records && e.key === "Enter" && s.host.timeoffAt?.(e.target)) { e.preventDefault(); openTimeoffAt(e.target); return; }
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
        {history && (
          <>
            <button type="button" disabled={!stack.canUndo} aria-keyshortcuts="Control+Z Meta+Z" onClick={() => stepRef.current("undo")}>
              {t("schedule.history.undo")}
            </button>
            <button type="button" disabled={!stack.canRedo} aria-keyshortcuts="Control+Shift+Z Control+Y Meta+Shift+Z" onClick={() => stepRef.current("redo")}>
              {t("schedule.history.redo")}
            </button>
          </>
        )}
        {records && (
          <button type="button" aria-keyshortcuts="C" onClick={() => openTimeoffAt(document.activeElement)}>{t("schedule.timeoff.new")}</button>
        )}
        <span>{t("schedule.people.count", { count: shown.people.length })}</span>
      </div>
      {views && <ViewsBar i18n={i18n} data={data} shownCount={shown.people.length} source={views} filters={filters} zoom={zoom} onFilters={setFilters} onZoom={zoomTo} />}
      {records && (
        <QuickEntry ref={quickRef} i18n={i18n} data={data} today={today} createAllocation={records.createAllocation} listProjects={records.listProjects} onProjectsChange={records.onProjectsChange} record={history?.record}
          announce={(text) => editsRef.current.announce(text)} onExit={() => gridRef.current?.focus({ preventScroll: true })} />
      )}
      <div ref={gridRef} role="grid" aria-label={t("schedule.grid.label")} tabIndex={0} onKeyDown={onKeyDown}
        onClick={(e) => { const off = records && scroller.current?.host.timeoffAt?.(e.target); if (off) timeoffs.openEdit(off.timeoff.timeoffId); }}
        onDoubleClick={records ? onDoubleClick : undefined}
        className="wn-grid" />
      {timeoffs.element}
      {edits.element}
    </div>
  );
}
