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
//  * Pop-in du créneau (schedule/slot-editor-ui, RT-011 à RT-018) si une source d'écritures est fournie (`records`) : Q5
//    (clic = sélection ; double clic, Entrée ou clic sur le bloc sélectionné = édition), création par le bouton
//    « + Allocation » ou par clic / glisser en zone libre (bloc provisoire), onglets « Projet / tâche » et « Congé ».
//  * Congés (BR-04, schedule/timeoff-ui, dans l'onglet « Congé » de la pop-in) : bouton « Nouveau congé » et
//    touche C sur la grille (sur un bloc : sa personne et son premier jour ; sur un congé, ou un jour couvert par un congé :
//    modification), clic ou Entrée sur un congé pour le modifier, double clic sur une case vide pour en créer un.
//  * Saisie rapide (schedule/quick-entry-ui) si une source d'écritures est fournie : barre au-dessus de la grille, touche
//    « / » ou N sur la grille (sur un bloc : sa personne), création annulable par Ctrl+Z.
//  * Vues sauvegardées (schedule/views-ui) si une source de vues est fournie : filtres (département, rôle, projet, personne, tri)
//    appliqués côté client aux lignes (schedule/view-filters) ; seule la grille reçoit les données filtrées, les éditeurs gardent
//    les données complètes.
//  * Recherche (RT-038, schedule/search-ui) : bouton « Rechercher » du niveau 1 et raccourci Ctrl+K (Cmd+K sur Mac), ignoré
//    dans une autre fenêtre modale, dans une zone de texte (textarea, contenteditable) et quand l'événement est déjà traité. Une
//    personne choisie est amenée dans la vue et mise en évidence (Scroller.revealPerson), focus à la grille, annoncé. Si un filtre la
//    masque, la palette demande confirmation ; confirmée, les critères sont retirés (le tri est gardé) et la barre des filtres propose
//    « Rétablir les filtres » (les critères d'avant, à l'identique) jusqu'au prochain changement de filtre ou de vue. Cela n'a rien
//    à voir avec l'historique des allocations (Ctrl+Z). Un projet choisi est confié à `onOpenProject` (écran Projets). Rien n'est
//    enregistré dans les vues.
//  * Retrait d'un projet (BR-10, schedule/team-removal-ui) si la source le permet : menu contextuel d'un bloc.
//  * En-tête en deux niveaux (RT-025) : niveau 1 = titre, vue sauvegardée, statut et actions de création ; niveau 2 (barre
//    d'outils) = Filtres (compteur, puces, panneau dépliable, schedule/filters-ui), annuler / rétablir, navigation, zoom,
//    menu Affichage, nombre de personnes.
//  * Menu Affichage (Popover) : densité et bascule « Charge par colonne » (RT-030, Q11 : état en mémoire, éteint au montage).
//  * Densité (RT-005 à RT-007, schedule/density) : contrôle segmenté (groupe de boutons radio, flèches gauche / droite) dans
//    le menu Affichage, appliquée à la volée (hauteurs du modèle, tailles CSS par data-density), mémorisée dans ce navigateur
//    et portée par les vues sauvegardées. Colonne de gauche : avatar, nom, rôle, département et jauge de la période visible.
//  * Mémoire de l'écran (PO-02) : `memory`, tenu par l'appelant au-dessus du démontage, reçoit au démontage le zoom, le jour
//    au centre et le défilement vertical, et les rend au montage suivant. La pile d'annulation n'y est pas : la source est
//    arrêtée hors du Planning, les changements des autres n'y sont pas suivis et l'historique ne pourrait plus les invalider.
import type { I18n } from "@lingui/core";
import type { Me, ScheduleResponse } from "@wnext/contracts";
import { dayNumber, fromDayNumber, type HeaderCell, type Viewport, type Zoom } from "@wnext/engine";
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent, type ReactNode } from "react";
import type { ScheduleEditor } from "./data/allocation-edits";
import type { ScheduleSource } from "./data/schedule-source";
import type { ViewsSource } from "./data/views-source";
import type { MessageKey } from "./i18n";
import { createBlockEditor, type BlockEditor } from "./schedule/block-editor";
import { blockLabeler } from "./schedule/block-label";
import { timeoffLabeler } from "./schedule/timeoff-label";
import { capacityLabeler, capacityTexter } from "./schedule/capacity-label";
import { useScheduleEdits, type FocusTarget } from "./schedule/edits-ui";
import type { History, HistoryDirection, HistoryResult, HistoryState } from "./schedule/history";
import { createScroller, type Clock, type Scroller } from "./schedule/scroller";
import { useSlotEditor, type SlotCatalog } from "./schedule/slot-editor-ui";
import { QuickEntry, type QuickEntryHandle } from "./schedule/quick-entry-ui";
import { applyViewFilters, clearCriteria, type ViewFilters } from "./schedule/view-filters";
import { isSearchShortcut, SearchPalette, searchShortcutLabel } from "./schedule/search-ui";
import type { SearchItem } from "./schedule/search-model";
import { DENSITIES, readStoredDensity, storeDensity, type Density } from "./schedule/density";
import { gaugeLabeler } from "./schedule/gauge-label";
import { ViewsBar } from "./schedule/views-ui";
import { FilterChips, FiltersButton, FiltersPanel } from "./schedule/filters-ui";
import { useTeamRemoval } from "./schedule/team-removal-ui";
import type { TeamRemovalEditor } from "./data/team-removal";
import { Button, Popover, RadioGroup, RadioItem, Switch } from "./design";

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
  /** Ouvre la fiche d'un projet choisi dans la recherche (écran Projets) ; absent : la recherche ne propose que des personnes. */
  onOpenProject?(projectId: string): void;
  /** Titre de l'écran (h1), en tête du sous-header ; absent : sous-header sans titre. */
  heading?: ReactNode;
  /** Zone à droite du sous-header (statut, import) ; absent : rien. */
  actions?: ReactNode;
  /** Écritures brutes de la source (congés, report assisté) ; absent : congés en lecture seule. */
  records?: Pick<ScheduleSource, "getState" | "updateAllocation" | "splitOccurrence" | "createTimeoff" | "updateTimeoff" | "deleteTimeoff"
    | "createAllocation" | "deleteAllocation" | "loggedTime"> & Partial<Pick<ScheduleSource, "listProjects" | "onProjectsChange" | "teamRemovalSummary" | "removeFromTeam"
    | "createAllocationGroup" | "projectChanged">>;
  /** Référentiel des projets (projets autorisés, tâches, couleur) pour la pop-in ; absent : projets de la source, sans tâches ni couleur. */
  catalog?: SlotCatalog;
  /** Utilisateur connecté : projets proposés selon ses droits (BR-33) ; absent : tous. */
  me?: Pick<Me, "role" | "person">;
  /** État gardé d'un montage à l'autre (PO-02) ; absent : l'écran repart d'aujourd'hui, zoom jour. */
  memory?: ScheduleMemory;
}

