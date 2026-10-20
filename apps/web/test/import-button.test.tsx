// @vitest-environment jsdom
// Import CSV (US-1.2), bouton « Importer » de la barre d'état du conteneur : présent seulement avec une source d'import, ouvre
// la boîte de dialogue (import-dialog.test.tsx), focus rendu au bouton à la fermeture.
import type { ScheduleResponse } from "@wnext/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { ScheduleContainer } from "../src/ScheduleContainer";
import { createDemoSource } from "../src/data/demo-source";
import { createDemoImportSource, demoImportSnapshot } from "../src/data/import-source";
import { demoSchedule } from "../src/demo";
import { createI18n } from "../src/i18n";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const TODAY = "2026-10-20";
const flush = async () => { for (let i = 0; i < 5; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
let root: Root | null = null;
let host: HTMLElement;
afterEach(() => { act(() => root?.unmount()); host.remove(); root = null; });

function mount(node: React.ReactNode) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(node));
}
const button = (name: string | RegExp) => [...host.querySelectorAll("button")].find((b) => (typeof name === "string" ? b.textContent === name : name.test(b.textContent ?? "")));
const click = async (name: string | RegExp) => { const b = button(name); if (!b) throw new Error(`bouton absent : ${name}`); act(() => b.click()); await flush(); };
const demoImports = () => createDemoImportSource(demoImportSnapshot(demoSchedule(TODAY), TODAY));

describe("bouton « Importer » du conteneur", () => {
  // Données minimales (la démo complète est lourde à dessiner sous jsdom).
  const data = (): ScheduleResponse => ({
    window: { from: "2026-10-01", to: "2026-11-30" }, changeCursor: "0", page: { nextCursor: null, total: 1 },
    account: { weekStart: 1, capacityThresholds: { underPercent: 80 }, timezone: "Europe/Paris" },
    people: [{ id: "1", version: 1, name: "Alice", peopleType: "employee", departmentId: null, roleId: null, country: null,
      workDaysHours: [8, 8, 8, 8, 8, 0, 0], tags: [], avatarUrl: null, active: true }],
    allocations: [], timeoffs: [], holidays: [], projects: [], timeoffTypes: [], departments: [], roles: [],
  });
  it("absent sans source d'import ; présent avec, ouvre la boîte et rend le focus à la fermeture", async () => {
    mount(<ScheduleContainer i18n={createI18n("fr")} source={createDemoSource(data())} widthPx={960} heightPx={480} />);
    await flush();
    expect(button("Importer")).toBeUndefined();
    act(() => root!.unmount());
    host.remove();
    mount(<ScheduleContainer i18n={createI18n("fr")} source={createDemoSource(data())} widthPx={960} heightPx={480} imports={demoImports()} />);
    await flush();
    await click("Importer");
    expect(host.querySelector("[role=dialog] h2")!.textContent).toBe("Importer un fichier CSV");
    await click("Annuler");
    expect(host.querySelector("[role=dialog]")).toBeNull();
    expect(document.activeElement).toBe(button("Importer"));
  });
});
