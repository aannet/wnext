// @vitest-environment jsdom
// Import CSV (US-1.2) : une seule entrée depuis la recette n°4 (D9 : RT-054), la section Réglages > Import, réservée owner et admin
// (la page Réglages l'est, et l'appelant ne fournit la source d'import qu'à eux). Plus de bouton « Importer » dans le Planning ni
// dans Personnes ; les états vides de Personnes et de Projets mènent à la section.
import type { ScheduleResponse } from "@wnext/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ScheduleContainer } from "../src/ScheduleContainer";
import { createDemoAccountSource } from "../src/data/account-source";
import { createDemoSource } from "../src/data/demo-source";
import { createDemoImportSource, demoImportSnapshot } from "../src/data/import-source";
import { createDemoDirectory } from "../src/data/people-source";
import { createDemoProjectsSource } from "../src/data/projects-source";
import { demoSchedule } from "../src/demo";
import { createI18n } from "../src/i18n";
import { PeopleScreen } from "../src/people/people-screen";
import { ProjectsScreen } from "../src/projects/projects-screen";
import { SettingsScreen } from "../src/settings/settings-screen";
import { demoMe } from "../src/shell/me";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const TODAY = "2026-10-20";
const flush = async () => { for (let i = 0; i < 8; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
let root: Root | null = null;
let host: HTMLElement;
afterEach(() => { act(() => root?.unmount()); host.remove(); root = null; document.body.innerHTML = ""; });

function mount(node: React.ReactNode) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(node));
}
const button = (name: string | RegExp) => [...document.body.querySelectorAll("button")].find((b) => (typeof name === "string" ? b.textContent === name : name.test(b.textContent ?? "")));
const click = async (el: HTMLElement | undefined) => { if (!el) throw new Error("élément absent"); act(() => el.click()); await flush(); };
const demoImports = () => createDemoImportSource(demoImportSnapshot(demoSchedule(TODAY), TODAY));
const i18n = createI18n("fr");
const schedule = () => demoSchedule(TODAY, 4);
const settings = { id: "1", version: 1, name: "WNEXT", timezone: "Europe/Paris", weekStart: 1, defaultLocale: "fr", capacityThresholds: { underPercent: 80 } } as const;
const LINK = "Importer depuis un fichier CSV (Réglages > Import)";

describe("Réglages > Import, seule entrée de l'import (RT-054)", () => {
  it("avec une source d'import (owner, admin) : onglet Import, bouton qui ouvre la boîte et retrouve le focus à la fermeture", async () => {
    const dir = createDemoDirectory(schedule(), { today: TODAY });
    mount(<SettingsScreen i18n={i18n} reference={dir.reference} projects={createDemoProjectsSource(schedule(), { onProject: () => {} })} account={createDemoAccountSource(settings)} canEdit imports={demoImports()} />);
    await flush();
    const tabs = [...document.body.querySelectorAll<HTMLElement>("[role=tab]")];
    expect(tabs.map((t) => t.textContent).at(-1)).toBe("Import");
    await click(tabs.at(-1));
    const open = button("Importer un fichier CSV…")!;
    await click(open);
    expect(document.body.querySelector("[role=dialog] h2")!.textContent).toBe("Importer un fichier CSV");
    await click([...document.body.querySelectorAll<HTMLButtonElement>("[role=dialog] button")].find((b) => b.textContent === "Annuler"));
    expect(document.body.querySelector("[role=dialog]")).toBeNull();
    expect(document.activeElement).toBe(button("Importer un fichier CSV…"));
  });

  it("onglet demandé par l'appelant (lien d'un état vide) : Import ouvert d'emblée", async () => {
    const dir = createDemoDirectory(schedule(), { today: TODAY });
    mount(<SettingsScreen i18n={i18n} reference={dir.reference} projects={createDemoProjectsSource(schedule(), { onProject: () => {} })} account={createDemoAccountSource(settings)} canEdit imports={demoImports()} initialTab="import" />);
    await flush();
    expect(document.body.querySelector("[role=tab][aria-selected=true]")!.textContent).toBe("Import");
    expect(button("Importer un fichier CSV…")).toBeDefined();
  });

  it("sans source d'import : pas d'onglet Import", async () => {
    const dir = createDemoDirectory(schedule(), { today: TODAY });
    mount(<SettingsScreen i18n={i18n} reference={dir.reference} projects={createDemoProjectsSource(schedule(), { onProject: () => {} })} account={createDemoAccountSource(settings)} canEdit />);
    await flush();
    expect([...document.body.querySelectorAll("[role=tab]")].map((t) => t.textContent)).not.toContain("Import");
  });
});

describe("plus d'import dans le Planning ni dans Personnes (RT-054)", () => {
  const data = (): ScheduleResponse => ({
    window: { from: "2026-10-01", to: "2026-11-30" }, changeCursor: "0", page: { nextCursor: null, total: 1 },
    account: { weekStart: 1, capacityThresholds: { underPercent: 80 }, timezone: "Europe/Paris" },
    people: [{ id: "1", version: 1, name: "Alice", peopleType: "employee", departmentId: null, roleId: null, country: null,
      workDaysHours: [8, 8, 8, 8, 8, 0, 0], tags: [], avatarUrl: null, active: true }],
    allocations: [], timeoffs: [], holidays: [], projects: [], timeoffTypes: [], departments: [], roles: [],
  });

  it("Planning d'un owner : aucun bouton « Importer »", async () => {
    mount(<ScheduleContainer i18n={i18n} source={createDemoSource(data())} widthPx={960} heightPx={480} me={demoMe()} />);
    await flush();
    expect(button(/^Importer/)).toBeUndefined();
  });

  it("Personnes d'un owner : aucun bouton « Importer » ; l'état vide mène à Réglages > Import", async () => {
    const dir = createDemoDirectory(schedule(), { today: TODAY });
    const onOpen = vi.fn();
    mount(<PeopleScreen i18n={i18n} source={{ ...dir.people, listPeople: async () => ({ ok: true, value: [] }) }} reference={dir.reference} account={demoMe().account} canEdit
      importLink={{ href: "/reglages?onglet=import", onOpen }} />);
    await flush();
    expect(button(/^Importer/)).toBeUndefined();
    const link = [...document.body.querySelectorAll<HTMLAnchorElement>(".wn-empty a")].find((a) => a.textContent === LINK)!;
    expect(link.getAttribute("href")).toBe("/reglages?onglet=import");
    await click(link);
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("Projets : l'état vide mène à Réglages > Import ; sans lien fourni (rôle sans import), rien", async () => {
    const empty = { ...createDemoProjectsSource(schedule(), { onProject: () => {} }), listProjects: async () => ({ ok: true as const, value: [] }) };
    mount(<ProjectsScreen i18n={i18n} source={empty} canEdit importLink={{ href: "/reglages?onglet=import", onOpen: () => {} }} />);
    await flush();
    expect([...document.body.querySelectorAll(".wn-empty a")].map((a) => a.textContent)).toEqual([LINK]);
    act(() => root!.unmount());
    host.remove();
    mount(<ProjectsScreen i18n={i18n} source={empty} canEdit={false} />);
    await flush();
    expect(document.body.querySelectorAll(".wn-empty a")).toHaveLength(0);
  });
});
