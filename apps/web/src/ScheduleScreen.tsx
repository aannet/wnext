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
//    (clic = sélection ; double clic, Entrée ou clic sur le bloc sélectionné = édition), création par clic / glisser en zone
//    libre (bloc provisoire) ou par la touche N (RT-060), onglets « Projet / tâche » et « Congé ».
//  * Création au clavier (recette n°4, D1 : RT-057, RT-060, ADR-002 §5 amendé) : ni barre de saisie rapide ni boutons de
//    création. N ouvre le drawer de création prérempli (personne du bloc focalisé, sinon première ligne visible ; jour du bloc,
//    sinon aujourd'hui). Fermé sans écriture, il rend le focus au bloc d'origine, sinon à la grille. N, C et T sont annoncés
//    par aria-keyshortcuts sur la grille ; les touches viennent de shell/shortcuts (source unique de l'aide, RT-064). Une
//    grille sans aucun bloc porte une indication unique (« Cliquez ou glissez dans la grille pour planifier »).
//  * Congés (BR-04, schedule/timeoff-ui, dans l'onglet « Congé » de la pop-in) : touche C sur la grille (sur un bloc : sa
//    personne et son premier jour ; sinon la première ligne visible ; sur un congé, ou un jour couvert par un congé :
//    modification), clic ou Entrée sur un congé pour le modifier, double clic sur une case vide pour en créer un.
//  * Vues sauvegardées (schedule/views-ui) si une source de vues est fournie : filtres (département, rôle, projet, personne, tri)
//    appliqués côté client aux lignes (schedule/view-filters) ; seule la grille reçoit les données filtrées, les éditeurs gardent
//    les données complètes. Les vues vivent dans le panneau Filtres (RT-058) : « Vue » en tête, enregistrement en pied, nom de
//    la vue active sur le bouton Filtres.
//  * Recherche (RT-038, RT-059) : le bouton « Rechercher », le raccourci Ctrl+K et la palette appartiennent à la coque
//    (shell/global-search) ; l'écran s'y inscrit comme cible (useSearchTarget) avec ses personnes, celles masquées par les
//    filtres, ses projets et son choix. Une personne choisie est amenée dans la vue et mise en évidence (Scroller.revealPerson),
//    focus à la grille, annoncé ; `reveal` fait de même au montage (Planning ouvert depuis un autre écran, ?personne=). Si un filtre la
//    masque, la palette demande confirmation ; confirmée, les critères sont retirés (le tri est gardé) et la barre des filtres propose
//    « Rétablir les filtres » (les critères d'avant, à l'identique) jusqu'au prochain changement de filtre ou de vue. Cela n'a rien
//    à voir avec l'historique des allocations (Ctrl+Z). Un projet choisi est confié à `onOpenProject` (écran Projets). Rien n'est
//    enregistré dans les vues.
//  * Retrait d'un projet (BR-10, schedule/team-removal-ui) si la source le permet : menu contextuel d'un bloc.
//  * Commandes d'un bloc (RT-047, US-3.2, schedule/block-commands) sur un bloc modifiable (écritures fournies ; chef de projet :
//    ses projets seulement, BR-33, d'après le référentiel) : Suppr ou Retour arrière supprime (tout de suite et annoncé, ou étape
//    de portée série / groupe dans le drawer), Ctrl+D (Cmd+D) duplique juste après le bloc (copie sélectionnée et focalisée),
//    S ouvre l'étape « Scinder » ; mêmes commandes en tête du menu contextuel, et Alt + glisser à la souris copie le bloc à la
//    place du fantôme. Toutes annulables par Ctrl+Z, sauf la suppression d'une occurrence (découpe).
//  * En-tête sur une seule ligne (RT-025 ; recette n°4, « Planning cible ») : le titre puis la barre d'outils = Filtres (compteur,
//    nom de la vue, puces, panneau dépliable avec les vues, schedule/filters-ui), statut (`actions`), annuler / rétablir,
//    navigation, zoom, menu Affichage. Le nombre de personnes affichées est dans le coin de la grille, au-dessus de la colonne
//    Personnes (RT-061).
//  * Menu Affichage (Popover) : densité et bascule « Charge » (RT-052, D3, amende Q11) : affiche ou masque toute la bande de
//    capacité (graphique et chiffres) ; éteinte, les lignes sont raccourcies. Active au montage, état en mémoire seulement.
//  * Densité (RT-005 à RT-007, schedule/density) : contrôle segmenté (groupe de boutons radio, flèches gauche / droite) dans
//    le menu Affichage, appliquée à la volée (hauteurs du modèle, tailles CSS par data-density), mémorisée dans ce navigateur
//    et portée par les vues sauvegardées. Colonne de gauche : avatar, nom, rôle, département et jauge de la période visible.
//  * Mémoire de l'écran (PO-02) : `memory`, tenu par l'appelant au-dessus du démontage, reçoit au démontage le zoom, le jour
//    au centre et le défilement vertical, et les rend au montage suivant. La pile d'annulation n'y est pas : la source est
//    arrêtée hors du Planning, les changements des autres n'y sont pas suivis et l'historique ne pourrait plus les invalider.
import type { I18n } from "@lingui/core";
import type { Me, ProjectDetail, ScheduleResponse } from "@wnext/contracts";
import { dayNumber, fromDayNumber, type HeaderCell, type Viewport, type Zoom } from "@wnext/engine";
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent, type ReactNode } from "react";
import type { Allocation, ScheduleEditor } from "./data/allocation-edits";
import type { ScheduleSource } from "./data/schedule-source";
import type { ViewsSource } from "./data/views-source";
import type { MessageKey } from "./i18n";
import { createBlockEditor, type BlockEditor, type CopyRequest } from "./schedule/block-editor";
import { duplicateAllocation, type CopyPlace } from "./schedule/block-commands";
import { canWriteProject, slotErrorKey } from "./schedule/slot-model";
import { blockLabeler } from "./schedule/block-label";
import { timeoffLabeler } from "./schedule/timeoff-label";
import { capacityLabeler, capacityTexter } from "./schedule/capacity-label";
import { useScheduleEdits, type FocusTarget } from "./schedule/edits-ui";
import type { History, HistoryDirection, HistoryResult, HistoryState } from "./schedule/history";
import { createScroller, type Clock, type Scroller } from "./schedule/scroller";
import { useSlotEditor, type SlotCatalog } from "./schedule/slot-editor-ui";
import { applyViewFilters, clearCriteria, type ViewFilters } from "./schedule/view-filters";
import type { SearchItem } from "./schedule/search-model";
import { useSearchTarget } from "./shell/global-search";
import { DENSITIES, readStoredDensity, storeDensity, type Density } from "./schedule/density";
import { gaugeLabeler } from "./schedule/gauge-label";
import { useSavedViews } from "./schedule/views-ui";
import { FilterChips, FiltersButton, FiltersPanel } from "./schedule/filters-ui";
import { useTeamRemoval, type MenuCommand } from "./schedule/team-removal-ui";
import type { TeamRemovalEditor } from "./data/team-removal";
import { Button, Popover, RadioGroup, RadioItem, Switch } from "./design";
import { ariaKeys, matches } from "./shell/shortcuts";

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
  /** Zone de la barre d'outils, après les filtres (statut du temps réel, chargement) ; absent : rien. */
  actions?: ReactNode;
  /** Écritures brutes de la source (congés, report assisté) ; absent : congés en lecture seule. */
  records?: Pick<ScheduleSource, "getState" | "updateAllocation" | "splitOccurrence" | "createTimeoff" | "updateTimeoff" | "deleteTimeoff"
    | "createAllocation" | "deleteAllocation" | "loggedTime"> & Partial<Pick<ScheduleSource, "listProjects" | "onProjectsChange" | "teamRemovalSummary" | "removeFromTeam"
    | "createAllocationGroup" | "projectChanged" | "deleteAllocationGroup" | "deleteOccurrence">>;
  /** Référentiel des projets (projets autorisés, tâches, couleur) pour la pop-in ; absent : projets de la source, sans tâches ni couleur. */
  catalog?: SlotCatalog;
  /** Utilisateur connecté : projets proposés et commandes des blocs selon ses droits (BR-33) ; absent : tous. */
  me?: Pick<Me, "role" | "person"> & Partial<Pick<Me, "user">>;
  /** État gardé d'un montage à l'autre (PO-02) ; absent : l'écran repart d'aujourd'hui, zoom jour. */
  memory?: ScheduleMemory;
  /** Personne à révéler au montage (recherche lancée depuis un autre écran, ?personne=, RT-059) ; `onDone` prévient l'appelant. */
  reveal?: { personId: string; onDone?(): void };
}

