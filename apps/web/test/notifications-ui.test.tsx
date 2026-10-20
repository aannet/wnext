// @vitest-environment jsdom
// Notifications in-app (US-7.3) : cloche de la barre d'état (compteur, annonce polie), panneau (liste, marquer lu, tout marquer lu,
// préférences par type), textes FR/EN composés depuis le type et les compteurs, Échap rend le focus à la cloche.
import type { Notification, ScheduleResponse } from "@wnext/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { ScheduleContainer } from "../src/ScheduleContainer";
import { createDemoSource } from "../src/data/demo-source";
import { createDemoNotificationsSource, demoNotifications } from "../src/data/notifications-source";
import { createI18n } from "../src/i18n";
import { notificationText } from "../src/notifications/notifications-ui";
import { NotificationsMenu } from "../src/shell/app-header";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const TODAY = "2026-10-20";
const flush = async () => { for (let i = 0; i < 5; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
let root: Root | null = null;
let host: HTMLElement;
afterEach(() => { act(() => root?.unmount()); host.remove(); root = null; });

const data = (): ScheduleResponse => ({
  window: { from: "2026-10-01", to: "2026-11-30" }, changeCursor: "0", page: { nextCursor: null, total: 1 },
  account: { weekStart: 1, capacityThresholds: { underPercent: 80 }, timezone: "Europe/Paris" },
  people: [{ id: "1", version: 1, name: "Alice", peopleType: "employee", departmentId: null, roleId: null, country: null,
    workDaysHours: [8, 8, 8, 8, 8, 0, 0], tags: [], avatarUrl: null, active: true }],
  allocations: [], timeoffs: [], holidays: [], projects: [], timeoffTypes: [], departments: [], roles: [],
});
async function mount(withNotifications = true, lang: "fr" | "en" = "fr") {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  const notifications = createDemoNotificationsSource(demoNotifications(TODAY, new Date("2026-10-20T10:00:00Z")));
  // La cloche vit désormais dans l'en-tête applicatif (shell/app-header) et non dans le conteneur : même composants, autre point de montage.
  const i18n = createI18n(lang);
  act(() => root!.render(<>
    {withNotifications && <NotificationsMenu i18n={i18n} source={notifications} />}
    <ScheduleContainer i18n={i18n} source={createDemoSource(data())} widthPx={960} heightPx={480} />
  </>));
  await flush();
  return notifications;
}
const button = (name: string | RegExp) => [...host.querySelectorAll("button")].find((b) => (typeof name === "string" ? b.textContent === name : name.test(b.textContent ?? "")));
const click = async (b: HTMLElement | undefined) => { if (!b) throw new Error("bouton absent"); act(() => b.click()); await flush(); };
const live = () => host.querySelector("[aria-live=polite]")!.textContent;
const bell = () => host.querySelector<HTMLButtonElement>(".wn-notifications-open")!;

describe("cloche et panneau", () => {
  it("absente sans source ; avec : compteur des non lues et annonce polie", async () => {
    await mount(false);
    expect(host.querySelector(".wn-notifications-open")).toBeNull();
    act(() => root!.unmount()); host.remove();
    await mount();
    expect(bell().textContent).toBe("Notifications2");
    expect(bell().getAttribute("aria-expanded")).toBe("false");
    expect(live()).toBe("2 notifications non lues");
  });

  it("liste (textes composés), marquer lu, tout marquer lu : compteur à 0 ; préférences ; Échap rend le focus", async () => {
    const source = await mount();
    await click(bell());
    expect(bell().getAttribute("aria-expanded")).toBe("true");
    const panel = host.querySelector("#wn-notifications-panel")!;
    expect(panel.querySelector("h2")!.textContent).toBe("Notifications");
    const items = [...panel.querySelectorAll("li")];
    expect(items.map((li) => li.querySelector(".wn-notification-title")!.textContent)).toEqual([
      "Camille Durand a modifié vos allocations", "Camille Durand a traité votre demande de congé",
      "Votre modification n’a pas été enregistrée : Lou Martin avait modifié une allocation entre-temps",
    ]);
    expect(items[0]!.querySelector(".wn-notification-details")!.textContent).toBe("2 allocations créées · 1 allocation modifiée · à partir du mar. 20 oct.");
    expect(items[1]!.querySelector(".wn-notification-details")!.textContent).toMatch(/^Congé approuvé · /);
    expect(panel.querySelectorAll(".wn-notification-unread")).toHaveLength(2);

    await click([...items[0]!.querySelectorAll("button")].find((b) => b.textContent === "Marquer comme lue"));
    expect(live()).toBe("1 notification non lue");
    expect(host.querySelectorAll(".wn-notification-unread")).toHaveLength(1);
    await click(button("Tout marquer comme lu"));
    expect(live()).toBe("Aucune notification non lue");
    expect(bell().querySelector(".wn-badge")).toBeNull();
    expect(button("Tout marquer comme lu")!.disabled).toBe(true);

    const boxes = [...host.querySelectorAll<HTMLInputElement>("fieldset input[type=checkbox]")];
    expect(boxes.map((b) => [b.closest("label")!.textContent, b.checked])).toEqual([
      [" les changements de mes allocations", true], [" les décisions sur mes congés", true], [" les conflits d’édition", true],
    ]);
    await click(boxes[1]);
    expect(source.getState().preferences!.find((p) => p.type === "timeoff_decided")!.enabled).toBe(false);

    act(() => { host.querySelector("#wn-notifications-panel")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
    await flush();
    expect(host.querySelector("#wn-notifications-panel")).toBeNull();
    expect(document.activeElement).toBe(bell());
  });

  it("compteur poussé par le temps réel : badge et annonce mis à jour aussitôt, puis liste relue (la source fait foi)", async () => {
    const source = await mount();
    act(() => source.pushUnread(5));
    expect(bell().querySelector(".wn-badge")!.textContent).toBe("5");
    expect(live()).toBe("5 notifications non lues");
    await flush();
    expect(bell().querySelector(".wn-badge")!.textContent).toBe("2"); // la démo n'a que 2 non lues : relecture
  });
});

describe("textes", () => {
  const n = (over: Partial<Notification>): Notification => ({
    id: "1", type: "allocation_changed", entity: "allocations", entityId: "1", actor: null,
    counts: { created: 0, updated: 0, deleted: 3, approved: 0, declined: 0 }, startDate: null, currentVersion: null,
    createdAt: "2026-10-20T10:00:00.000Z", readAt: null, ...over,
  });
  const day = (iso: string) => iso;
  it("FR et EN, auteur inconnu, entité hors liste, regroupement", () => {
    const fr = createI18n("fr"); const en = createI18n("en");
    expect(notificationText(fr, n({}), day)).toEqual({ title: "Quelqu’un a modifié vos allocations", details: "3 allocations supprimées" });
    expect(notificationText(en, n({}), day)).toEqual({ title: "Someone changed your allocations", details: "3 allocations deleted" });
    expect(notificationText(en, n({ type: "timeoff_decided", entity: "timeoffs", counts: { created: 0, updated: 0, deleted: 0, approved: 0, declined: 2 }, startDate: "2026-11-02" }), day))
      .toEqual({ title: "Someone handled your time off request", details: "2 time off requests declined · from 2026-11-02" });
    expect(notificationText(fr, n({ type: "edit_conflict", entity: "milestones", counts: { created: 0, updated: 0, deleted: 0, approved: 0, declined: 0 }, actor: { id: "2", name: "Bea" } }), day))
      .toEqual({ title: "Votre modification n’a pas été enregistrée : Bea avait modifié un élément entre-temps", details: "" });
  });
});
