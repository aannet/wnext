// @vitest-environment jsdom
// Congés dans l'écran Schedule (BR-04) : touche C sur un bloc -> formulaire prérempli ; congé sur une allocation ->
// avertissement (jours, projet, temps saisi) ; « Reprogrammer… » -> assistant (choix par allocation, aperçu) ; « Garder tel
// quel » ; congé en attente sans assistant ; chevauchement refusé et traduit ; modification et suppression ; Ctrl+Z défait
// le congé et le report en une fois. Démo locale comme source.
import type { ScheduleResponse } from "@wnext/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { ScheduleScreen } from "../src/ScheduleScreen";
import { createDemoSource } from "../src/data/demo-source";
import { createI18n } from "../src/i18n";
import { historyForSource } from "../src/schedule/history";
import { GUTTER_PX, type Clock } from "../src/schedule/scroller";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const TODAY = "2026-10-20"; // mardi
type Alloc = ScheduleResponse["allocations"][number];
type Timeoff = ScheduleResponse["timeoffs"][number];
const alloc = (id: string, over: Partial<Alloc> = {}) => ({
  id, version: 1, personId: "1", projectId: "1", phaseId: null, taskId: null, groupId: null, name: null, notes: null,
  startDate: "2026-10-20", endDate: "2026-10-20", status: "confirmed" as const, billable: true, priority: 0,
  repeatState: "none" as const, repeatEndDate: null, mode: "hours" as const, hoursPerDay: 8, percent: null, ...over,
}) as Alloc;
const off = (id: string, over: Partial<Timeoff> = {}): Timeoff => ({
  id, version: 1, personId: "1", typeId: "t1", startDate: "2026-10-22", endDate: "2026-10-22", scope: "full_day", startHalf: "am", endHalf: "pm",
  hoursPerDay: null, approvalStatus: "approved", ...over,
});
const data = (allocations: Alloc[], timeoffs: Timeoff[] = []): ScheduleResponse => ({
  window: { from: "2025-10-01", to: "2027-10-01" }, changeCursor: "0", page: { nextCursor: null, total: 2 },
  account: { weekStart: 1, capacityThresholds: { underPercent: 80 }, timezone: "Europe/Paris" },
  people: ["1", "2"].map((id) => ({ id, version: 1, name: id === "1" ? "Alice" : "Bruno", peopleType: "employee" as const, departmentId: null,
    roleId: null, country: null, workDaysHours: [8, 8, 8, 8, 8, 0, 0], tags: [], avatarUrl: null, active: true })),
  allocations, timeoffs, holidays: [], departments: [], roles: [],
  timeoffTypes: [{ id: "t1", version: 1, name: "Congés payés", deducted: true }],
  projects: [{ id: "1", version: 1, name: "Refonte", projectCode: null, color: "#3B82F6", status: "in_progress", nonBillable: false, startDate: null, endDate: null }],
});

let root: Root | null = null;
let host: HTMLElement;
const frames: (() => void)[] = [];
const clock: Partial<Clock> = { raf: (cb) => (frames.push(cb), frames.length), caf: () => {}, now: () => 0, idle: () => {}, setTimer: () => 0, clearTimer: () => {} };
const flush = async () => { for (let i = 0; i < 5; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
afterEach(() => { act(() => root?.unmount()); host.remove(); root = null; frames.length = 0; });

function mount(allocations: Alloc[], timeoffs: Timeoff[] = [], withRecords = true) {
  const src = createDemoSource(data(allocations, timeoffs));
  const { history } = historyForSource(src);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  const render = () => act(() => root!.render(
    <ScheduleScreen i18n={createI18n("fr")} data={src.getState().data!} today={TODAY} widthPx={GUTTER_PX + 960} heightPx={480} clock={clock}
      editor={history.editor} history={history} records={withRecords ? src : undefined} />));
  render();
  // Rôle du conteneur : redonner les données à jour après chaque écriture.
  src.subscribe(() => { queueMicrotask(render); });
  return { src, history };
}

const dialog = () => document.body.querySelector<HTMLElement>("[role=dialog]");
const button = (label: string) => [...document.body.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === label);
const click = async (label: string) => { act(() => button(label)!.click()); await flush(); };
const notice = () => document.body.querySelector(".wn-notice")!.textContent;
const press = (target: EventTarget, init: KeyboardEventInit) =>
  act(() => { target.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init })); });