/** Ce que l'écran rend au montage suivant (objet mutable tenu par l'appelant). */
export interface ScheduleMemory { zoom?: Zoom; center?: number; scrollTop?: number }

const ZOOMS: readonly Zoom[] = ["day", "week", "month"];
const NO_HISTORY: HistoryState = { canUndo: false, canRedo: false, undoLabel: null, redoLabel: null };
const noSubscribe = () => () => {};
const LABELS: Record<string, string> = { "allocation.move": "move", "allocation.resize": "resize", "allocation.load": "load", "allocation.create": "create", "allocation.edit": "edit" };
/** Libellés d'historique au féminin (suppression, duplication, scission : RT-047). */
const LABELS_F: Record<string, string> = { "allocation.delete": "delete", "allocation.duplicate": "duplicate", "allocation.split": "split" };
const isMac = () => /mac|iphone|ipad/i.test(globalThis.navigator?.platform ?? "");

/** Cible où Ctrl+Z appartient au navigateur (champ de saisie) ou à une boîte de dialogue ouverte. */
function ownsUndo(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  return t.isContentEditable || t.matches("input, textarea, select") || t.closest("[role=dialog]") !== null;
}

/** Raccourci d'historique d'un événement clavier (Ctrl ou Cmd, sans Alt), ou null. */
export function historyShortcut(e: Pick<globalThis.KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey">): HistoryDirection | null {
  return matches("undo", e) ? "undo" : matches("redo", e) ? "redo" : null;
}

