// Gestes sur un bloc du Schedule (ADR-002 §5-6) et leurs équivalents clavier (ADR-001 n°9, WCAG 2.5.7). Pur : un geste
// donne le patch à envoyer (PATCH /allocations/{id}, champs modifiés seulement) ou null s'il ne change rien.
//  * Dates aimantées à la journée à tous les zooms (ADR-002 §2 ; pas d'heure sur les allocations, ADR-004).
//  * Étirer ne descend jamais sous un jour ; la hauteur reste dans les bornes du contrat (heures ]0, 24], % ]0, 500]).
//  * Série répétée : déplacer décale toute la série (fin de série comprise) et le résultat porte series = true pour que
//    l'interface puisse demander la portée ; l'édition « occurrence / à partir d'ici » (BR-25) n'est pas tranchée.
//  * Aucune règle de capacité : la sur-allocation est permise (BR-01).
import { DAY_MS, addDays, toMs } from "./dates";

export interface GestureBlock {
  personId: string;
  startDate: string;
  endDate: string;
  mode: "hours" | "percentage";
  hoursPerDay: number | null;
  percent: number | null;
  repeatState: "none" | "daily" | "weekly" | "monthly";
  repeatEndDate: string | null;
}

export type Gesture =
  | { kind: "move"; days: number; personId?: string }
  | { kind: "resizeStart"; days: number }
  | { kind: "resizeEnd"; days: number }
  /** Hauteur : variation en heures (mode hours) ou en points de % (mode percentage). */
  | { kind: "height"; delta: number };

export type BlockPatch = Partial<Pick<GestureBlock, "personId" | "startDate" | "endDate" | "hoursPerDay" | "percent" | "repeatEndDate">>;

export interface GestureResult { patch: BlockPatch; series: boolean }

export const HOURS_STEP = 0.5;
export const PERCENT_STEP = 5;

const snap = (v: number, step: number) => Math.round(v / step) * step;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const lengthDays = (b: GestureBlock) => Math.round((toMs(b.endDate) - toMs(b.startDate)) / DAY_MS);

export function applyGesture(b: GestureBlock, g: Gesture): GestureResult | null {
  const series = b.repeatState !== "none";
  const patch: BlockPatch = {};
  switch (g.kind) {
    case "move": {
      const d = Math.round(g.days);
      if (d !== 0) {
        patch.startDate = addDays(b.startDate, d);
        patch.endDate = addDays(b.endDate, d);
        if (series && b.repeatEndDate) patch.repeatEndDate = addDays(b.repeatEndDate, d);
      }
      if (g.personId !== undefined && g.personId !== b.personId) patch.personId = g.personId;
      break;
    }
    case "resizeStart": {
      const d = Math.min(Math.round(g.days), lengthDays(b)); // le début ne dépasse pas la fin
      if (d !== 0) patch.startDate = addDays(b.startDate, d);
      break;
    }
    case "resizeEnd": {
      const d = Math.max(Math.round(g.days), -lengthDays(b));
      if (d !== 0) {
        patch.endDate = addDays(b.endDate, d);
        // La fin de série ne peut pas précéder la fin du bloc (chk_alloc_repeat) : elle suit si besoin.
        if (series && b.repeatEndDate && patch.endDate > b.repeatEndDate) patch.repeatEndDate = patch.endDate;
      }
      break;
    }
    case "height": {
      if (b.mode === "hours") {
        const v = clamp(snap((b.hoursPerDay ?? 0) + g.delta, HOURS_STEP), HOURS_STEP, 24);
        if (v !== b.hoursPerDay) patch.hoursPerDay = v;
      } else {
        const v = clamp(snap((b.percent ?? 0) + g.delta, PERCENT_STEP), PERCENT_STEP, 500);
        if (v !== b.percent) patch.percent = v;
      }
      break;
    }
  }
  return Object.keys(patch).length === 0 ? null : { patch, series };
}

/** Geste pointeur -> geste : dx en jours aimantés ; dy vers le haut = plus de hauteur, en heures ou en points de %. */
export function pointerGesture(
  kind: Gesture["kind"],
  dxPx: number,
  dyPx: number,
  scale: { pxPerDay: number; rowHeightPx: number; refHours: number; mode: GestureBlock["mode"] },
): Gesture {
  if (kind === "height") {
    const fraction = -dyPx / scale.rowHeightPx;
    return { kind, delta: scale.mode === "hours" ? fraction * scale.refHours : fraction * 100 };
  }
  return { kind, days: Math.round(dxPx / scale.pxPerDay) || 0 }; // || 0 : pas de -0
}

export interface KeyInput { key: string; shiftKey?: boolean; altKey?: boolean; ctrlKey?: boolean; metaKey?: boolean }

/**
 * Équivalents clavier, sur le bloc focalisé (provisoire, à valider en revue UX) :
 *   ← / →            déplacer d'un jour          Maj + ← / →        étirer ou réduire la fin d'un jour
 *   Alt + ← / →      étirer ou réduire le début  ↑ / ↓              hauteur ± 0,5 h (ou ± 5 %)
 *   Ctrl/Cmd + ↑ / ↓ changer de personne (ligne précédente / suivante de `rowOrder`)
 */
export function keyGesture(e: KeyInput, b: GestureBlock, rowOrder: readonly string[] = []): Gesture | null {
  const mod = e.ctrlKey || e.metaKey;
  const h = e.key === "ArrowLeft" ? -1 : e.key === "ArrowRight" ? 1 : 0;
  const v = e.key === "ArrowUp" ? 1 : e.key === "ArrowDown" ? -1 : 0;
  if (h !== 0) {
    if (mod) return null;
    if (e.shiftKey) return { kind: "resizeEnd", days: h };
    if (e.altKey) return { kind: "resizeStart", days: h };
    return { kind: "move", days: h };
  }
  if (v !== 0) {
    if (mod) {
      const i = rowOrder.indexOf(b.personId);
      const next = i < 0 ? undefined : rowOrder[i - v]; // ↑ = ligne du dessus
      return next === undefined ? null : { kind: "move", days: 0, personId: next };
    }
    if (e.shiftKey || e.altKey) return null;
    return { kind: "height", delta: v * (b.mode === "hours" ? HOURS_STEP : PERCENT_STEP) };
  }
  return null;
}
