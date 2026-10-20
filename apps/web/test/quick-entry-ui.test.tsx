// @vitest-environment jsdom
// Saisie rapide dans l'écran Schedule : aperçu en direct, candidats de projet (combobox ARIA, flèches + Entrée), messages
// traduits, 8 h par défaut signalé, création optimiste annoncée, refus traduit, Ctrl+Z supprime l'allocation créée.
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
type Source = ReturnType<typeof createDemoSource>;
const alloc = (id: string, over: Partial<Alloc> = {}) => ({
  id, version: 1, personId: "1", projectId: "1", phaseId: null, taskId: null, groupId: null, name: null, notes: null,
  startDate: "2026-10-20", endDate: "2026-10-20", status: "confirmed" as const, billable: true, priority: 0,
  repeatState: "none" as const, repeatEndDate: null, mode: "hours" as const, hoursPerDay: 8, percent: null, ...over,
}) as Alloc;
const data = (allocations: Alloc[]): ScheduleResponse => ({
  window: { from: "2025-10-01", to: "2027-10-01" }, changeCursor: "0", page: { nextCursor: null, total: 2 },
  account: { weekStart: 1, capacityThresholds: { underPercent: 80 }, timezone: "Europe/Paris" },
  people: ["1", "2"].map((id) => ({ id, version: 1, name: id === "1" ? "Alice" : "Bruno", peopleType: "employee" as const, departmentId: null,
    roleId: null, country: null, workDaysHours: [8, 8, 8, 8, 8, 0, 0], tags: [], avatarUrl: null, active: true })),
  allocations, timeoffs: [], holidays: [], departments: [], roles: [],
  timeoffTypes: [{ id: "t1", version: 1, name: "Congés payés", deducted: true }],
  projects: [["1", "Refonte"], ["2", "Refonte Mobile"], ["3", "Audit"]].map(([id, name]) => ({
    id: id!, version: 1, name: name!, projectCode: null, color: "#3B82F6", status: "in_progress" as const, nonBillable: false, startDate: null, endDate: null })),
});

let root: Root | null = null;
let host: HTMLElement;
const frames: (() => void)[] = [];
const clock: Partial<Clock> = { raf: (cb) => (frames.push(cb), frames.length), caf: () => {}, now: () => 0, idle: () => {}, setTimer: () => 0, clearTimer: () => {} };
const flush = async () => { for (let i = 0; i < 5; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
afterEach(() => { act(() => root?.unmount()); host.remove(); root = null; frames.length = 0; });

function mount(opts: { allocations?: Alloc[]; records?: boolean; locale?: "fr" | "en"; wrap?: (s: Source) => Source } = {}) {
  // Le magasin ne garde dans la vue que les projets référencés par une allocation : une allocation « seed » lointaine par projet.
  const seeds = ["1", "2", "3"].map((p) => alloc(`seed${p}`, { projectId: p, personId: "2", startDate: "2027-06-01", endDate: "2027-06-01" }));
  const src = (opts.wrap ?? ((x: Source) => x))(createDemoSource(data([...seeds, ...(opts.allocations ?? [])])));
  const { history } = historyForSource(src);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  const render = () => act(() => root!.render(
    <ScheduleScreen i18n={createI18n(opts.locale ?? "fr")} data={src.getState().data!} today={TODAY} widthPx={GUTTER_PX + 960} heightPx={480} clock={clock}
      editor={history.editor} history={history} records={opts.records === false ? undefined : src} />));
  render();
  src.subscribe(() => { queueMicrotask(render); });
  return { src, history };
}

const mine = (src: Source) => src.getState().data!.allocations.filter((a) => !a.id.startsWith("seed"));
const input = () => host.querySelector<HTMLInputElement>('input[role="combobox"]')!;
const preview = () => host.querySelector("#wn-quick-preview")!.textContent!;
const options = () => [...host.querySelectorAll('[role="option"]')].map((o) => o.textContent);
const press = (target: EventTarget, init: KeyboardEventInit) =>
  act(() => { target.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init })); });
