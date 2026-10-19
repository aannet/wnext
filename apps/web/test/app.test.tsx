// @vitest-environment jsdom
// Écran Schedule (coquille React) : barre d'outils traduite, zooms, « Aujourd'hui », grille montée.
import type { ScheduleResponse } from "@wnext/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { ScheduleScreen } from "../src/ScheduleScreen";
import { createI18n, type UiLocale } from "../src/i18n";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const data: ScheduleResponse = {
  window: { from: "2026-09-01", to: "2026-11-30" }, changeCursor: "0", page: { nextCursor: null, total: 2 },
  account: { weekStart: 1, capacityThresholds: { underPercent: 80 }, timezone: "Europe/Paris" },
  people: ["Alice", "Bruno"].map((name, i) => ({
    id: String(i + 1), version: 1, name, peopleType: "employee" as const, departmentId: null, roleId: null, country: null,
    workDaysHours: [8, 8, 8, 8, 8, 0, 0], tags: [], avatarUrl: null, active: true,
  })),
  allocations: [], timeoffs: [], holidays: [], projects: [], timeoffTypes: [], departments: [], roles: [],
};

let root: Root | null = null;
let host: HTMLElement;
function mount(locale: UiLocale) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(<ScheduleScreen i18n={createI18n(locale)} data={data} today="2026-10-19" widthPx={960} heightPx={480} />));
}
afterEach(() => { act(() => root?.unmount()); host.remove(); root = null; });
const button = (name: string) => [...host.querySelectorAll("button")].find((b) => b.textContent === name)!;
const headers = () => [...host.querySelectorAll("[role=columnheader]")];

describe("ScheduleScreen", () => {
  it("pseudo-locale : tout le texte de l'interface passe par le catalogue (seuls les noms restent)", () => {
    mount("pseudo");
    const texts = [...host.querySelectorAll("button, [role=toolbar] span")].map((e) => e.textContent ?? "");
    expect(texts.length).toBeGreaterThan(5);
    for (const t of texts) expect(t).toMatch(/^\[.*\]$/);
    expect(host.querySelector("[role=grid]")!.getAttribute("aria-label")).toMatch(/^\[.*\]$/);
  });

  it("grille montée : une ligne par personne, compteur au pluriel", () => {
    mount("fr");
    expect([...host.querySelectorAll("[role=rowheader]")].map((e) => e.textContent)).toEqual(["Alice", "Bruno"]);
    expect(host.textContent).toContain("2 personnes");
  });

  it("zoom semaine : bouton pressé, en-têtes par semaine ; précédent puis Aujourd'hui recentre", () => {
    mount("fr");
    const days = headers().length;
    act(() => button("Semaine").click());
    expect(button("Semaine").getAttribute("aria-pressed")).toBe("true");
    expect(headers().length).toBeLessThan(days);
    const centered = headers().map((h) => h.getAttribute("data-from"));
    act(() => button("Période précédente").click());
    expect(headers().map((h) => h.getAttribute("data-from"))).not.toEqual(centered);
    act(() => button("Aujourd’hui").click());
    expect(headers().map((h) => h.getAttribute("data-from"))).toEqual(centered);
  });

  it("raccourci T : Aujourd'hui", () => {
    mount("en");
    act(() => button("Next period").click());
    const moved = headers()[0]!.getAttribute("data-from");
    act(() => host.querySelector("[role=grid]")!.dispatchEvent(new KeyboardEvent("keydown", { key: "t", bubbles: true })));
    expect(headers()[0]!.getAttribute("data-from")).not.toBe(moved);
  });
});
