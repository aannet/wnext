// Modèle de la grille du Schedule (ADR-005 : DOM virtualisé A2), sans DOM : ce que le rendu doit dessiner, en pixels.
//  * Une ligne par personne, dans l'ordre du snapshot ; hauteur = ROW_UNIT_PX × hauteur du layout (≥ 1, plus en cas
//    d'empilement au-delà de 100 %, BR-01 : visible, jamais bloqué).
//  * Les séries répétées sont développées dans la fenêtre (expandOccurrences) ; clé d'un bloc = « allocation:rang »,
//    stable d'un rendu à l'autre (recyclage des nœuds).
//  * Le texte d'un bloc est une donnée (nom du projet), pas une chaîne d'interface.
//  * Construit par tranches au défilement continu : regroupement par personne mis en cache par snapshot, allocations
//    simples hors fenêtre écartées avant tout calcul de dates.
//  * Bande de capacité (BR-01 signalée, BR-07 tentatif distinct) en pied de chaque ligne : une cellule par jour, semaine ou
//    mois selon le zoom, calculée ici (par tranche, jamais au redessin) avec les heures du moteur ; le ratio n'est pas
//    transporté, il est calculé à partir des heures. Hauteur de ligne = blocs + CAP_PX. Capacité selon l'horaire en vigueur
//    à chaque date (BR-19 : SchedulePerson.workSchedule, lu par le moteur).
//  * Congés : un fond par congé et par personne, sur toute la hauteur des blocs (les allocations restent visibles par-dessus :
//    c'est le conflit BR-04). Demi-journée = demi-cellule (après-midi : commence au milieu du jour ; matin : finit au milieu).
//    Couleur dérivée du type (le contrat n'en porte pas), statut « en attente » / « refusé » rendu par un motif (grid-dom).
import type { ScheduleResponse } from "@wnext/contracts";
import {
  blockFraction, capacityCellsByPerson, dayNumber, expandOccurrences, layoutRow, scheduleToEngineInput, utilization,
  workDaysHoursOn, type CapacityCell, type LayoutBlock, type ScheduleEngineInput, type Zoom,
} from "@wnext/engine";

/** Hauteur d'une ligne à 100 % de la journée de référence. Valeur provisoire, à régler à l'écran. */
export const ROW_UNIT_PX = 48;
/** Hauteur de la bande de capacité en pied de ligne. */
export const CAP_PX = 14;

export interface GridBlock {
  key: string;
  allocationId: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Couleur du projet ; null si le projet n'est pas chargé. */
  color: string | null;
  label: string;
  tentative: boolean;
  clippedStart: boolean;
  clippedEnd: boolean;
  /** Dates de l'occurrence (non rognées), quantité et répétition : libellé accessible du bloc. */
  startDate: string;
  endDate: string;
  hoursPerDay: number | null;
  percent: number | null;
  repeat: "none" | "daily" | "weekly" | "monthly";
}

/**
 * Cellule de capacité (une période du zoom). Hauteurs en pixels entiers dans la bande de CAP_PX : confirmé puis tentatif
 * empilés depuis le bas, `overPx` = zone de dépassement tout en haut (au-dessus de la ligne de capacité), `lineY` = position
 * de la ligne (depuis le haut). Heures arrondies au dixième (libellés).
 */
export interface GridCap {
  from: string;
  to: string;
  kind: Zoom;
  x: number;
  w: number;
  /** none : aucune capacité ni charge (neutre) ; over : au moins un jour en surcharge ; ok : sinon. */
  state: "none" | "ok" | "over";
  confirmedPx: number;
  tentativePx: number;
  overPx: number;
  lineY: number;
  plannedHours: number;
  capacityHours: number;
  tentativeHours: number;
  overtimeHours: number;
  overbookedDays: number;
}

export interface GridTimeoff {
  key: string;
  timeoffId: string;
  x: number;
  w: number;
  /** Hauteur de la zone des blocs (le congé est derrière eux). */
  h: number;
  /** Index de couleur du type (palette de grid-dom), stable pour un même type. */
  tone: number;
  /** Nom du type (donnée) ; vide si le type n'est pas chargé. */
  typeName: string;
  status: "pending" | "approved" | "declined";
  scope: "full_day" | "partial";
  hoursPerDay: number | null;
  startDate: string;
  endDate: string;
  startHalf: "am" | "pm";
  endHalf: "am" | "pm";
}

/** Nombre de teintes de congé (palette de grid-dom). */
export const TIMEOFF_TONES = 4;
const toneOf = (typeId: string) => [...typeId].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % TIMEOFF_TONES;

export interface GridRow {
  personId: string; name: string; top: number; heightPx: number; overflow: boolean; blocks: GridBlock[];
  /** Congés de la personne qui touchent la tranche (fonds derrière les blocs). */
  timeoffs: GridTimeoff[];
  /** Ordonnée de la bande de capacité dans la ligne (sous les blocs). */
  capY: number;
  cells: GridCap[];
}

