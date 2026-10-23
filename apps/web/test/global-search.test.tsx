// @vitest-environment jsdom
// Recherche globale (recette n°4, D5 : RT-059, rouvre RT-038) : le bouton « Rechercher » et son raccourci vivent dans l'en-tête
// commun, juste avant la cloche ; la palette est montée par la coque, Ctrl+K marche sur tous les écrans. Hors du Planning, les
// personnes et les projets viennent des listes que l'app charge déjà ; choisir une personne ouvre le Planning (?personne=) qui
// révèle sa ligne ; choisir un projet ouvre sa fiche.
import type { PersonDetail, ProjectDetail } from "@wnext/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ScheduleScreen } from "../src/ScheduleScreen";
import { createDemoNotificationsSource } from "../src/data/notifications-source";
import { demoSchedule } from "../src/demo";
import { createI18n } from "../src/i18n";
import { App } from "../src/shell/app";
import { searchSources } from "../src/shell/global-search";
import { demoMe } from "../src/shell/me";
import { createRouter, type Router } from "../src/shell/router";
import { GUTTER_PX, type Clock } from "../src/schedule/scroller";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLElement;
const flush = async () => { for (let i = 0; i < 6; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
afterEach(() => { act(() => root?.unmount()); host?.remove(); root = null; document.body.innerHTML = ""; });

function memoryRouter(path = "/", search = ""): Router & { loc: { pathname: string; search: string } } {
  const loc = { pathname: path, search };
  const router = createRouter({
    location: loc,
    history: {
      pushState: (_s, _u, url) => { const [p, q = ""] = url.split("?"); loc.pathname = p!; loc.search = q ? `?${q}` : ""; },
      replaceState: (_s, _u, url) => { const [p, q = ""] = url.split("?"); loc.pathname = p!; loc.search = q ? `?${q}` : ""; },
    },
    onPopState: () => () => {},
  });
  return Object.assign(router, { loc });
}

const dialog = () => document.body.querySelector<HTMLElement>('[role="dialog"]');
const input = () => document.body.querySelector<HTMLInputElement>('input[role="combobox"]')!;
const options = () => [...document.body.querySelectorAll<HTMLElement>('[role="option"]')];
const press = (target: EventTarget, init: KeyboardEventInit) =>
  act(() => { target.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init })); });
async function type(value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input(), value);
    input().dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
  });
  await flush();
}

const people = [{ id: "p1", name: "Alice Martin", active: true }, { id: "p2", name: "Ancien Collègue", active: false }] as PersonDetail[];
const projects = [{ id: "j1", name: "Refonte", color: "#3B82F6", status: "in_progress" }, { id: "j2", name: "Archivé", color: null, status: "archived" }] as ProjectDetail[];

function mountApp(path: string) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  const router = memoryRouter(path);
  const openProject = vi.fn();
  const sources = searchSources({
    people: { listPeople: async () => ({ ok: true, value: people }) },
    projects: { listProjects: async () => ({ ok: true, value: projects }) },
    openPerson: (id) => router.navigate("planning", { personne: id }),
    openProject,
  });
  act(() => root!.render(
    <App i18n={createI18n("fr")} router={router} me={{ status: "ready", me: demoMe() }} notifications={createDemoNotificationsSource([])} search={sources}
      renderPlanning={() => <main><h1 tabIndex={-1}>Planning</h1><p data-reveal={router.param("personne") ?? ""}>grille</p></main>}
      renderProjects={() => <main><h1 tabIndex={-1}>Projets</h1></main>} />));
  return { router, openProject };
}

describe("bouton de recherche dans l'en-tête commun (RT-059)", () => {
  it("juste avant la cloche, avec la pastille du raccourci et aria-keyshortcuts", async () => {
    mountApp("/projets");
    await flush();
    const end = host.querySelector(".wn-appheader-end")!;
    const buttons = [...end.querySelectorAll("button")];
    const search = buttons.findIndex((b) => /^Rechercher/.test(b.textContent ?? ""));
    const bell = buttons.findIndex((b) => /^Notifications/.test(b.getAttribute("aria-label") ?? b.textContent ?? ""));
    expect(search).toBeGreaterThanOrEqual(0);
    expect(bell).toBe(search + 1);
    expect(buttons[search]!.querySelector("kbd")!.textContent).toMatch(/^(Ctrl K|⌘K)$/);
    expect(buttons[search]!.getAttribute("aria-keyshortcuts")).toBe("Control+K Meta+K");
  });
});

describe("palette globale (RT-059)", () => {
  it("Ctrl+K hors du Planning : personnes actives de la liste chargée ; en choisir une ouvre le Planning sur sa ligne", async () => {
    const { router } = mountApp("/projets");
    await flush();
    await press(document.body, { key: "k", ctrlKey: true });
    await flush();
    expect(dialog()).not.toBeNull();
    await type("a");
    expect(options().map((o) => o.textContent)).toContain("Alice Martin");
    expect(options().map((o) => o.textContent)).not.toContain("Ancien Collègue");
    await press(input(), { key: "ArrowDown" });
    await act(async () => { options().find((o) => o.textContent === "Alice Martin")!.click(); });
    await flush();
    expect(dialog()).toBeNull();
    expect(router.current()).toBe("planning");
    expect(router.param("personne")).toBe("p1");
    expect(host.querySelector("[data-reveal]")!.getAttribute("data-reveal")).toBe("p1");
  });

  it("choisir un projet ouvre sa fiche ; les projets archivés ne sont pas proposés", async () => {
    const { openProject } = mountApp("/projets");
    await flush();
    await press(document.body, { key: "k", ctrlKey: true });
    await flush();
    await type("r");
    const texts = options().map((o) => o.textContent);
    expect(texts).toContain("Refonte");
    expect(texts).not.toContain("Archivé");
    await act(async () => { options().find((o) => o.textContent === "Refonte")!.click(); });
    await flush();
    expect(openProject).toHaveBeenCalledWith("j1");
  });
});

describe("Planning ouvert sur une personne (?personne=)", () => {
  it("la ligne est amenée dans la vue, mise en évidence et annoncée ; l'appelant est prévenu", async () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    const clock: Partial<Clock> = { raf: () => 0, caf: () => {}, now: () => 0, idle: () => {}, setTimer: () => 0, clearTimer: () => {} };
    const done = vi.fn();
    act(() => root!.render(
      <ScheduleScreen i18n={createI18n("fr")} data={demoSchedule("2026-10-20", 40)} today="2026-10-20" widthPx={GUTTER_PX + 960} heightPx={480} clock={clock}
        reveal={{ personId: "40", onDone: done }} />));
    await flush();
    expect([...host.querySelectorAll<HTMLElement>(".wn-row[data-highlight]")].map((e) => e.dataset.person)).toEqual(["40"]);
    expect(host.querySelector(".wn-notice[aria-live]")!.textContent).toContain("Personne 40 : ligne affichée dans le planning");
    expect(done).toHaveBeenCalledTimes(1);
  });
});