const notice = () => host.querySelector(".wn-notice")!.textContent;
const submitButton = () => host.querySelector<HTMLButtonElement>(".wn-quick button")!;
const grid = () => host.querySelector<HTMLElement>("[role=grid]")!;
function type(value: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input(), value);
    input().dispatchEvent(new Event("input", { bubbles: true }));
  });
}
function pickPerson(id: string) {
  const el = host.querySelector<HTMLSelectElement>(".wn-quick select")!;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(el, id);
    el.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

describe("saisie rapide", () => {
  it("analyse en direct : aperçu lisible, 8 h par défaut signalé, rien à créer tant que la personne manque", () => {
    mount();
    type("Audit mer");
    expect(preview()).toContain("Personne à choisir.");
    expect(submitButton().disabled).toBe(true);
    pickPerson("2");
    expect(preview()).toBe("Audit, Bruno, du mer. 21 oct. au mer. 21 oct., 8 h par jour 8 h par jour par défaut.");
    expect(submitButton().disabled).toBe(false);
    type("? Audit 50 % lun-mer");
    expect(preview()).toBe("Audit, Bruno, du lun. 26 oct. au mer. 28 oct., 50 %, tentatif");
  });

  it("messages traduits pour missing et invalid", () => {
    mount();
    pickPerson("1");
    type("zzz 30h 31/02");
    expect(preview()).toContain("Projet à préciser.");
    expect(preview()).toContain("Dates à préciser.");
    expect(preview()).toContain("Quantité hors limites");
    expect(preview()).toContain("Date invalide.");
  });

  it("locale de l'analyse = locale de l'interface (anglais : jours anglais, dates M/D)", () => {
    mount({ locale: "en" });
    pickPerson("1");
    type("Audit mon-wed 4h");
    expect(preview()).toBe("Audit, Alice, from Mon, Oct 26 to Wed, Oct 28, 4 h per day");
    type("Audit 12/31 4h");
    expect(preview()).toContain("Audit, Alice, from Thu, Dec 31");
  });

  it("projet ambigu : combobox ARIA, flèches puis Entrée choisissent, Échap ferme la liste", () => {
    mount();
    pickPerson("1");
    type("refo lun");
    expect(options()).toEqual(["Refonte", "Refonte Mobile"]);
    expect(input().getAttribute("aria-expanded")).toBe("true");
    expect(input().getAttribute("aria-activedescendant")).toBe("wn-quick-opt-0");
    press(input(), { key: "ArrowDown" });
    expect(input().getAttribute("aria-activedescendant")).toBe("wn-quick-opt-1");
    expect(host.querySelectorAll('[aria-selected="true"]')).toHaveLength(1);
    press(input(), { key: "Enter" });
    expect(options()).toEqual([]);
    expect(preview()).toContain("Refonte Mobile, Alice");
    type("refo lun");
    press(input(), { key: "Escape" });
    expect(options()).toEqual([]);
    expect(input().getAttribute("aria-expanded")).toBe("false");
  });

  it("Entrée valide : allocation créée tout de suite, annoncée, focus rendu à la grille", async () => {
    const { src } = mount();
    pickPerson("2");
    type("Audit 4h lun-mer");
    press(input(), { key: "Enter" });
    await flush();
    const created = mine(src);
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ personId: "2", projectId: "3", startDate: "2026-10-26", endDate: "2026-10-28", mode: "hours", hoursPerDay: 4, status: "confirmed" });
    expect(notice()).toBe("Allocation créée.");
    expect(input().value).toBe("");
    expect(document.activeElement).toBe(grid());
  });

  it("tentatif et pourcentage passent dans le corps de création", async () => {
    const { src } = mount();
    pickPerson("1");
    type("? Audit 50% 2026-10-27");
    press(input(), { key: "Enter" });
    await flush();
    expect(mine(src)[0]).toMatchObject({ status: "tentative", mode: "percentage", percent: 50, startDate: "2026-10-27" });
  });

  it("créer puis Ctrl+Z supprime l'allocation, Ctrl+Maj+Z la recrée", async () => {
    const { src } = mount();
    pickPerson("1");
    type("Audit mar");
    press(input(), { key: "Enter" });
    await flush();
    expect(mine(src)).toHaveLength(1);
    press(document.body, { key: "z", ctrlKey: true });
    await flush();
    expect(mine(src)).toHaveLength(0);
    expect(notice()).toBe("Ajout annulé.");
    press(document.body, { key: "z", ctrlKey: true, shiftKey: true });
    await flush();
    expect(mine(src)).toHaveLength(1);
  });

  it("refus : message traduit dans la barre, annoncé, texte gardé, rien dans l'historique", async () => {
    const { src, history } = mount({ wrap: (s) => ({ ...s, createAllocation: async () => ({ ok: false as const, error: "NETWORK" as const }) }) });
    pickPerson("1");
    type("Audit mar");
    press(input(), { key: "Enter" });
    await flush();
    expect(host.querySelector("[role=alert]")!.textContent).toBe("Allocation non créée (connexion impossible).");
    expect(notice()).toBe("Allocation non créée (connexion impossible).");
    expect(input().value).toBe("Audit mar");
    expect(history.getState().canUndo).toBe(false);
    expect(mine(src)).toHaveLength(0);
  });

  it("raccourcis : N sur un bloc focalise la barre avec la personne du bloc ; Échap rend la grille ; « / » depuis la grille", () => {
    mount({ allocations: [alloc("a", { personId: "2" })] });
    const b = host.querySelector<HTMLElement>('.wn-block[data-key="a:0"]')!;
    b.focus();
    press(b, { key: "n" });
    expect(document.activeElement).toBe(input());
    expect(host.querySelector<HTMLSelectElement>(".wn-quick select")!.value).toBe("2");
    expect(input().getAttribute("aria-keyshortcuts")).toBe("/ N");
    press(input(), { key: "Escape" });
    expect(document.activeElement).toBe(grid());
    press(grid(), { key: "/" });
    expect(document.activeElement).toBe(input());
  });

  it("lecture seule sans source d'écritures : pas de barre", () => {
    mount({ records: false });
    expect(host.querySelector(".wn-quick")).toBeNull();
  });
});