/** Ce que l'écran rend au montage suivant (objet mutable tenu par l'appelant). */
export interface ScheduleMemory { zoom?: Zoom; center?: number; scrollTop?: number }

const ZOOMS: readonly Zoom[] = ["day", "week", "month"];
const NO_HISTORY: HistoryState = { canUndo: false, canRedo: false, undoLabel: null, redoLabel: null };
const noSubscribe = () => () => {};
const LABELS: Record<string, string> = { "allocation.move": "move", "allocation.resize": "resize", "allocation.load": "load", "allocation.create": "create", "allocation.edit": "edit" };

/** Cible où Ctrl+Z appartient au navigateur (champ de saisie) ou à une boîte de dialogue ouverte. */
function ownsUndo(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  return t.isContentEditable || t.matches("input, textarea, select") || t.closest("[role=dialog]") !== null;
}

/** Cible dans une zone de texte multiligne ou un élément contenteditable : Ctrl+K y garde son sens d'édition. */
function inTextArea(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  return t.isContentEditable || t.closest('textarea, [contenteditable]:not([contenteditable="false"])') !== null;
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

export function ScheduleScreen({ i18n, data, today, widthPx: initialWidthPx, heightPx: initialHeightPx, onViewChange, clock, editor, history, records, views, heading, actions, memory, catalog, me, onOpenProject }: ScheduleScreenProps) {
  const t = (k: MessageKey, values?: Record<string, unknown>) => i18n._(k, values);
  const [zoom, setZoom] = useState<Zoom>(memory?.zoom ?? "day");
  const [density, setDensityState] = useState<Density>(() => readStoredDensity());
  const densityRef = useRef(density);
  densityRef.current = density;
  const [filters, setFilters] = useState<ViewFilters>({});
  /** Critères retirés par la recherche, à rétablir à l'identique ; effacés au prochain changement de filtre ou de vue. */
  const [removedFilters, setRemovedFilters] = useState<ViewFilters | null>(null);
  const changeFilters = (f: ViewFilters) => { setRemovedFilters(null); setFilters(f); };
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [displayOpen, setDisplayOpen] = useState(false);
  /** Charge chiffrée dans chaque colonne de temps (Q11) : en mémoire seulement, jamais enregistrée. */
  const [showLoad, setShowLoad] = useState(false);
  const displayButton = useRef<HTMLButtonElement>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const searchOpenRef = useRef(false);
  searchOpenRef.current = searchOpen;
  const searchButton = useRef<HTMLButtonElement>(null);
  /** Personne choisie dans la recherche, à montrer dès que les lignes affichées sont à jour. */
  const pendingReveal = useRef<{ id: string; name: string; cleared: boolean } | null>(null);
  const uid = useId();
  // Lignes affichées : personnes filtrées (et triées) ; `data` reste la référence des éditeurs et des listes de choix.
  const shown = useMemo(() => applyViewFilters(data, filters), [data, filters]);
  const hiddenIds = useMemo(() => {
    const visible = new Set(shown.people.map((p) => p.id));
    return new Set(data.people.filter((p) => !visible.has(p.id)).map((p) => p.id));
  }, [data.people, shown]);
  const searchPeople = useMemo(() => data.people.map((p) => ({ id: p.id, name: p.name })), [data.people]);
  const searchProjects = useMemo(() => data.projects.map((p) => ({ id: p.id, name: p.name, color: p.color ?? null })), [data.projects]);
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
  const blockRect = (key: string) => {
    const r = gridRef.current?.querySelector<HTMLElement>(`.wn-block[data-key="${key}"]`)?.getBoundingClientRect();
    return r && r.width > 0 && r.height > 0 ? { left: r.left, top: r.top, width: r.width, height: r.height } : null;
  };
  const edits = useScheduleEdits(i18n, editor, data, focusKey, history !== undefined, blockRect);
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
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (!isSearchShortcut(e)) return;
      if (searchOpenRef.current) { e.preventDefault(); return; }
      // Événement déjà traité, ou zone de texte où la touche sert à l'édition (un champ simple, lui, ouvre la palette).
      if (e.defaultPrevented || inTextArea(e.target)) return;
      // Une autre fenêtre modale (pop-in, import, confirmation) garde le clavier ; un menu ancré (aria-modal=false) ne le garde pas.
      if (document.querySelector('[role="dialog"]:not([aria-modal="false"]), [role="alertdialog"]')) return;
      e.preventDefault();
      setSearchOpen(true);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);
  const dataRef = useRef(data);
  dataRef.current = data;
  const blocksRef = useRef<BlockEditor | null>(null);
  /** Bouton de l'en-tête qui a ouvert le drawer (« Nouveau congé », « + Allocation ») : il retrouve le focus à la fermeture (RT-049). */
  const slotOpener = useRef<HTMLElement | null>(null);
  const slot = useSlotEditor({
    i18n, data, records, editor, history, catalog, me, announce: (text) => editsRef.current.announce(text),
    onDraftDone: (draft) => blocksRef.current?.clearDraft(draft),
    onClosed: ({ key, focus }) => {
      if (focus) focusKey(key ?? "", focus);
      else if (key) focusKey(key);
      else if (slotOpener.current?.isConnected) slotOpener.current.focus({ preventScroll: true });
      else gridRef.current?.focus({ preventScroll: true }); // depuis la grille (touche C, N…), congé et création rendent le focus à la grille
      slotOpener.current = null;
    },
  });
  const slotRef = useRef(slot);
  slotRef.current = slot;
  /** Personne et jour visés par une touche C (bloc focalisé, sinon première ligne au centre de la vue). */
  const openTimeoffAt = (target: EventTarget | null) => {
    const s = scroller.current;
    if (!s) return;
    const off = s.host.timeoffAt?.(target);
    if (off) { slot.openTimeoffEdit(off.timeoff.timeoffId); return; }
    const hit = s.host.blockAt(target);
    const personId = hit?.row.personId ?? s.host.model()?.rows[0]?.personId;
    if (personId) slot.openTimeoffAt(personId, hit?.block.startDate ?? fromDayNumber(Math.floor(s.view().center)));
  };
  /** « + Allocation » : personne du bloc focalisé (sinon à choisir), jour au centre de la vue (ou celui du bloc). */
  const openCreate = () => {
    const s = scroller.current;
    if (!s) return;
    const hit = s.host.blockAt(document.activeElement);
    const day = hit?.block.startDate ?? fromDayNumber(Math.floor(s.view().center));
    slot.openCreate({ personId: hit?.row.personId ?? null, startDate: day, endDate: day, draft: null });
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
    slot.openTimeoffAt(row.personId, fromDayNumber(dayNumber(m.from) + Math.floor((x - origin) / m.pxPerDay)));
  };
  const removal = useTeamRemoval({ i18n, editor: records?.teamRemovalSummary && records.removeFromTeam ? records as TeamRemovalEditor : undefined, data: () => records?.getState().data ?? dataRef.current,
    gridRef, blockAt: (t) => scroller.current?.host.blockAt(t) ?? null, announce: (text) => editsRef.current.announce(text),
    onRemoved: (ids) => history?.invalidate("allocations", ids) });
  const quickRef = useRef<QuickEntryHandle>(null);
  const editorRef = useRef(editor);
  editorRef.current = editor;

  // Le scroller est créé une seule fois : la date du jour et la locale lui sont poussées (setToday, setLabels), sans perdre
  // la position.
  const labelsFor = (i: I18n) => ({
    label: headerFormatter(i.locale), capacityLabel: capacityLabeler(i), capacityText: capacityTexter(i), blockLabel: blockLabeler(i), timeoffLabel: timeoffLabeler(i), gaugeLabel: gaugeLabeler(i),
  });
  const labelled = useRef(i18n);
  // widthPx/heightPx ne sont que la taille initiale : ensuite la grille remplit l'espace restant (CSS flex) et un
  // ResizeObserver pousse sa taille au scroller (fenêtre redimensionnée, barres ou filtres dépliés). Sans ResizeObserver
  // (jsdom), la taille initiale reste.
  const [size, setSize] = useState({ widthPx: initialWidthPx, heightPx: initialHeightPx });
  const { widthPx, heightPx } = size;
  useEffect(() => {
    const s = createScroller({
      root: gridRef.current!, data: shown, today, widthPx, heightPx, clock, zoom: zoomRef.current, density: densityRef.current, ...labelsFor(i18n),
      onViewChange: (v) => viewChange.current?.(v),
      ...(memory?.center !== undefined ? { center: memory.center } : {}), ...(memory?.scrollTop !== undefined ? { scrollTop: memory.scrollTop } : {}),
    });
    labelled.current = i18n;
    scroller.current = s;
    const blocks = createBlockEditor({
      root: gridRef.current!, host: s.host, clock, enabled: () => editorRef.current !== undefined,
      onCommit: (r) => editsRef.current.onCommit(r), onPreview: (p) => editsRef.current.onPreview(p),
      onOpen: (r) => slotRef.current.openEdit(r),
      onCreate: (r) => slotRef.current.openCreate(r),
    });
    blocksRef.current = blocks;
    return () => { blocks.destroy(); s.destroy(); scroller.current = null; blocksRef.current = null; };
  }, []);
  // Mémoire (PO-02) relevée dans le nettoyage d'un effet de mise en page : il passe avant le retrait du DOM, quand la
  // grille porte encore son défilement (le nettoyage d'un useEffect arrive après : élément détaché, scrollLeft à 0).
  useLayoutEffect(() => () => {
    const s = scroller.current;
    const root = gridRef.current;
    if (memory && s && root) { memory.zoom = s.zoom(); memory.center = s.view().center; memory.scrollTop = root.scrollTop; }
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
    revealPending();
  }, [shown]);
  // Fenêtre refermée : la personne choisie est montrée ; sans choix, le focus ne reste pas perdu sur le corps de la page.
  useEffect(() => {
    if (searchOpen) return;
    if (pendingReveal.current) revealPending();
    else if (document.activeElement === document.body && searchButton.current?.isConnected) searchButton.current.focus({ preventScroll: true });
  }, [searchOpen]);
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

  function revealPending() {
    const p = pendingReveal.current;
    if (!p) return;
    pendingReveal.current = null;
    if (!scroller.current?.revealPerson(p.id)) return;
    gridRef.current?.focus({ preventScroll: true });
    editsRef.current.announce(t(p.cleared ? "schedule.search.revealed.cleared" : "schedule.search.revealed", { name: p.name }));
  }
  const pickSearch = (item: SearchItem) => {
    setSearchOpen(false);
    if (item.kind === "project") { onOpenProject?.(item.id); return; }
    // La palette a déjà obtenu la confirmation d'une personne masquée.
    const cleared = hiddenIds.has(item.id);
    pendingReveal.current = { id: item.id, name: item.name, cleared };
    if (cleared) { setRemovedFilters(filters); setFilters(clearCriteria(filters)); }
  };
  const restoreFilters = () => {
    if (!removedFilters) return;
    setFilters(removedFilters);
    setRemovedFilters(null);
    gridRef.current?.focus({ preventScroll: true }); // le bouton disparaît : le focus ne reste pas perdu
    editsRef.current.announce(t("schedule.filters.restored"));
  };
  const zoomTo = (z: Zoom) => { scroller.current?.setZoom(z); setZoom(z); };
  const densityTo = (d: Density) => { scroller.current?.setDensity(d); setDensityState(d); storeDensity(d); };
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
    <div className="wn-schedule" data-density={density} {...(showLoad ? { "data-load": "on" } : {})}>
      <div className="wn-subheader">
        {heading}
        {views && <ViewsBar i18n={i18n} shownCount={shown.people.length} source={views} filters={filters} zoom={zoom} density={density} onFilters={changeFilters} onZoom={zoomTo} onDensity={densityTo} />}
        <div className="wn-subheader-end">
          {actions}
          <Button ref={searchButton} type="button" aria-haspopup="dialog" aria-keyshortcuts="Control+K Meta+K" onClick={() => setSearchOpen(true)}>
            {t("schedule.search.open")}
            <kbd data-shortcut="" className="rounded-sm border border-solid border-input bg-muted px-1 font-[inherit] text-caption text-muted-foreground">{searchShortcutLabel()}</kbd>
          </Button>
          {records && (
            <>
              <Button type="button" aria-keyshortcuts="C" aria-haspopup="dialog" onClick={(e) => { const from = document.activeElement; slotOpener.current = e.currentTarget; openTimeoffAt(from); }}>{t("schedule.timeoff.new")}</Button>
              <Button type="button" variant="primary" aria-haspopup="dialog" onClick={(e) => { slotOpener.current = e.currentTarget; openCreate(); }}>{t("schedule.slot.add")}</Button>
            </>
          )}
        </div>
      </div>
      <div role="toolbar" aria-label={t("schedule.toolbar.label")} className="wn-toolbar">
        {views && (
          <>
            <FiltersButton i18n={i18n} filters={filters} expanded={filtersOpen} controls={`${uid}-filters`} onToggle={() => setFiltersOpen((o) => !o)} />
            <FilterChips i18n={i18n} data={data} filters={filters} onFilters={changeFilters} />
            {removedFilters && <Button type="button" onClick={restoreFilters}>{t("schedule.filters.restore")}</Button>}
          </>
        )}
        <div className="wn-toolbar-spacer" />
        {history && (
          <>
            <Button type="button" disabled={!stack.canUndo} aria-keyshortcuts="Control+Z Meta+Z" onClick={() => stepRef.current("undo")}>
              {t("schedule.history.undo")}
            </Button>
            <Button type="button" disabled={!stack.canRedo} aria-keyshortcuts="Control+Shift+Z Control+Y Meta+Shift+Z" onClick={() => stepRef.current("redo")}>
              {t("schedule.history.redo")}
            </Button>
          </>
        )}
        <Button type="button" onClick={() => scroller.current?.step(-1)}>{t("schedule.prev")}</Button>
        <Button type="button" onClick={() => scroller.current?.today()}>{t("schedule.today")}</Button>
        <Button type="button" onClick={() => scroller.current?.step(1)}>{t("schedule.next")}</Button>
        <div role="group" aria-label={t("schedule.zoom.label")} className="wn-button-group">
          {ZOOMS.map((z) => (
            <Button key={z} type="button" aria-pressed={zoom === z} onClick={() => zoomTo(z)}>
              {t(`schedule.zoom.${z}`)}
            </Button>
          ))}
        </div>
        <Button ref={displayButton} type="button" aria-haspopup="dialog" aria-expanded={displayOpen} onClick={() => setDisplayOpen((o) => !o)}>{t("schedule.display")}</Button>
        <span className="wn-people-count">{t("schedule.people.count", { count: shown.people.length })}</span>
      </div>
      {views && filtersOpen && <FiltersPanel i18n={i18n} data={data} filters={filters} onFilters={changeFilters} id={`${uid}-filters`} />}
      {displayOpen && displayButton.current && (
        <Popover anchor={displayButton.current} label={t("schedule.display")} className="wn-display-menu" onClose={() => setDisplayOpen(false)}>
          <RadioGroup aria-label={t("schedule.density.label")} value={density} onValueChange={(v) => densityTo(v as Density)}
            className="inline-flex overflow-hidden rounded-md border border-solid border-input">
            {DENSITIES.map((d) => <RadioItem key={d} value={d} variant="segment">{t(`schedule.density.${d}`)}</RadioItem>)}
          </RadioGroup>
          <Switch checked={showLoad} onCheckedChange={setShowLoad}>{t("schedule.display.load")}</Switch>
        </Popover>
      )}
      {records && (
        <QuickEntry ref={quickRef} i18n={i18n} data={data} today={today} createAllocation={records.createAllocation} listProjects={records.listProjects} onProjectsChange={records.onProjectsChange} record={history?.record}
          announce={(text) => editsRef.current.announce(text)} onExit={() => gridRef.current?.focus({ preventScroll: true })} />
      )}
      <div ref={gridRef} role="grid" aria-label={t("schedule.grid.label")} tabIndex={0} onKeyDown={onKeyDown}
        onClick={(e) => { const off = records && scroller.current?.host.timeoffAt?.(e.target); if (off) slot.openTimeoffEdit(off.timeoff.timeoffId); }}
        onDoubleClick={records ? onDoubleClick : undefined}
        className="wn-grid" />
      {searchOpen && (
        <SearchPalette i18n={i18n} people={searchPeople} hiddenIds={hiddenIds} onPick={pickSearch} onClose={() => setSearchOpen(false)}
          {...(onOpenProject ? { projects: searchProjects, ...(records?.listProjects ? { listProjects: records.listProjects } : {}) } : {})} />
      )}
      {slot.element}
      {removal.element}
      {edits.element}
    </div>
  );
}