function headerFormatter(locale: string) {
  const fmt = {
    day: new Intl.DateTimeFormat(locale, { weekday: "short", day: "numeric", timeZone: "UTC" }),
    week: new Intl.DateTimeFormat(locale, { day: "numeric", month: "short", timeZone: "UTC" }),
    month: new Intl.DateTimeFormat(locale, { month: "long", year: "numeric", timeZone: "UTC" }),
  };
  return (c: HeaderCell) => fmt[c.kind].format(new Date(`${c.from}T00:00:00Z`));
}

export function ScheduleScreen({ i18n, data, today, widthPx: initialWidthPx, heightPx: initialHeightPx, onViewChange, clock, editor, history, records, views, heading, actions, memory, catalog, me, onOpenProject, reveal }: ScheduleScreenProps) {
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
  /** Bande de capacité affichée (RT-052) : active au montage, en mémoire seulement, jamais enregistrée. */
  const [showLoad, setShowLoad] = useState(true);
  const showLoadRef = useRef(showLoad);
  showLoadRef.current = showLoad;
  const displayButton = useRef<HTMLButtonElement>(null);
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
  const pendingFocus = useRef<{ key: string; at: FocusTarget; select: boolean } | null>(null);
  /** `select` : le bloc retrouvé est aussi sélectionné (copie d'un bloc, RT-047). */
  const focusAt = (key: string, at: FocusTarget, select = false): boolean => {
    const grid = gridRef.current;
    const hits = scroller.current?.host.model()?.rows.find((r) => r.personId === at.personId)?.blocks
      .filter((b) => b.startDate === at.startDate && b.endDate === at.endDate) ?? [];
    const hit = hits.find((b) => b.key === key) ?? hits[0];
    const el = hit && grid?.querySelector<HTMLElement>(`.wn-block[data-key="${hit.key}"]`);
    if (!grid || !el) return false;
    const active = document.activeElement;
    if (el !== active && (active === null || active === document.body || grid.contains(active))) el.focus({ preventScroll: true });
    if (select) blocksRef.current?.select(hit.key);
    return true;
  };
  const focusKey = (key: string, at?: FocusTarget, select = false) => {
    if (at) { if (!focusAt(key, at, select)) pendingFocus.current = { key, at, select }; return; }
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
    if (r.ok && LABELS_F[r.label]) return t("schedule.history.allocation", { ...v, label: LABELS_F[r.label] });
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
  const blocksRef = useRef<BlockEditor | null>(null);
  /** Bloc focalisé quand N ou C a ouvert le drawer : il retrouve le focus à la fermeture sans écriture (sinon la grille). */
  const slotOrigin = useRef<string | null>(null);
  // Projets du référentiel pour les droits d'un chef de projet (BR-33) : lus au montage et relus quand la liste des projets change
  // (source temps réel, écran Projets) ; tant qu'ils manquent (ou sans référentiel), aucune commande : refus par défaut.
  const [managed, setManaged] = useState<ProjectDetail[] | null>(null);
  const pm = me?.role === "project_manager" && catalog !== undefined;
  useEffect(() => {
    if (!pm) return;
    let alive = true;
    let seq = 0; // une relecture plus ancienne, arrivée en retard, n'écrase pas la dernière
    const load = () => { const n = ++seq; void catalog!.listProjects().then((r) => { if (alive && n === seq && r.ok) setManaged(r.value); }); };
    load();
    const off = records?.onProjectsChange?.(load);
    return () => { alive = false; off?.(); };
  }, [pm]);
  /** Commandes d'un bloc permises (RT-047) : écritures fournies et droits sur le projet (BR-33 ; l'API reste juge). */
  const writable = (a: Allocation | undefined): a is Allocation => {
    if (!a || !editor || !records) return false;
    if (!me || me.role === "owner" || me.role === "admin") return true;
    if (me.role !== "project_manager") return false;
    const p = managed?.find((x) => x.id === a.projectId);
    return p !== undefined && canWriteProject(me, p);
  };
  const writableRef = useRef(writable);
  writableRef.current = writable;
  const slot = useSlotEditor({
    i18n, data, records, editor, history, catalog, me, announce: (text) => editsRef.current.announce(text),
    canCommand: (a) => writableRef.current(a),
    onDraftDone: (draft) => blocksRef.current?.clearDraft(draft),
    onClosed: ({ key, focus }) => {
      if (focus) focusKey(key ?? "", focus);
      else if (key) focusKey(key);
      else if (slotOrigin.current) focusKey(slotOrigin.current); // bloc d'origine (N ou C sur un bloc), sinon la grille
      else gridRef.current?.focus({ preventScroll: true }); // depuis la grille (touche C, N…), congé et création rendent le focus à la grille
      slotOrigin.current = null;
    },
  });
  const slotRef = useRef(slot);
  slotRef.current = slot;
  /** Première ligne visible (sous l'en-tête collant), sinon la première du modèle. */
  const firstVisiblePerson = (): string | undefined => {
    const rows = scroller.current?.host.model()?.rows ?? [];
    const top = gridRef.current?.scrollTop ?? 0;
    return (rows.find((r) => r.top + r.heightPx > top) ?? rows[0])?.personId;
  };
  /** Personne et jour visés par une touche C (bloc focalisé, sinon première ligne visible au centre de la vue). */
  const openTimeoffAt = (target: EventTarget | null) => {
    const s = scroller.current;
    if (!s) return;
    const off = s.host.timeoffAt?.(target);
    if (off) { slot.openTimeoffEdit(off.timeoff.timeoffId); return; }
    const hit = s.host.blockAt(target);
    const personId = hit?.row.personId ?? firstVisiblePerson();
    slotOrigin.current = hit?.block.key ?? null;
    if (personId) slot.openTimeoffAt(personId, hit?.block.startDate ?? fromDayNumber(Math.floor(s.view().center)));
  };
  /** Touche N (RT-060) : personne du bloc focalisé, sinon première ligne visible ; jour du bloc, sinon aujourd'hui. */
  const openCreate = (target: EventTarget | null) => {
    const s = scroller.current;
    if (!s) return;
    const hit = s.host.blockAt(target);
    const day = hit?.block.startDate ?? today;
    slotOrigin.current = hit?.block.key ?? null;
    slot.openCreate({ personId: hit?.row.personId ?? firstVisiblePerson() ?? null, startDate: day, endDate: day, draft: null });
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
  /** Copie d'un bloc (Ctrl+D, menu : juste après ; Alt + glisser : à la place du fantôme), sélectionnée et focalisée. */
  const duplicate = async (a: Allocation, occ: { startDate: string; endDate: string }, at?: CopyPlace) => {
    if (!records) return;
    const out = await duplicateAllocation({ records, history }, a, occ, at);
    if (!out.ok) { editsRef.current.announce(t(slotErrorKey(out.error))); return; }
    editsRef.current.announce(t("schedule.duplicate.done"));
    focusKey(`${out.id}:0`, { personId: out.body.personId, startDate: out.body.startDate, endDate: out.body.endDate }, true);
  };
  const allocationOf = (id: string) => dataRef.current.allocations.find((x) => x.id === id);
  /** Commandes d'un bloc (RT-047) : clavier et menu contextuel. */
  const blockCommand = (kind: "delete" | "duplicate" | "split", key: string, allocationId: string) => {
    const a = allocationOf(allocationId);
    if (!writableRef.current(a) || blocksRef.current?.busy()) return;
    const block = scroller.current?.host.model()?.rows.flatMap((r) => r.blocks).find((b) => b.key === key);
    if (kind === "delete") slotRef.current.requestDelete({ key, allocationId });
    else if (kind === "split") slotRef.current.requestSplit({ key, allocationId });
    else void duplicate(a, block ?? a);
  };
  const blockCommandRef = useRef(blockCommand);
  blockCommandRef.current = blockCommand;
  const menuCommands = (target: { allocationId: string; key: string }): MenuCommand[] => {
    const a = allocationOf(target.allocationId);
    if (!writableRef.current(a)) return [];
    const run = (kind: "delete" | "duplicate" | "split") => () => blockCommandRef.current(kind, target.key, target.allocationId);
    return [
      { id: "duplicate", label: t("schedule.menu.duplicate"), shortcut: t("schedule.key.duplicate", { mac: isMac() ? "yes" : "no" }), keys: "Control+D Meta+D", onSelect: run("duplicate") },
      ...(a.repeatState === "none" && a.startDate < a.endDate ? [{ id: "split", label: t("schedule.menu.split"), shortcut: "S", keys: "S", onSelect: run("split") }] : []),
      { id: "delete", label: t("schedule.menu.delete"), shortcut: t("schedule.key.delete"), keys: "Delete Backspace", onSelect: run("delete") },
    ];
  };
  const removal = useTeamRemoval({ i18n, editor: records?.teamRemovalSummary && records.removeFromTeam ? records as TeamRemovalEditor : undefined, data: () => records?.getState().data ?? dataRef.current,
    gridRef, blockAt: (t) => scroller.current?.host.blockAt(t) ?? null, announce: (text) => editsRef.current.announce(text),
    onRemoved: (ids) => history?.invalidate("allocations", ids),
    ...(records && editor ? { commands: menuCommands, writable: (id: string) => writableRef.current(allocationOf(id)) } : {}) });
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
      root: gridRef.current!, data: shown, today, widthPx, heightPx, clock, zoom: zoomRef.current, density: densityRef.current, showLoad: showLoadRef.current, ...labelsFor(i18n),
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
      onCopy: (r: CopyRequest) => {
        const a = allocationOf(r.allocation.id);
        if (writableRef.current(a)) void duplicate(a, r.draft, { personId: r.draft.personId, startDate: r.draft.startDate, endDate: r.draft.endDate });
      },
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
    if (p) focusAt(p.key, p.at, p.select);
    revealPending();
  }, [shown]);
  // Compteur de personnes affichées dans le coin de la grille (RT-061), annoncé poliment.
  const peopleCount = t("schedule.people.count", { count: shown.people.length });
  useEffect(() => { scroller.current?.setCornerLabel(peopleCount); }, [peopleCount]);
  // Planning ouvert depuis la recherche d'un autre écran (?personne=, RT-059) : la personne est montrée au montage.
  useEffect(() => {
    if (!reveal) return;
    const person = dataRef.current.people.find((p) => p.id === reveal.personId);
    if (person) { pendingReveal.current = { id: person.id, name: person.name, cleared: false }; revealPending(); }
    reveal.onDone?.();
  }, []);
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
  /** Choix de la palette (appelé une fois la fenêtre refermée, shell/global-search). */
  const pickSearch = (item: SearchItem) => {
    if (item.kind === "project") { onOpenProject?.(item.id); return; }
    // La palette a déjà obtenu la confirmation d'une personne masquée.
    const cleared = hiddenIds.has(item.id);
    pendingReveal.current = { id: item.id, name: item.name, cleared };
    if (cleared) { setRemovedFilters(filters); setFilters(clearCriteria(filters)); }
    else revealPending();
  };
  useSearchTarget({
    people: searchPeople, hiddenIds, onPick: pickSearch,
    ...(onOpenProject ? { projects: searchProjects, ...(records?.listProjects ? { listProjects: records.listProjects } : {}) } : {}),
  });
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
    const hit = onBlock ? s.host.blockAt(e.target) : null;
    const command = hit && hit.el === e.target
      ? matches("delete", e) ? "delete" : matches("duplicate", e) ? "duplicate" : matches("split", e) ? "split" : null
      : null;
    if (hit && command && writable(allocationOf(hit.block.allocationId))) { e.preventDefault(); blockCommand(command, hit.block.key, hit.block.allocationId); return; }
    if (records && matches("create", e)) { e.preventDefault(); openCreate(e.target); return; }
    if (records && matches("timeoff", e)) { e.preventDefault(); openTimeoffAt(e.target); return; }
    if (records && e.key === "Enter" && s.host.timeoffAt?.(e.target)) { e.preventDefault(); openTimeoffAt(e.target); return; }
    if (!onBlock && matches("firstBlock", e)) {
      const first = gridRef.current?.querySelector<HTMLElement>(".wn-block[data-key]");
      if (first) { e.preventDefault(); first.focus({ preventScroll: true }); }
      return;
    }
    if (matches("today", e)) s.today();
    else if (onBlock) return;
    else if (matches("scroll", e)) { e.preventDefault(); s.nudge(e.key === "ArrowLeft" ? -1 : 1); }
  };
  const saved = useSavedViews({ i18n, shownCount: shown.people.length, source: views, filters, zoom, density, onFilters: changeFilters, onZoom: zoomTo, onDensity: densityTo });

  return (
    <div className="wn-schedule" data-density={density}>
      {/* Une seule ligne au-dessus de la grille (recette n°4, « Planning cible ») : le titre, puis la barre d'outils. */}
      <div className="wn-subheader">
        {heading}
        <div role="toolbar" aria-label={t("schedule.toolbar.label")} className="wn-toolbar">
          {views && (
            <>
              <FiltersButton i18n={i18n} filters={filters} expanded={filtersOpen} controls={`${uid}-filters`} onToggle={() => setFiltersOpen((o) => !o)} view={saved.current} />
              <FilterChips i18n={i18n} data={data} filters={filters} onFilters={changeFilters} />
              {removedFilters && <Button type="button" onClick={restoreFilters}>{t("schedule.filters.restore")}</Button>}
              {saved.status}
            </>
          )}
          <div className="wn-toolbar-spacer" />
          {actions}
          {history && (
            <>
              <Button type="button" disabled={!stack.canUndo} aria-keyshortcuts={ariaKeys("undo")} onClick={() => stepRef.current("undo")}>
                {t("schedule.history.undo")}
              </Button>
              <Button type="button" disabled={!stack.canRedo} aria-keyshortcuts={ariaKeys("redo")} onClick={() => stepRef.current("redo")}>
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
        </div>
      </div>
      {views && filtersOpen && <FiltersPanel i18n={i18n} data={data} filters={filters} onFilters={changeFilters} id={`${uid}-filters`} header={saved.picker} footer={saved.actions} />}
      {saved.dialog}
      {displayOpen && displayButton.current && (
        <Popover anchor={displayButton.current} label={t("schedule.display")} className="wn-display-menu" onClose={() => setDisplayOpen(false)}>
          <RadioGroup aria-label={t("schedule.density.label")} value={density} onValueChange={(v) => densityTo(v as Density)}
            className="inline-flex overflow-hidden rounded-md border border-solid border-input">
            {DENSITIES.map((d) => <RadioItem key={d} value={d} variant="segment">{t(`schedule.density.${d}`)}</RadioItem>)}
          </RadioGroup>
          <Switch checked={showLoad} onCheckedChange={(on) => { scroller.current?.setShowLoad(on); setShowLoad(on); }}>{t("schedule.display.load")}</Switch>
        </Popover>
      )}
      {records && data.allocations.length === 0 && <p className="wn-grid-hint">{t("schedule.grid.hint")}</p>}
      <div ref={gridRef} role="grid" aria-label={t("schedule.grid.label")} tabIndex={0} onKeyDown={onKeyDown}
        aria-keyshortcuts={records ? ariaKeys("create", "timeoff", "today") : ariaKeys("today")}
        onClick={(e) => { const off = records && scroller.current?.host.timeoffAt?.(e.target); if (off) slot.openTimeoffEdit(off.timeoff.timeoffId); }}
        onDoubleClick={records ? onDoubleClick : undefined}
        className="wn-grid" />
      {slot.element}
      {removal.element}
      {edits.element}
    </div>
  );
}
