// Gestes sur un congé (RT-051) : déplacer, étirer ou réduire début et fin, au pas de la demi-journée (start_half / end_half),
// ou de la journée selon le zoom et pour un congé partiel (contrainte chk_timeoff_halves : am..pm).
import { describe, expect, it } from "vitest";
import {
  applyTimeoffGesture, timeoffKeyGesture, timeoffPointerGesture, timeoffStepHalves, type TimeoffSpan,
} from "../src/timeoff-gestures";
import { DEFAULT_PX_PER_DAY } from "../src/viewport";

const span = (over: Partial<TimeoffSpan> = {}): TimeoffSpan => ({ startDate: "2026-03-02", endDate: "2026-03-03", startHalf: "am", endHalf: "pm", ...over });

describe("applyTimeoffGesture", () => {
  it("déplacer d'une demi-journée : lundi matin..mardi soir devient lundi après-midi..mercredi matin", () => {
    expect(applyTimeoffGesture(span(), { kind: "move", halves: 1 })).toEqual({ startHalf: "pm", endDate: "2026-03-04", endHalf: "am" });
    expect(applyTimeoffGesture(span(), { kind: "move", halves: -1 })).toEqual({ startDate: "2026-03-01", startHalf: "pm", endHalf: "am" });
    expect(applyTimeoffGesture(span(), { kind: "move", halves: 4 })).toEqual({ startDate: "2026-03-04", endDate: "2026-03-05" });
    expect(applyTimeoffGesture(span(), { kind: "move", halves: 0 })).toBeNull();
  });

  it("étirer ou réduire : jamais sous une demi-journée, de chaque côté", () => {
    expect(applyTimeoffGesture(span(), { kind: "resizeEnd", halves: 1 })).toEqual({ endDate: "2026-03-04", endHalf: "am" });
    expect(applyTimeoffGesture(span(), { kind: "resizeEnd", halves: -10 })).toEqual({ endDate: "2026-03-02", endHalf: "am" });
    expect(applyTimeoffGesture(span(), { kind: "resizeStart", halves: 1 })).toEqual({ startHalf: "pm" });
    expect(applyTimeoffGesture(span(), { kind: "resizeStart", halves: 10 })).toEqual({ startDate: "2026-03-03", startHalf: "pm" });
    expect(applyTimeoffGesture(span({ endDate: "2026-03-02", endHalf: "am" }), { kind: "resizeEnd", halves: -1 })).toBeNull();
  });

  it("au pas de la journée, les demi-journées de départ sont gardées", () => {
    const pm = span({ startHalf: "pm", endHalf: "am", endDate: "2026-03-04" });
    expect(applyTimeoffGesture(pm, { kind: "move", halves: 2 })).toEqual({ startDate: "2026-03-03", endDate: "2026-03-05" });
  });
});

describe("pas selon le zoom", () => {
  it("vue jour : la demi-journée ; semaine et mois : la journée ; congé partiel : toujours la journée", () => {
    expect(timeoffStepHalves(DEFAULT_PX_PER_DAY.day, "full_day")).toBe(1);
    expect(timeoffStepHalves(DEFAULT_PX_PER_DAY.week, "full_day")).toBe(2);
    expect(timeoffStepHalves(DEFAULT_PX_PER_DAY.month, "full_day")).toBe(2);
    expect(timeoffStepHalves(DEFAULT_PX_PER_DAY.day, "partial")).toBe(2);
  });

  it("pointeur : pixels aimantés au pas", () => {
    const ppd = DEFAULT_PX_PER_DAY.day;
    expect(timeoffPointerGesture("move", ppd / 2 + 3, ppd, 1)).toEqual({ kind: "move", halves: 1 });
    expect(timeoffPointerGesture("resizeEnd", -ppd, ppd, 1)).toEqual({ kind: "resizeEnd", halves: -2 });
    expect(timeoffPointerGesture("move", ppd / 2 + 3, ppd, 2)).toEqual({ kind: "move", halves: 2 });
    expect(timeoffPointerGesture("move", ppd / 2 - 3, ppd, 2)).toEqual({ kind: "move", halves: 0 });
  });

  it("clavier : mêmes touches que les blocs (moteur keyGesture), au pas donné ; ni hauteur ni changement de personne", () => {
    expect(timeoffKeyGesture({ key: "ArrowRight" }, 1)).toEqual({ kind: "move", halves: 1 });
    expect(timeoffKeyGesture({ key: "ArrowLeft" }, 2)).toEqual({ kind: "move", halves: -2 });
    expect(timeoffKeyGesture({ key: "ArrowRight", shiftKey: true }, 1)).toEqual({ kind: "resizeEnd", halves: 1 });
    expect(timeoffKeyGesture({ key: "ArrowLeft", altKey: true }, 1)).toEqual({ kind: "resizeStart", halves: -1 });
    expect(timeoffKeyGesture({ key: "ArrowUp" }, 1)).toBeNull();
    expect(timeoffKeyGesture({ key: "ArrowDown", ctrlKey: true }, 1)).toBeNull();
  });
});