const field = (label: string) => [...document.body.querySelectorAll("label")].find((l) => l.firstChild?.textContent === label)!.querySelector<HTMLInputElement | HTMLSelectElement>("input, select")!;
function setField(label: string, value: string) {
  const el = field(label);
  const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  act(() => {
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
  });
}
const submit = async () => { act(() => { document.body.querySelector("form")!.requestSubmit(); }); await flush(); };
const allocs = (src: ReturnType<typeof mount>["src"]) => src.getState().data!.allocations.map((a) => `${a.startDate}..${a.endDate}`).sort();

describe("saisie d'un congé", () => {
  it("touche C sur un bloc : formulaire prérempli (personne, jour du bloc), journée entière, approuvé", () => {
    mount([alloc("a")]);
    const b = host.querySelector<HTMLElement>('.wn-block[data-key="a:0"]')!;
    b.focus();
    press(b, { key: "c" });
    expect(dialog()?.querySelector("h2")?.textContent).toBe("Nouveau congé");
    expect([field("Personne").value, field("Du").value, field("Au").value, field("Début").value, field("Fin").value, field("Statut").value])
      .toEqual(["1", TODAY, TODAY, "am", "pm", "approved"]);
    press(dialog()!, { key: "Escape" });
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(host.querySelector("[role=grid]"));
  });

  it("statut : « En attente » n'est plus proposé à la pose (RT-022) ; un congé existant en attente le garde à la modification", async () => {
    mount([], [off("o1", { approvalStatus: "pending" })]);
    await click("Nouveau congé");
    expect([...(field("Statut") as HTMLSelectElement).options].map((o) => o.value)).toEqual(["approved", "declined"]);
    press(dialog()!, { key: "Escape" });
    await flush();
    act(() => host.querySelector<HTMLElement>('[data-timeoff="o1"]')!.click());
    expect(field("Statut").value).toBe("pending");
    expect([...(field("Statut") as HTMLSelectElement).options].map((o) => o.value)).toEqual(["approved", "pending", "declined"]);
  });

  it("sans conflit : enregistré tout de suite, rendu dans la grille, annoncé ; Ctrl+Z le retire", async () => {
    const { src } = mount([]);
    await click("Nouveau congé");
    setField("Du", "2026-10-21");
    setField("Au", "2026-10-21");
    await submit();
    expect(dialog()).toBeNull();
    expect(notice()).toBe("Congé enregistré.");
    expect(src.getState().data!.timeoffs).toHaveLength(1);
    await flush();
    expect(host.querySelector(".wn-timeoff")?.getAttribute("aria-label")).toBe("Congés payés, le mer. 21 oct.");
    await click("Annuler");
    expect(src.getState().data!.timeoffs).toHaveLength(0);
    expect(notice()).toBe("Pose du congé annulée.");
  });

  it("dates incohérentes et chevauchement : message traduit, formulaire gardé ouvert", async () => {
    mount([], [off("o1")]);
    await click("Nouveau congé");
    setField("Du", "2026-10-23");
    setField("Au", "2026-10-22");
    await submit();
    expect(dialog()!.querySelector("[role=alert]")?.textContent).toMatch(/^Dates incohérentes/);
    setField("Du", "2026-10-22");
    await submit();
    expect(dialog()!.querySelector("[role=alert]")?.textContent).toBe("Ce congé chevauche un autre congé de cette personne : changez les dates.");
  });

  it("clic sur un congé : modification puis suppression, annoncées", async () => {
    const { src } = mount([], [off("o1")]);
    await flush();
    act(() => host.querySelector<HTMLElement>('[data-timeoff="o1"]')!.click());
    expect(dialog()?.querySelector("h2")?.textContent).toBe("Modifier le congé");
    setField("Au", "2026-10-23");
    await submit();
    expect(src.getState().data!.timeoffs[0]).toMatchObject({ endDate: "2026-10-23", version: 2 });
    await flush();
    const el = host.querySelector<HTMLElement>('[data-timeoff="o1"]')!;
    el.focus();
    press(el, { key: "Enter" });
    await click("Supprimer");
    expect(src.getState().data!.timeoffs).toEqual([]);
    expect(notice()).toBe("Congé supprimé.");
  });

  it("lecture seule sans source d'écritures : ni bouton ni formulaire", () => {
    mount([alloc("a")], [], false);
    expect(button("Nouveau congé")).toBeUndefined();
    press(host.querySelector("[role=grid]")!, { key: "c" });
    expect(dialog()).toBeNull();
  });
});