export interface GridModel { from: string; to: string; pxPerDay: number; widthPx: number; heightPx: number; rows: GridRow[] }

type Alloc = ScheduleResponse["allocations"][number];
type Timeoff = ScheduleResponse["timeoffs"][number];
const groupedTimeoffs = new WeakMap<ScheduleResponse, Map<string, Timeoff[]>>();
function timeoffsByPersonOf(s: ScheduleResponse): Map<string, Timeoff[]> {
  let m = groupedTimeoffs.get(s);
  if (!m) {
    m = new Map();
    for (const t of s.timeoffs) (m.get(t.personId) ?? m.set(t.personId, []).get(t.personId)!).push(t);
    groupedTimeoffs.set(s, m);
  }
  return m;
}

/** Congés d'une ligne : rognés à la tranche, demi-journées en demi-cellules. */
function rowTimeoffs(list: readonly Timeoff[], types: ReadonlyMap<string, string>, range: { from: string; to: string }, pxPerDay: number, h: number): GridTimeoff[] {
  const origin = dayNumber(range.from);
  const out: GridTimeoff[] = [];
  for (const t of list) {
    if (t.startDate > range.to || t.endDate < range.from) continue;
    const start = t.startDate < range.from ? range.from : t.startDate;
    const end = t.endDate > range.to ? range.to : t.endDate;
    const half = pxPerDay / 2;
    const x = (dayNumber(start) - origin) * pxPerDay + (start === t.startDate && t.startHalf === "pm" ? half : 0);
    const right = (dayNumber(end) - origin + 1) * pxPerDay - (end === t.endDate && t.endHalf === "am" ? half : 0);
    out.push({
      key: t.id, timeoffId: t.id, x, w: right - x, h, tone: toneOf(t.typeId), typeName: types.get(t.typeId) ?? "", status: t.approvalStatus,
      scope: t.scope, hoursPerDay: t.hoursPerDay, startDate: t.startDate, endDate: t.endDate, startHalf: t.startHalf, endHalf: t.endHalf,
    });
  }
  return out;
}

const grouped = new WeakMap<ScheduleResponse, Map<string, Alloc[]>>();
function byPersonOf(s: ScheduleResponse): Map<string, Alloc[]> {
  let m = grouped.get(s);
  if (!m) {
    m = new Map();
    for (const a of s.allocations) (m.get(a.personId) ?? m.set(a.personId, []).get(a.personId)!).push(a);
    grouped.set(s, m);
  }
  return m;
}

// Entrée du moteur par snapshot (sans allocations de projet inconnu ni congés de type inconnu : le modèle ne lève jamais),
// mise en cache comme le regroupement par personne.
const engineInputs = new WeakMap<ScheduleResponse, ScheduleEngineInput>();
function engineInputOf(s: ScheduleResponse): ScheduleEngineInput {
  let e = engineInputs.get(s);
  if (!e) {
    const projects = new Set(s.projects.map((p) => p.id));
    const types = new Set(s.timeoffTypes.map((t) => t.id));
    e = scheduleToEngineInput({ ...s, allocations: s.allocations.filter((a) => projects.has(a.projectId)), timeoffs: s.timeoffs.filter((t) => types.has(t.typeId)) });
    engineInputs.set(s, e);
  }
  return e;
}

const round1 = (h: number) => Math.round(h * 10) / 10;

/** Cellules par personne : seules les périodes entièrement dans la fenêtre du snapshot (une période partielle serait trompeuse). */
function capCells(s: ScheduleResponse, range: { from: string; to: string }, zoom: Zoom, pxPerDay: number): Map<string, GridCap[]> {
  const r = { from: range.from > s.window.from ? range.from : s.window.from, to: range.to < s.window.to ? range.to : s.window.to };
  if (r.from > r.to) return new Map();
  const input = engineInputOf(s);
  // Seules les allocations qui recoupent la tranche (ou les séries) entrent dans le calcul : le coût suit la tranche, pas le snapshot.
  const allocations = input.allocations.filter((a) => a.repeatState !== "none" || (a.startDate <= r.to && a.endDate >= r.from));
  const rows = utilization({ ...input, allocations, from: r.from, to: r.to });
  const origin = dayNumber(range.from);
  const out = new Map<string, GridCap[]>();
  for (const [id, cells] of capacityCellsByPerson(rows, r, zoom, s.account.weekStart, input.thresholds)) {
    out.set(id, cells.filter((c) => c.from >= r.from && c.to <= r.to)
      .map((c) => toCap(c, zoom, (dayNumber(c.from) - origin) * pxPerDay, (dayNumber(c.to) - dayNumber(c.from) + 1) * pxPerDay)));
  }
  return out;
}

