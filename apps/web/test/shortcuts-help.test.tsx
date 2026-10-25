// @vitest-environment jsdom
// Aide des raccourcis clavier (RT-064, née de la décision D1 de la recette n°4) : un bouton dans l'en-tête commun, à côté des
// notifications, et la touche « ? » (hors d'un champ de saisie) ouvrent une fenêtre qui liste tous les raccourcis. La liste vient de
// shell/shortcuts, la source des gestionnaires : chaque touche que la grille du Planning, un bloc ou le moteur (gestes au clavier)
// traite figure dans l'aide.
import type { ScheduleResponse } from "@wnext/contracts";
import { keyGesture, timeoffKeyGesture } from "@wnext/engine";
import { act } from "react";
import { version } from "../package.json"; // recopiée de la racine (tests/guardrails/version.test.ts)
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { ScheduleScreen } from "../src/ScheduleScreen";
import { createDemoNotificationsSource } from "../src/data/notifications-source";
import { createDemoSource } from "../src/data/demo-source";
import { createI18n, type UiLocale } from "../src/i18n";
import { fr } from "../src/i18n/messages.fr";
import { historyForSource } from "../src/schedule/history";
import { GUTTER_PX, type Clock } from "../src/schedule/scroller";
import { App } from "../src/shell/app";
import { demoMe } from "../src/shell/me";
import { createRouter } from "../src/shell/router";
import { keyText, SHORTCUTS, type KeyLike } from "../src/shell/shortcuts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLElement;
const flush = async () => { for (let i = 0; i < 6; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
afterEach(() => { act(() => root?.unmount()); host?.remove(); root = null; document.body.innerHTML = ""; });

function mountApp(locale: UiLocale = "fr") {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  const router = createRouter({ location: { pathname: "/projets", search: "" }, history: { pushState: () => {}, replaceState: () => {} }, onPopState: () => () => {} });
  act(() => root!.render(
    <App i18n={createI18n(locale)} router={router} me={{ status: "ready", me: demoMe() }} notifications={createDemoNotificationsSource([])}
      renderPlanning={() => <main><h1>Planning</h1></main>} renderProjects={() => <main><h1 tabIndex={-1}>Projets</h1><input aria-label="champ" /></main>} />));
}
const dialog = () => document.body.querySelector<HTMLElement>("[role=dialog]");
const helpButton = () => host.querySelector<HTMLButtonElement>(".wn-appheader-end button[aria-label='Raccourcis clavier']");
const press = (target: EventTarget, init: KeyboardEventInit) => {
  const ev = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  act(() => { target.dispatchEvent(ev); });
  return ev;
};

describe("bouton et fenêtre d'aide (RT-064)", () => {
  it("le pied de la fenêtre affiche la version du produit et son commit", async () => {
    mountApp();
    await flush();
    await act(async () => { helpButton()!.click(); });
    await flush();
    expect(dialog()!.querySelector(".wn-app-version")!.textContent).toMatch(new RegExp(`^WNEXT ${version.replace(/\./g, "\\.")}( · [0-9a-f]{7,})?$`));
  });

  it("bouton dans l'en-tête commun, juste après la cloche, annonçant « ? » ; il ouvre la fenêtre et retrouve le focus à la fermeture", async () => {
    mountApp();
    await flush();
    const buttons = [...host.querySelectorAll<HTMLButtonElement>(".wn-appheader-end button")];
    const bell = buttons.findIndex((b) => b.classList.contains("wn-notifications-open"));
    expect(buttons[bell + 1]).toBe(helpButton());
    expect(helpButton()!.getAttribute("aria-keyshortcuts")).toBe("?");
    expect(helpButton()!.getAttribute("aria-haspopup")).toBe("dialog");
    await act(async () => { helpButton()!.click(); });
    await flush();
    expect(dialog()!.querySelector("h2")!.textContent).toBe("Raccourcis clavier");
    press(dialog()!, { key: "Escape" });
    await flush();
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(helpButton());
  });

  it("la fenêtre liste chaque raccourci de la source unique, avec ses touches, par groupe", async () => {
    mountApp();
    await flush();
    await act(async () => { helpButton()!.click(); });
    await flush();
    const text = dialog()!.textContent!;
    for (const s of SHORTCUTS) expect(text, s.id).toContain(fr[s.label]);
    expect([...dialog()!.querySelectorAll("h3")].map((h) => h.textContent)).toEqual(["Partout", "Grille du planning", "Bloc sélectionné", "Congé sélectionné"]);
    const rows = [...dialog()!.querySelectorAll<HTMLElement>("[data-shortcut-id]")];
    expect(rows.map((r) => r.dataset.shortcutId)).toEqual(SHORTCUTS.map((s) => s.id));
    const keysOf = (id: string) => [...rows.find((r) => r.dataset.shortcutId === id)!.querySelectorAll("kbd")].map((k) => k.textContent);
    expect(keysOf("create")).toEqual(["N"]);
    expect(keysOf("delete")).toEqual(["Suppr", "Retour arrière"]);
    expect(keysOf("redo")).toEqual([keyText("mod", (k) => fr[k]), "Maj", "Z", keyText("mod", (k) => fr[k]), "Y"]);
    // Liste plus haute que la fenêtre (groupe « Congé sélectionné », RT-051) : une région focalisable, défilable au clavier (axe).
    const region = dialog()!.querySelector<HTMLElement>("[role=region]");
    expect([region?.tabIndex, region?.getAttribute("aria-label"), region?.contains(rows[0]!)]).toEqual([0, "Raccourcis clavier", true]);
  });

  it("touche « ? » hors d'un champ : ouvre l'aide ; dans un champ de saisie : rien", async () => {
    mountApp();
    await flush();
    const field = host.querySelector<HTMLInputElement>("input")!;
    field.focus();
    expect(press(field, { key: "?", shiftKey: true }).defaultPrevented).toBe(false);
    await flush();
    expect(dialog()).toBeNull();
    press(document.body, { key: "?", shiftKey: true });
    await flush();
    expect(dialog()!.querySelector("h2")!.textContent).toBe("Raccourcis clavier");
  });

  it("EN : titre et groupes traduits", async () => {
    mountApp("en");
    await flush();
    await act(async () => { host.querySelector<HTMLButtonElement>(".wn-appheader-end button[aria-label='Keyboard shortcuts']")!.click(); });
    await flush();
    expect(dialog()!.querySelector("h2")!.textContent).toBe("Keyboard shortcuts");
    expect(dialog()!.textContent).toContain("New allocation");
  });
});

describe("l'aide ne diverge pas des gestionnaires (RT-064)", () => {
  const KEYS = [..."abcdefghijklmnopqrstuvwxyz", "/", "?", "Enter", "Escape", "Delete", "Backspace", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown", " ", "ContextMenu", "F10"];
  const MODS: KeyLike[] = [{ key: "" }, { key: "", shiftKey: true }, { key: "", ctrlKey: true }, { key: "", altKey: true }, { key: "", metaKey: true }];
  const combos = KEYS.flatMap((key) => MODS.map((m) => ({ ...m, key })));
  const documented = (e: KeyLike, scopes: readonly string[]) => SHORTCUTS.some((s) => scopes.includes(s.scope) && s.match(e));

  it("toute touche reconnue par le moteur pour un bloc (gestes au clavier) figure dans l'aide (portée bloc)", () => {
    const block = { personId: "b", startDate: "2026-01-05", endDate: "2026-01-06", mode: "hours", hoursPerDay: 4, percent: null, repeatState: "none", repeatEndDate: null } as const;
    for (const e of combos) if (keyGesture(e, block, ["a", "b", "c"])) expect(documented(e, ["block"]), JSON.stringify(e)).toBe(true);
  });

  it("toute touche reconnue par le moteur pour un congé (RT-051) figure dans l'aide (portée congé)", () => {
    for (const e of combos) if (timeoffKeyGesture(e, 1)) expect(documented(e, ["timeoff"]), JSON.stringify(e)).toBe(true);
  });

  it("toute touche que la grille ou un bloc du Planning traite (preventDefault) figure dans l'aide", async () => {
    const TODAY = "2026-10-20";
    type Alloc = ScheduleResponse["allocations"][number];
    const a = { id: "a", version: 1, personId: "1", projectId: "1", phaseId: null, taskId: null, groupId: null, name: null, notes: null, startDate: TODAY, endDate: "2026-10-21",
      status: "confirmed", billable: true, priority: 0, repeatState: "none", repeatEndDate: null, mode: "hours", hoursPerDay: 4, percent: null } as Alloc;
    const data: ScheduleResponse = {
      window: { from: "2025-10-01", to: "2027-10-01" }, changeCursor: "0", page: { nextCursor: null, total: 2 },
      account: { weekStart: 1, capacityThresholds: { underPercent: 80 }, timezone: "Europe/Paris" },
      people: ["1", "2"].map((id) => ({ id, version: 1, name: `P${id}`, peopleType: "employee" as const, departmentId: null, roleId: null, country: null,
        workDaysHours: [8, 8, 8, 8, 8, 0, 0], tags: [], avatarUrl: null, active: true })),
      allocations: [a], timeoffs: [{ id: "o", version: 1, personId: "2", typeId: "t1", startDate: TODAY, endDate: TODAY, scope: "full_day", startHalf: "am", endHalf: "pm",
        hoursPerDay: null, approvalStatus: "approved" }], holidays: [], departments: [], roles: [], timeoffTypes: [{ id: "t1", version: 1, name: "CP", deducted: true }],
      projects: [{ id: "1", version: 1, name: "Refonte", projectCode: null, color: "#3B82F6", status: "in_progress", nonBillable: false, startDate: null, endDate: null }],
    };
    const clock: Partial<Clock> = { raf: () => 0, caf: () => {}, now: () => 0, idle: () => {}, setTimer: () => 0, clearTimer: () => {} };
    const fresh = () => {
      act(() => root?.unmount());
      host?.remove();
      host = document.createElement("div");
      document.body.innerHTML = "";
      document.body.appendChild(host);
      root = createRoot(host);
      const src = createDemoSource(structuredClone(data));
      const { history } = historyForSource(src);
      act(() => root!.render(<ScheduleScreen i18n={createI18n("fr")} data={src.getState().data!} today={TODAY} widthPx={GUTTER_PX + 960} heightPx={480} clock={clock}
        editor={history.editor} history={history} records={src} />));
    };
    const undocumented: string[] = [];
    const targets = { grille: "[role=grid]", bloc: '.wn-block[data-key="a:0"]', congé: '.wn-timeoff[data-timeoff="o"]' } as const;
    const scopes = { grille: ["global", "planning"], bloc: ["global", "planning", "block"], congé: ["global", "planning", "timeoff"] } as const;
    for (const on of ["grille", "bloc", "congé"] as const) {
      let dirty = true; // un écran neuf après chaque touche qui a agi (fenêtre ouverte, bloc déplacé ou supprimé…)
      for (const e of combos) {
        if (dirty) fresh();
        const target = host.querySelector<HTMLElement>(targets[on])!;
        act(() => target.focus());
        const ev = press(target, e);
        dirty = ev.defaultPrevented || document.querySelector("[role=dialog], [role=alertdialog], [role=menu]") !== null;
        if (ev.defaultPrevented && !documented(e, scopes[on])) undocumented.push(`${on} ${JSON.stringify(e)}`);
      }
    }
    expect(undocumented).toEqual([]);
  }, 60_000);
});