describe("BR-04 : avertissement et reprogrammation assistée", () => {
  async function warn(allocations: Alloc[], status = "approved") {
    const m = mount(allocations);
    const b = host.querySelector<HTMLElement>('.wn-block[data-key="a:0"]')!;
    b.focus();
    press(b, { key: "C" });
    setField("Statut", status);
    await submit();
    return m;
  }

  it("congé journée entière sur une allocation : avertissement avec le jour, les heures et le projet ; rien n'est écrit", async () => {
    const { src } = await warn([alloc("a")]);
    expect(dialog()!.querySelector("h2")!.textContent).toBe("Ce congé recouvre des allocations de Alice");
    expect(dialog()!.querySelector("li")!.textContent).toBe("mar. 20 oct. : 8 h planifiées pour 0 h disponibles (Refonte)");
    expect(src.getState().data!.timeoffs).toEqual([]);
    expect([button("Reprogrammer…"), button("Garder tel quel"), button("Retour")].every(Boolean)).toBe(true);
    await click("Retour");
    expect(dialog()!.querySelector("h2")!.textContent).toBe("Nouveau congé");
  });

  it("reprogrammer : choix par allocation et aperçu, appliquer déplace le bloc ; une seule annulation défait tout", async () => {
    const { src, history } = await warn([alloc("a", { endDate: "2026-10-21" })]);
    await click("Reprogrammer…");
    expect(dialog()!.querySelector("legend")!.textContent).toBe("Refonte, du mar. 20 oct. au mer. 21 oct.");
    const radios = [...dialog()!.querySelectorAll<HTMLElement>("[role=radio]")];
    const state = () => radios.map((r) => [r.closest("label")!.textContent, r.getAttribute("aria-checked")]);
    expect(state()).toEqual([["Reporter", "true"], ["Réduire", "false"], ["Garder", "false"]]);
    expect(document.activeElement).toBe(radios[0]); // focus initial sur le choix sélectionné à l'entrée dans l'assistant
    expect(dialog()!.querySelector("ul")!.textContent).toBe("8 h reportéesDevient : du mer. 21 oct. au jeu. 22 oct.");
    press(radios[0]!, { key: "ArrowDown" }); await flush(); // flèche : le focus et le choix passent au suivant
    expect([state()[1], document.activeElement === radios[1]]).toEqual([["Réduire", "true"], true]);
    expect(dialog()!.querySelector("ul")!.textContent).toBe("8 h retiréesDevient : du mer. 21 oct. au mer. 21 oct.");
    press(radios[1]!, { key: "ArrowUp" }); await flush();
    expect([state()[0], document.activeElement === radios[0]]).toEqual([["Reporter", "true"], true]);
    await act(async () => radios[2]!.click()); await flush(); // clic
    expect(state()[2]).toEqual(["Garder", "true"]);
    await act(async () => radios[0]!.click()); await flush();
    expect(state()[0]).toEqual(["Reporter", "true"]);
    await click("Appliquer");
    expect(dialog()).toBeNull();
    expect(notice()).toBe("Congé enregistré et allocations reprogrammées. Ctrl+Z annule le tout.");
    expect(allocs(src)).toEqual(["2026-10-21..2026-10-22"]);
    expect(src.getState().data!.timeoffs).toHaveLength(1);
    await act(async () => { await history.undo(); });
    expect(allocs(src)).toEqual(["2026-10-20..2026-10-21"]);
    expect(src.getState().data!.timeoffs).toEqual([]);
  });

  it("garder tel quel : congé enregistré, allocation intacte, surcharge annoncée (permise, BR-01)", async () => {
    const { src } = await warn([alloc("a")]);
    await click("Garder tel quel");
    expect(allocs(src)).toEqual(["2026-10-20..2026-10-20"]);
    expect(src.getState().data!.timeoffs).toHaveLength(1);
    expect(notice()).toBe("Congé enregistré ; les allocations sont gardées telles quelles : Alice est en surcharge ces jours-là (signalé, permis).");
  });

  it("congé en attente : avertissement sans assistant (BR-29)", async () => {
    await warn([alloc("a")], "pending");
    expect(button("Reprogrammer…")).toBeUndefined();
    expect(dialog()!.textContent).toContain("Congé en attente : l’assistant de reprogrammation sera proposé à son approbation.");
  });

  it("série répétée : gardée telle quelle dans l'assistant", async () => {
    await warn([alloc("a", { repeatState: "weekly", repeatEndDate: "2026-12-31" })]);
    await click("Reprogrammer…");
    expect(dialog()!.textContent).toContain("Série répétée : gardée telle quelle, à ajuster à la main.");
    expect(dialog()!.querySelectorAll("input[type=radio]")).toHaveLength(0);
  });
});
