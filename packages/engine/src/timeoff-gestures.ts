// Gestes sur un congé (RT-051, décision D4 de la recette n°4 : le congé reste un objet distinct, il reçoit les gestes des blocs).
// Le congé se manipule en demi-journées : créneaux numérotés 2 × jour (matin) et 2 × jour + 1 (après-midi), comme la contrainte
// d'exclusion ex_timeoff_no_overlap de schema.sql. Début et fin sont des créneaux inclus ; un congé couvre au moins un créneau.
//  * Pas (timeoffStepHalves) : la demi-journée quand une demi-journée est assez large pour être visée (vue jour), sinon la
//    journée (vues semaine et mois) ; un congé partiel (heures par jour) reste au pas de la journée (chk_timeoff_halves : am..pm).
//  * Les touches sont celles des blocs (keyGesture : ← → déplacer, Maj étire la fin, Alt le début) ; ni hauteur (un congé n'a
//    pas d'heures) ni changement de personne.
import { DAY_MS, toIso, toMs } from "./dates";
import { keyGesture, type KeyInput } from "./gestures";
import { DEFAULT_PX_PER_DAY } from "./viewport";

export type DayHalf = "am" | "pm";
export interface TimeoffSpan { startDate: string; endDate: string; startHalf: DayHalf; endHalf: DayHalf }
export type TimeoffGestureKind = "move" | "resizeStart" | "resizeEnd";
/** `halves` : décalage en demi-journées (déjà aimanté au pas). */
export interface TimeoffGesture { kind: TimeoffGestureKind; halves: number }

const slot = (date: string, half: DayHalf) => Math.round(toMs(date) / DAY_MS) * 2 + (half === "pm" ? 1 : 0);
const dateOf = (s: number) => toIso(Math.floor(s / 2) * DAY_MS);
const halfOf = (s: number): DayHalf => (((s % 2) + 2) % 2 === 1 ? "pm" : "am");

/** Champs changés par le geste (null : aucun changement). */
export function applyTimeoffGesture(t: TimeoffSpan, g: TimeoffGesture): Partial<TimeoffSpan> | null {
  const s0 = slot(t.startDate, t.startHalf);
  const e0 = slot(t.endDate, t.endHalf);
  const d = Math.round(g.halves);
  let s = s0;
  let e = e0;
  if (g.kind === "move") { s += d; e += d; }
  else if (g.kind === "resizeStart") s = Math.min(s0 + d, e0);
  else e = Math.max(e0 + d, s0);
  const next: TimeoffSpan = { startDate: dateOf(s), startHalf: halfOf(s), endDate: dateOf(e), endHalf: halfOf(e) };
  const patch: Partial<TimeoffSpan> = {};
  for (const k of ["startDate", "startHalf", "endDate", "endHalf"] as const) if (next[k] !== t[k]) (patch as Record<string, string>)[k] = next[k];
  return Object.keys(patch).length === 0 ? null : patch;
}

/** Pas du geste en demi-journées : 1 en vue jour (une demi-journée d'au moins la moitié d'une journée de la vue jour), sinon 2. */
export function timeoffStepHalves(pxPerDay: number, scope: "full_day" | "partial"): 1 | 2 {
  return scope === "full_day" && pxPerDay >= DEFAULT_PX_PER_DAY.day ? 1 : 2;
}

/** Glisser horizontal (pixels) -> geste aimanté au pas. */
export function timeoffPointerGesture(kind: TimeoffGestureKind, dxPx: number, pxPerDay: number, step: 1 | 2): TimeoffGesture {
  return { kind, halves: (Math.round(dxPx / ((pxPerDay / 2) * step)) || 0) * step }; // || 0 : pas de -0
}

const SAMPLE = { personId: "", startDate: "2026-01-05", endDate: "2026-01-06", mode: "hours", hoursPerDay: 8, percent: null, repeatState: "none", repeatEndDate: null } as const;

/** Équivalent clavier sur le congé focalisé (touches des blocs, moteur keyGesture) ; null pour toute autre touche. */
export function timeoffKeyGesture(e: KeyInput, step: 1 | 2): TimeoffGesture | null {
  const g = keyGesture(e, SAMPLE);
  if (!g || g.kind === "height" || (g.kind === "move" && g.personId !== undefined)) return null;
  return { kind: g.kind, halves: g.days * step };
}
