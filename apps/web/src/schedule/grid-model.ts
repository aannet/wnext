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
//  * Densité (schedule/density, RT-005) : hauteurs de bloc et de bande passées en paramètre (défaut : compacte, les valeurs
//    d'avant le réglage) et portées par le modèle (les gestes lisent rowUnitPx).
//  * Jauge par personne (RT-008, Q3 : période visible) : sommes cumulées par jour des heures de capacité, planifiées et
//    tentatives (les mêmes lignes utilization() que la bande), calculées une fois par tranche ; la jauge d'une période
//    quelconque en sort en O(1) (gaugeOf), état par classifyCapacity du moteur. Rôle, département et initiales : données.
//  * Jours non travaillés (RT-028, Q9) : plages de jours consécutifs à 0 h selon l'horaire de la personne en vigueur ce
//    jour-là (BR-19), hachurées par grid-dom ; les fériés et congés n'en font pas partie (ils ont leur propre rendu).
import type { ScheduleResponse } from "@wnext/contracts";
import {
  blockFraction, capacityCellsByPerson, classifyCapacity, dayNumber, type CapacityState, type CapacityThresholds, expandOccurrences, layoutRow, scheduleToEngineInput, utilization,
  workDaysHoursOn, fromDayNumber, type CapacityCell, type UtilizationRow, type LayoutBlock, type ScheduleEngineInput, type Zoom,
} from "@wnext/engine";

import { DENSITY_METRICS, type RowMetrics } from "./density";

/** Hauteur d'une ligne à 100 % de la journée de référence, en densité compacte (défaut de buildGrid). */
export const ROW_UNIT_PX = DENSITY_METRICS.compact.rowUnitPx;
/** Hauteur de la bande de capacité en pied de ligne, en densité compacte. */
export const CAP_PX = DENSITY_METRICS.compact.capPx;

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

/** Sommes cumulées par jour depuis `from` : l'indice i couvre les jours [from, from + i[ (longueur = jours + 1). */
export interface RowLoad { from: string; days: number; capacity: Float64Array; planned: Float64Array; tentative: Float64Array }

/** Jauge d'une personne sur une période (bornée aux jours chargés) ; heures arrondies au dixième. */
export interface GridGauge {
  from: string;
  to: string;
  plannedHours: number;
  capacityHours: number;
  /** Heures au-delà de la capacité sur la période (« +N h »). */
  overHours: number;
  /** Charge en % de la capacité ; null si capacité nulle. */
  percent: number | null;
  /** État du moteur ; « unavailable » : ni capacité ni charge (ou aucun jour chargé). */
  state: CapacityState;
  /** Remplissage de la barre (0..100). */
  fill: number;
}

export interface GridRow {
  personId: string; name: string;
  /** Initiales (avatar), nom du rôle et du département (données ; vides si absents). */
  initials: string; role: string; department: string;
  top: number; heightPx: number; overflow: boolean; blocks: GridBlock[];
  /** Congés de la personne qui touchent la tranche (fonds derrière les blocs). */
  timeoffs: GridTimeoff[];
  /** Ordonnée de la bande de capacité dans la ligne (sous les blocs). */
  capY: number;
  cells: GridCap[];
  /** Charge par jour pour la jauge ; null si aucun jour de la tranche n'est chargé. */
  load: RowLoad | null;
  /** Plages de jours non travaillés (horaire à 0 h), en pixels depuis le début de la tranche. */
  nonWorking: NonWorkingSpan[];
}

export interface NonWorkingSpan { x: number; w: number }

/** Jours consécutifs à 0 h dans l'horaire en vigueur (index 0 = lundi ; jour 0 = jeudi 1er janvier 1970). */
function nonWorkingSpans(p: ScheduleResponse["people"][number], range: { from: string; to: string }, pxPerDay: number): NonWorkingSpan[] {
  const first = dayNumber(range.from);
  const last = dayNumber(range.to);
  const out: NonWorkingSpan[] = [];
  let start = -1;
  for (let n = first; n <= last + 1; n++) {
    const off = n <= last && (p.workSchedule ? workDaysHoursOn(p, fromDayNumber(n)) : p.workDaysHours)[(n + 3) % 7] === 0;
    if (off && start < 0) start = n;
    else if (!off && start >= 0) { out.push({ x: (start - first) * pxPerDay, w: (n - start) * pxPerDay }); start = -1; }
  }
  return out;
}

