// Modèle de la grille du Schedule (ADR-005 : DOM virtualisé A2), sans DOM : ce que le rendu doit dessiner, en pixels.
//  * Une ligne par personne, dans l'ordre du snapshot ; hauteur = ROW_UNIT_PX × hauteur du layout (≥ 1, plus en cas
//    d'empilement au-delà de 100 %, BR-01 : visible, jamais bloqué).
//  * Les séries répétées sont développées dans la fenêtre (expandOccurrences) ; clé d'un bloc = « allocation:rang »,
//    stable d'un rendu à l'autre (recyclage des nœuds).
//  * Le texte d'un bloc est une donnée (nom du projet), pas une chaîne d'interface.
import type { ScheduleResponse } from "@wnext/contracts";
import { blockFraction, expandOccurrences, layoutRow, type LayoutBlock } from "@wnext/engine";

/** Hauteur d'une ligne à 100 % de la journée de référence. Valeur provisoire, à régler à l'écran. */
export const ROW_UNIT_PX = 48;

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
}

export interface GridRow { personId: string; name: string; top: number; heightPx: number; overflow: boolean; blocks: GridBlock[] }

export interface GridModel { from: string; to: string; pxPerDay: number; widthPx: number; heightPx: number; rows: GridRow[] }

export function buildGrid(s: ScheduleResponse, range: { from: string; to: string }, pxPerDay: number): GridModel {
  const projects = new Map(s.projects.map((p) => [p.id, p]));
  const byPerson = new Map<string, ScheduleResponse["allocations"]>();
  for (const a of s.allocations) (byPerson.get(a.personId) ?? byPerson.set(a.personId, []).get(a.personId)!).push(a);
  let top = 0;
  const rows = s.people.map((p): GridRow => {
    const source = new Map<string, ScheduleResponse["allocations"][number]>();
    const blocks: LayoutBlock[] = [];
    for (const a of byPerson.get(p.id) ?? []) {
      for (const o of expandOccurrences(a, range.from, range.to)) {
        const key = `${a.id}:${o.index}`;
        source.set(key, a);
        blocks.push({ id: key, startDate: o.startDate, endDate: o.endDate, fraction: blockFraction(a, p.workDaysHours) });
      }
    }
    const lay = layoutRow(blocks, range.from, range.to);
    const row: GridRow = {
      personId: p.id, name: p.name, top, heightPx: lay.height * ROW_UNIT_PX, overflow: lay.overflow,
      blocks: lay.placed.map((b) => {
        const a = source.get(b.id)!;
        const pr = projects.get(a.projectId);
        return {
          key: b.id, allocationId: a.id, x: b.col * pxPerDay, w: b.span * pxPerDay, y: b.y * ROW_UNIT_PX, h: b.h * ROW_UNIT_PX,
          color: pr?.color ?? null, label: pr?.name ?? "", tentative: a.status === "tentative", clippedStart: b.clippedStart, clippedEnd: b.clippedEnd,
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