function toCap(c: CapacityCell, kind: Zoom, x: number, w: number): GridCap {
  const a = c.aggregate;
  const b = c.bar;
  const over = a.overbookedDays > 0 || a.state === "over";
  const tentativePx = b.tentative > 0 ? Math.max(1, Math.round(b.tentative * CAP_PX)) : 0;
  const confirmedPx = Math.min(CAP_PX - tentativePx, b.confirmed > 0 ? Math.max(1, Math.round(b.confirmed * CAP_PX)) : 0);
  return {
    from: c.from, to: c.to, kind, x, w,
    state: over ? "over" : a.capacityHours <= 0 && a.plannedHours <= 0 ? "none" : "ok",
    confirmedPx, tentativePx, overPx: b.over > 0 ? Math.max(1, Math.round(b.over * CAP_PX)) : 0,
    lineY: Math.min(CAP_PX - 2, Math.max(0, CAP_PX - Math.round(b.capacityLine * CAP_PX))),
    plannedHours: round1(a.plannedHours), capacityHours: round1(a.capacityHours), tentativeHours: round1(a.tentativeHours),
    overtimeHours: round1(a.overtimeHours), overbookedDays: a.overbookedDays,
  };
}

export function buildGrid(s: ScheduleResponse, range: { from: string; to: string }, pxPerDay: number, zoom: Zoom = "day"): GridModel {
  const projects = new Map(s.projects.map((p) => [p.id, p]));
  const byPerson = byPersonOf(s);
  const timeoffsByPerson = timeoffsByPersonOf(s);
  const typeNames = new Map(s.timeoffTypes.map((t) => [t.id, t.name]));
  const caps = capCells(s, range, zoom, pxPerDay);
  let top = 0;
  const rows = s.people.map((p): GridRow => {
    const source = new Map<string, { a: Alloc; startDate: string; endDate: string }>();
    const blocks: LayoutBlock[] = [];
    for (const a of byPerson.get(p.id) ?? []) {
      if (a.repeatState === "none" && (a.startDate > range.to || a.endDate < range.from)) continue;
      for (const o of expandOccurrences(a, range.from, range.to)) {
        const key = `${a.id}:${o.index}`;
        source.set(key, { a, startDate: o.startDate, endDate: o.endDate });
        // Journée de référence : horaire en vigueur au début de l'occurrence (BR-19).
        blocks.push({ id: key, startDate: o.startDate, endDate: o.endDate, fraction: blockFraction(a, workDaysHoursOn(p, o.startDate)) });
      }
    }
    const lay = layoutRow(blocks, range.from, range.to);
    const blocksPx = lay.height * ROW_UNIT_PX;
    const row: GridRow = {
      personId: p.id, name: p.name, top, heightPx: blocksPx + CAP_PX, overflow: lay.overflow, capY: blocksPx, cells: caps.get(p.id) ?? [],
      timeoffs: rowTimeoffs(timeoffsByPerson.get(p.id) ?? [], typeNames, range, pxPerDay, blocksPx),
      blocks: lay.placed.map((b) => {
        const { a, startDate, endDate } = source.get(b.id)!;
        const pr = projects.get(a.projectId);
        return {
          key: b.id, allocationId: a.id, x: b.col * pxPerDay, w: b.span * pxPerDay, y: b.y * ROW_UNIT_PX, h: b.h * ROW_UNIT_PX,
          color: pr?.color ?? null, label: pr?.name ?? "", tentative: a.status === "tentative", clippedStart: b.clippedStart, clippedEnd: b.clippedEnd,
          startDate, endDate, hoursPerDay: a.mode === "hours" ? a.hoursPerDay : null, percent: a.mode === "percentage" ? a.percent : null,
          repeat: a.repeatState,
        };
      }),
    };
    top += row.heightPx;
    return row;
  });
  const days = Math.round((Date.parse(range.to) - Date.parse(range.from)) / 86_400_000) + 1;
  return { from: range.from, to: range.to, pxPerDay, widthPx: days * pxPerDay, heightPx: top, rows };
}

/** Indices des lignes qui touchent [scrollTop, scrollTop + viewHeight[, plus `overscan` lignes de chaque côté. */
export function visibleRows(g: GridModel, scrollTop: number, viewHeight: number, overscan = 3): number[] {
  const rows = g.rows;
  // Recherche dichotomique de la première ligne dont le bas dépasse scrollTop (tops croissants).
  let lo = 0;
  let hi = rows.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (rows[mid]!.top + rows[mid]!.heightPx <= scrollTop) lo = mid + 1;
    else hi = mid;
  }
  let last = lo;
  while (last < rows.length && rows[last]!.top < scrollTop + viewHeight) last++;
  const out: number[] = [];
  for (let i = Math.max(0, lo - overscan); i < Math.min(rows.length, last + overscan); i++) out.push(i);
  return out;
}