export interface GridModel {
  from: string; to: string; pxPerDay: number; widthPx: number; heightPx: number; rows: GridRow[];
  /** Densité du modèle : hauteur des blocs à 100 % et de la bande de capacité. */
  rowUnitPx: number; capPx: number;
  thresholds: CapacityThresholds;
}

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

/**
 * Cellules par personne : seules les périodes entièrement dans la fenêtre du snapshot (une période partielle serait trompeuse).
 * Avec, des mêmes lignes du moteur, les sommes cumulées par jour de la jauge.
 */
function capCells(s: ScheduleResponse, range: { from: string; to: string }, zoom: Zoom, pxPerDay: number, capPx: number): { cells: Map<string, GridCap[]>; loads: Map<string, RowLoad> } {
  const r = { from: range.from > s.window.from ? range.from : s.window.from, to: range.to < s.window.to ? range.to : s.window.to };
  if (r.from > r.to) return { cells: new Map(), loads: new Map() };
  const input = engineInputOf(s);
  // Seules les allocations qui recoupent la tranche (ou les séries) entrent dans le calcul : le coût suit la tranche, pas le snapshot.
  const allocations = input.allocations.filter((a) => a.repeatState !== "none" || (a.startDate <= r.to && a.endDate >= r.from));
  const rows = utilization({ ...input, allocations, from: r.from, to: r.to });
  const origin = dayNumber(range.from);
  const out = new Map<string, GridCap[]>();
  for (const [id, cells] of capacityCellsByPerson(rows, r, zoom, s.account.weekStart, input.thresholds)) {
    out.set(id, cells.filter((c) => c.from >= r.from && c.to <= r.to)
      .map((c) => toCap(c, zoom, (dayNumber(c.from) - origin) * pxPerDay, (dayNumber(c.to) - dayNumber(c.from) + 1) * pxPerDay, capPx)));
  }
  return { cells: out, loads: rowLoads(rows, r) };
}

/** Sommes cumulées par personne et par jour (lignes du moteur, un jour = une ligne par personne). */
function rowLoads(rows: readonly UtilizationRow[], r: { from: string; to: string }): Map<string, RowLoad> {
  const first = dayNumber(r.from);
  const days = dayNumber(r.to) - first + 1;
  const index = new Map<string, number>();
  for (let i = 0; i < days; i++) index.set(fromDayNumber(first + i), i);
  const daily = new Map<string, Float64Array>();
  for (const u of rows) {
    const i = index.get(u.day);
    if (i === undefined) continue;
    let d = daily.get(u.personId);
    if (!d) { d = new Float64Array(days * 3); daily.set(u.personId, d); }
    d[i * 3] = u.capacityHours;
    d[i * 3 + 1] = u.plannedHours;
    d[i * 3 + 2] = u.tentativeHours;
  }
  const out = new Map<string, RowLoad>();
  for (const [id, d] of daily) {
    const capacity = new Float64Array(days + 1);
    const planned = new Float64Array(days + 1);
    const tentative = new Float64Array(days + 1);
    for (let i = 0; i < days; i++) {
      capacity[i + 1] = capacity[i]! + d[i * 3]!;
      planned[i + 1] = planned[i]! + d[i * 3 + 1]!;
      tentative[i + 1] = tentative[i]! + d[i * 3 + 2]!;
    }
    out.set(id, { from: r.from, days, capacity, planned, tentative });
  }
  return out;
}

/**
 * Jauge d'une ligne sur [period.from, period.to], bornée aux jours chargés de la tranche (la période affichée dans
 * l'infobulle est la période réellement comptée). État et dépassement par le moteur (classifyCapacity), sans règle locale.
 */
