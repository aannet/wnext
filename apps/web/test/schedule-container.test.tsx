// @vitest-environment jsdom
// Conteneur branché sur la source : chargement, erreur traduite (401 -> UNAUTHENTICATED), grille une fois les données reçues.
import type { ScheduleResponse } from "@wnext/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { ScheduleContainer } from "../src/ScheduleContainer";
import { createClient, type FetchResponse } from "../src/api/client.gen";
import { createScheduleSource } from "../src/data/schedule-source";
import { createI18n } from "../src/i18n";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const flush = async () => { for (let i = 0; i < 10; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };

function body(q: URLSearchParams): ScheduleResponse {
  return {
    window: { from: q.get("from")!, to: q.get("to")! }, changeCursor: "1", page: { nextCursor: null, total: 1 },
    account: { weekStart: 1, capacityThresholds: { underPercent: 80 }, timezone: "Europe/Paris" },
    people: [{ id: "1", version: 1, name: "Alice", peopleType: "employee", departmentId: null, roleId: null, country: null,
      workDaysHours: [8, 8, 8, 8, 8, 0, 0], tags: [], avatarUrl: null, active: true }],
    allocations: [], timeoffs: [], holidays: [], projects: [], timeoffTypes: [], departments: [], roles: [],
  };
}

let root: Root | null = null;
let host: HTMLElement;
function mount(respond: (q: URLSearchParams) => Promise<{ status: number; body: unknown }>) {
  const fetch = async (url: string): Promise<FetchResponse> => {
    const r = await respond(new URL(url, "http://x").searchParams);
    return { status: r.status, json: async () => r.body };
  };
  const source = createScheduleSource({ api: createClient({ baseUrl: "", fetch }) });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(<ScheduleContainer i18n={createI18n("fr")} source={source} now={new Date("2026-10-19T10:00:00Z")} widthPx={960} heightPx={480} />));
}
afterEach(() => { act(() => root?.unmount()); host.remove(); root = null; });

describe("ScheduleContainer", () => {
  it("chargement puis grille ; statut temps réel discret", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    mount(async (q) => { await gate; return { status: 200, body: body(q) }; });
    expect(host.textContent).toContain("Chargement…");
    expect(host.querySelector("[role=grid]")).toBeNull();
    release();
    await flush();
    expect([...host.querySelectorAll("[role=rowheader]")].map((e) => e.textContent)).toEqual(["Alice"]);
    expect(host.querySelector("[role=status]")!.textContent).toBe("Temps réel : hors ligne");
  });

  it("repères de page : un <main> qui contient tout (barre d'outils comprise), un seul <h1> traduit", async () => {
    mount(async (q) => ({ status: 200, body: body(q) }));
    expect(host.querySelector("main h1")!.textContent).toBe("Planning");
    await flush();
    const main = host.querySelector("main")!;
    expect(host.firstElementChild).toBe(main);
    expect([host.querySelectorAll("main").length, host.querySelectorAll("h1").length]).toEqual([1, 1]);
    expect(main.querySelector("h1")!.textContent).toBe("Planning");
    for (const role of ["toolbar", "grid", "status"]) expect(main.querySelector(`[role=${role}]`), role).not.toBeNull();
  });

  it("401 : message UNAUTHENTICATED traduit, pas de grille", async () => {
    mount(async () => ({ status: 401, body: { code: "UNAUTHENTICATED", params: {}, requestId: "r" } }));
    await flush();
    expect(host.querySelector("[role=alert]")!.textContent).toBe("Session expirée ou absente : reconnectez-vous.");
    expect(host.querySelector("[role=grid]")).toBeNull();
  });

  it("code inconnu de l'écran : message générique INTERNAL_ERROR", async () => {
    mount(async () => ({ status: 400, body: { code: "SCHEDULE_RANGE_INVALID", params: {}, requestId: "r" } }));
    await flush();
    expect(host.querySelector("[role=alert]")!.textContent).toBe("Le planning n’a pas pu être chargé. Réessayez plus tard.");
  });
});