export function gaugeOf(row: Pick<GridRow, "load">, period: { from: string; to: string }, thresholds: CapacityThresholds): GridGauge {
  const l = row.load;
  const base = l ? dayNumber(l.from) : 0;
  const a = l ? Math.max(0, dayNumber(period.from) - base) : 0;
  const b = l ? Math.min(l.days, dayNumber(period.to) - base + 1) : 0;
  if (!l || a >= b) return { from: period.from, to: period.to, plannedHours: 0, capacityHours: 0, overHours: 0, percent: null, state: "unavailable", fill: 0 };
  const capacityHours = l.capacity[b]! - l.capacity[a]!;
  const plannedHours = l.planned[b]! - l.planned[a]!;
  const st = classifyCapacity({ capacityHours, plannedHours, tentativeHours: l.tentative[b]! - l.tentative[a]! }, thresholds);
  const ratio = capacityHours > 0 ? plannedHours / capacityHours : null;
  return {
    from: fromDayNumber(base + a), to: fromDayNumber(base + b - 1),
    plannedHours: round1(plannedHours), capacityHours: round1(capacityHours), overHours: round1(st.overHours),
    percent: ratio === null ? null : Math.round(ratio * 100), state: st.state,
    fill: ratio === null ? (plannedHours > 0 ? 100 : 0) : Math.min(100, Math.round(ratio * 1000) / 10),
  };
}

/** Initiales d'un nom (deux au plus : premier et dernier mot), en majuscules. */
export function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const pick = words.length > 1 ? [words[0]!, words[words.length - 1]!] : words;
  return pick.map((w) => [...w][0]!.toLocaleUpperCase()).join("");
}

function toCap(c: CapacityCell, kind: Zoom, x: number, w: number, capPx: number): GridCap {
  const a = c.aggregate;
  const b = c.bar;
  const over = a.overbookedDays > 0 || a.state === "over";
  const tentativePx = b.tentative > 0 ? Math.max(1, Math.round(b.tentative * capPx)) : 0;
  const confirmedPx = Math.min(capPx - tentativePx, b.confirmed > 0 ? Math.max(1, Math.round(b.confirmed * capPx)) : 0);
  return {
    from: c.from, to: c.to, kind, x, w,
    state: over ? "over" : a.capacityHours <= 0 && a.plannedHours <= 0 ? "none" : "ok",
    confirmedPx, tentativePx, overPx: b.over > 0 ? Math.max(1, Math.round(b.over * capPx)) : 0,
    lineY: Math.min(capPx - 2, Math.max(0, capPx - Math.round(b.capacityLine * capPx))),
    plannedHours: round1(a.plannedHours), capacityHours: round1(a.capacityHours), tentativeHours: round1(a.tentativeHours),
    overtimeHours: round1(a.overtimeHours), overbookedDays: a.overbookedDays,
  };
}

export function buildGrid(s: ScheduleResponse, range: { from: string; to: string }, pxPerDay: number, zoom: Zoom = "day",
  metrics: RowMetrics = DENSITY_METRICS.compact): GridModel {
  const { rowUnitPx, capPx } = metrics;
  const projects = new Map(s.projects.map((p) => [p.id, p]));
  const roleNames = new Map(s.roles.map((r) => [r.id, r.name]));
  const departmentNames = new Map(s.departments.map((d) => [d.id, d.name]));
  const byPerson = byPersonOf(s);
  const timeoffsByPerson = timeoffsByPersonOf(s);
  const typeNames = new Map(s.timeoffTypes.map((t) => [t.id, t.name]));
  const { cells: caps, loads } = capCells(s, range, zoom, pxPerDay, capPx);
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
    const blocksPx = lay.height * rowUnitPx;
    const row: GridRow = {
      personId: p.id, name: p.name, initials: initialsOf(p.name), role: roleNames.get(p.roleId ?? "") ?? "", department: departmentNames.get(p.departmentId ?? "") ?? "",
      top, heightPx: blocksPx + capPx, overflow: lay.overflow, capY: blocksPx, cells: caps.get(p.id) ?? [], load: loads.get(p.id) ?? null,
      timeoffs: rowTimeoffs(timeoffsByPerson.get(p.id) ?? [], typeNames, range, pxPerDay, blocksPx),
      nonWorking: nonWorkingSpans(p, range, pxPerDay),
      blocks: lay.placed.map((b) => {
        const { a, startDate, endDate } = source.get(b.id)!;
        const pr = projects.get(a.projectId);
        return {
          key: b.id, allocationId: a.id, x: b.col * pxPerDay, w: b.span * pxPerDay, y: b.y * rowUnitPx, h: b.h * rowUnitPx,
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
  return {
    from: range.from, to: range.to, pxPerDay, widthPx: days * pxPerDay, heightPx: top, rows, rowUnitPx, capPx,
    thresholds: engineInputOf(s).thresholds,
  };
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
