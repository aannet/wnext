// @vitest-environment jsdom
// Défilement horizontal continu (ADR-005 A2) : piste, pixel <-> date, tranches du modèle, recyclage, préchargement,
// « Aujourd'hui » doux, zoom au centre conservé, clavier. Horloge (rAF, minuteries, tâches de fond) pilotée par le test.
import type { ScheduleResponse } from "@wnext/contracts";
import { DEFAULT_PX_PER_DAY, addDays, chunkCover, dateAtX, dayNumber, neighborDays, scrollLeftOf, visibleRange, type Viewport } from "@wnext/engine";
import { describe, expect, it } from "vitest";
import { createClient, type FetchResponse } from "../src/api/client.gen";
import { createScheduleSource } from "../src/data/schedule-source";
import { buildGrid } from "../src/schedule/grid-model";
import { GUTTER_PX, HEADER_PX, HIGHLIGHT_MS, createScroller, type Clock, type ScrollerOptions } from "../src/schedule/scroller";

const TODAY = "2026-10-20";
const DAY = DEFAULT_PX_PER_DAY.day;

/** 60 personnes, une allocation de 3 jours chaque semaine pendant 4 ans : densité uniforme. */
function uniform(people = 60): ScheduleResponse {
  const allocations: ScheduleResponse["allocations"] = [];
  for (let p = 1; p <= people; p++) {
    for (let w = 0; w < 210; w++) {
      const start = addDays("2024-10-07", w * 7 + (p % 4));
      allocations.push({
        id: String(allocations.length + 1), version: 1, personId: String(p), projectId: "1", phaseId: null, taskId: null, groupId: null,
        name: null, notes: null, startDate: start, endDate: addDays(start, 2), status: "confirmed", billable: true, priority: 0,
        repeatState: "none", repeatEndDate: null, mode: "hours", hoursPerDay: 4, percent: null,
      });
    }
  }
  return {
    window: { from: "2024-10-07", to: "2028-10-01" }, changeCursor: "0", page: { nextCursor: null, total: people },
    account: { weekStart: 1, capacityThresholds: { underPercent: 80 }, timezone: "Europe/Paris" },
    people: Array.from({ length: people }, (_, i) => ({
      id: String(i + 1), version: 1, name: `P${i + 1}`, peopleType: "employee" as const, departmentId: null, roleId: null, country: null,
      workDaysHours: [8, 8, 8, 8, 8, 0, 0], tags: [], avatarUrl: null, active: true,
    })),
    allocations, timeoffs: [], holidays: [], timeoffTypes: [], departments: [], roles: [],
    projects: [{ id: "1", version: 1, name: "Refonte", projectCode: null, color: "#3B82F6", status: "in_progress", nonBillable: false, startDate: null, endDate: null }],
  };
}

function manualClock() {
  let t = 0;
  let id = 0;
  const frames = new Map<number, () => void>();
  const timers = new Map<number, { cb: () => void; at: number }>();
  const idles: (() => void)[] = [];
  const clock: Clock = {
    raf: (cb) => (frames.set(++id, cb), id),
    caf: (i) => { frames.delete(i); },
    now: () => t,
    setTimer: (cb, ms) => (timers.set(++id, { cb, at: t + ms }), id),
    clearTimer: (i) => { timers.delete(i as number); },
    idle: (cb) => { idles.push(cb); },
  };
  /** Une image de `dt` ms : minuteries échues, rAF en attente, puis tâches de fond (temps libre de fin d'image). */
  const frame = (dt = 16) => {
    t += dt;
    for (const [k, v] of [...timers]) if (v.at <= t) { timers.delete(k); v.cb(); }
    const fs = [...frames.values()];
    frames.clear();
    for (const f of fs) f();
    for (const f of idles.splice(0)) f();
  };
  return { clock, frame, pendingFrames: () => frames.size };
}

function setup(over: Partial<ScrollerOptions> = {}) {
  const root = document.createElement("div");
  document.body.appendChild(root);
  const m = manualClock();
  let builds = 0;
  const ranges: string[] = [];
  const views: Viewport[] = [];
  const s = createScroller({
    root, data: uniform(), today: TODAY, widthPx: GUTTER_PX + 960, heightPx: 480, label: (c) => c.from,
    clock: m.clock, reducedMotion: () => false, onViewChange: (v) => views.push(v),
    build: (...a) => { builds++; ranges.push(`${a[1].from}..${a[1].to}`); return buildGrid(...a); },
    ...over,
  });
  /** Défilement natif simulé : le navigateur change scrollLeft puis émet « scroll ». */
  const scrollTo = (left: number, top = root.scrollTop) => {
    root.scrollLeft = left;
    root.scrollTop = top;
    root.dispatchEvent(new Event("scroll"));
    m.frame();
  };
  const center = () => dateAtX(s.view(), s.view().widthPx / 2);
  const cols = () => [...root.querySelectorAll("[role=columnheader][data-from]")].map((e) => e.getAttribute("data-from")!);
  return { root, s, m, views, scrollTo, center, cols, ranges, builds: () => builds };
}

describe("piste et conversions pixel <-> date", () => {
  it("montage : piste de ±12 mois, vue centrée sur aujourd'hui, en-têtes et surface à la largeur de la piste", () => {
    const h = setup();
    expect(h.center()).toBe(TODAY);
    expect(h.s.view().center).toBe(dayNumber(TODAY) + 0.5);
    const track = { first: addDays(TODAY, -365), last: addDays(TODAY, 365) };
    expect(h.root.scrollLeft).toBe(scrollLeftOf(track, h.s.view()));
    const surface = h.root.querySelector(".wn-surface") as HTMLElement;
    expect(surface.style.width).toBe(`${GUTTER_PX + 731 * DAY}px`);
    const today = h.root.querySelector(`[data-from="${TODAY}"]`) as HTMLElement;
    // Colonne du jour : centrée dans la zone de dates (après la gouttière), en coordonnées de surface.
    expect(today.style.transform).toBe(`translateX(${GUTTER_PX + 365 * DAY}px)`);
    expect(GUTTER_PX + 365 * DAY - h.root.scrollLeft).toBe(GUTTER_PX + 480 - DAY / 2);
    expect(h.cols()).toContain(visibleRange(h.s.view()).from);
    expect(h.cols()).toContain(visibleRange(h.s.view()).to);
    expect(h.views[0]).toEqual(h.s.view());
  });

  it("défilement d'un jour : la vue avance d'un jour, en-têtes et blocs restent alignés", () => {
    const h = setup();
    const start = h.root.scrollLeft;
    h.scrollTo(start + DAY);
    expect(h.center()).toBe(addDays(TODAY, 1));
    const allocs = new Map(uniform().allocations.map((x) => [x.id, x]));
    let checked = 0;
    for (const el of h.root.querySelectorAll<HTMLElement>(".wn-block[data-key]")) {
      const a = allocs.get(el.getAttribute("data-key")!.split(":")[0]!)!;
      const head = h.root.querySelector<HTMLElement>(`[role=columnheader][data-from="${a.startDate}"]`);
      if (!head) continue; // début hors de la fenêtre d'en-tête
      expect(el.style.transform).toMatch(new RegExp(`^translate\\(${head.style.transform.slice(11, -1)}, `));
      checked++;
    }
    expect(checked).toBeGreaterThan(20);
  });

  it("bord gauche atteint : la piste s'allonge et le scrollLeft est reporté, la date au centre ne bouge pas", () => {
    const h = setup();
    h.scrollTo(5 * DAY);
    const at = h.center();
    expect(h.root.scrollLeft).toBeGreaterThan(5 * DAY + 100 * DAY);
    expect(h.center()).toBe(at);
    expect(h.cols()).toContain(at);
  });
});

describe("tranches du modèle et recyclage", () => {
  it("le modèle n'est reconstruit qu'au changement de tranche (pas à chaque pixel), en tâche de fond", () => {
    const h = setup();
    expect(h.builds()).toBe(1);
    const start = h.root.scrollLeft;
    for (let px = 1; px <= 2 * DAY; px++) h.scrollTo(start + px);
    expect(h.builds()).toBe(1); // deux jours de défilement au pixel : même tranche
    const cover = () => JSON.stringify(chunkCover(h.s.view(), 1, neighborDays(h.s.view())));
    let changes = 0;
    let key = cover();
    for (let px = 2 * DAY; px <= 120 * DAY; px += 24) {
      h.scrollTo(start + px);
      const k = cover();
      if (k !== key) { changes++; key = k; }
    }
    // Chaque reconstruction couvre une autre tranche ; il y en a moins que de changements de bloc (hystérésis).
    expect(new Set(h.ranges).size).toBe(h.ranges.length);
    expect(h.builds()).toBeGreaterThanOrEqual(3);
    expect(h.builds() - 1).toBeLessThan(changes);
    // Toujours couvert : le visible n'est jamais hors du modèle construit.
    const [from, to] = h.ranges.at(-1)!.split("..");
    expect(visibleRange(h.s.view()).from >= from! && visibleRange(h.s.view()).to <= to!).toBe(true);
  });

  it("saut hors du modèle : reconstruit dans la même image (pas de trou affiché)", () => {
    const h = setup();
    h.scrollTo(h.root.scrollLeft + 200 * DAY);
    expect(h.builds()).toBe(2);
    expect(h.root.querySelectorAll(".wn-block:not([style*='display: none'])").length).toBeGreaterThan(0);
  });

  it("long défilement simulé (horizontal et vertical) : le nombre de nœuds reste constant", () => {
    const h = setup();
    let x = h.root.scrollLeft;
    const run = (frames: number) => {
      for (let i = 0; i < frames; i++) { x += 120; h.scrollTo(x, (i * 7) % 1500); }
    };
    // Pools chauds. 400 images (200 avant la gouttière de 240 px) : avec la nouvelle gouttière, la position de la fenêtre
    // quantifiée (QUANTUM_PX) par rapport aux cellules met plus d'images à passer par toutes ses combinaisons ; il manquait
    // un nœud de cellule au bout de 200, jamais au-delà (les 1 200 images suivantes restent vérifiées à l'identique).
    run(400);
    const warm = h.s.stats();
    run(1200); // 1 500 jours : extensions de piste et dizaines de tranches
    const after = h.s.stats();
    expect(after.builds).toBeGreaterThan(warm.builds + 20);
    expect(after.nodes).toBe(warm.nodes);
    expect([after.rowsCreated, after.blocksCreated, after.cellsCreated]).toEqual([warm.rowsCreated, warm.blocksCreated, warm.cellsCreated]);
    expect(h.root.querySelectorAll("[role=row]").length).toBeLessThan(25);
  }, 20_000);
});

describe("source de données", () => {
  it("la vue visible (au plus toutes les 100 ms) alimente la source, qui précharge les blocs voisins", async () => {
    const queries: { from: string; to: string }[] = [];
    const base = uniform(2);
    const fetch = async (url: string): Promise<FetchResponse> => {
      const q = new URL(url, "http://x").searchParams;
      queries.push({ from: q.get("from")!, to: q.get("to")! });
      return { status: 200, json: async () => ({ ...base, allocations: [], window: { from: q.get("from"), to: q.get("to") } }) };
    };
    const source = createScheduleSource({ api: createClient({ baseUrl: "", fetch }) });
    const h = setup({ onViewChange: source.setViewport });
    source.start();
    await new Promise((r) => setTimeout(r, 0));
    const first = queries.length;
    expect(first).toBe(1);
    const start = h.root.scrollLeft;
    for (let i = 1; i <= 20; i++) h.scrollTo(start + i * 4 * DAY); // 80 jours en 20 images (320 ms)
    h.m.frame(200); // dernière vue (minuterie de fin de défilement)
    await new Promise((r) => setTimeout(r, 0));
    const r = visibleRange(h.s.view());
    expect(queries.length).toBeGreaterThan(first);
    expect(queries.length).toBeLessThan(first + 6); // blocs nouveaux seulement, pas une requête par image
    expect(queries.at(-1)!.to >= addDays(r.to, 28)).toBe(true); // voisin de droite préchargé
    const w = source.getState().data!.window; // snapshot : visible et voisins, pas seulement le visible
    expect(w.from <= addDays(r.from, -28) && w.to >= addDays(r.to, 28)).toBe(true);
    const data = source.getState().data;
    h.scrollTo(h.root.scrollLeft + 1);
    h.m.frame(200);
    expect(source.getState().data).toBe(data); // même tranche : même objet, pas de reconstruction
  });

  it("émission limitée : une vue par fenêtre de 100 ms pendant le défilement, la dernière position arrive", () => {
    const h = setup();
    const start = h.root.scrollLeft;
    for (let i = 1; i <= 30; i++) h.scrollTo(start + i * 10); // 480 ms
    h.m.frame(200);
    expect(h.views.length).toBeGreaterThan(3);
    expect(h.views.length).toBeLessThan(8);
    expect(h.views.at(-1)!.center).toBeCloseTo(h.s.view().center, 9);
  });
});

describe("navigation", () => {
  it("« Aujourd'hui » recentre par un défilement doux (positions intermédiaires), précédent / suivant d'une période", () => {
    const h = setup();
    h.s.setZoom("week");
    h.s.step(1);
    h.s.step(1); // deux clics rapides : cumulés
    for (let i = 0; i < 25; i++) h.m.frame();
    expect(h.center()).toBe(addDays(TODAY, 14));
    h.s.today();
    h.m.frame(100);
    const mid = h.s.view().center;
    expect(mid).toBeGreaterThan(dayNumber(TODAY) + 0.5);
    expect(mid).toBeLessThan(dayNumber(TODAY) + 14.5);
    for (let i = 0; i < 25; i++) h.m.frame();
    expect(h.s.view().center).toBeCloseTo(dayNumber(TODAY) + 0.5, 6);
    expect(h.m.pendingFrames()).toBe(0); // animation terminée : plus de rAF
  });

  it("mouvement réduit : saut immédiat ; molette pendant l'animation : l'utilisateur garde la main", () => {
    const h = setup({ reducedMotion: () => true });
    h.s.step(1);
    expect(h.center()).toBe(addDays(TODAY, 1));
    const g = setup();
    g.s.setZoom("month");
    g.s.step(1);
    g.m.frame(50);
    g.root.dispatchEvent(new Event("wheel"));
    const at = g.s.view().center;
    for (let i = 0; i < 25; i++) g.m.frame();
    expect(g.s.view().center).toBe(at);
  });

  it("zoom : la date au centre reste stable (aller-retour jour -> semaine -> mois -> jour)", () => {
    const h = setup();
    h.scrollTo(h.root.scrollLeft + 37 * DAY + 13);
    const c = h.s.view().center;
    const before = h.builds();
    for (const z of ["week", "month", "day"] as const) {
      h.s.setZoom(z);
      expect(h.s.zoom()).toBe(z);
      expect(h.s.view().center).toBeCloseTo(c, 6);
      expect(h.views.at(-1)!.zoom).toBe(z);
    }
    h.s.setZoom("day"); // même zoom : rien
    expect(h.builds()).toBe(before + 3); // une reconstruction par changement de zoom
  });

  it("écran 4K (3840 px) en zoom mois : plus de 400 jours visibles, aucun plantage, modèle borné à 400 jours", () => {
    const h = setup({ widthPx: 3840 });
    expect(() => h.s.setZoom("month")).not.toThrow();
    const m = h.s.host.model()!;
    expect(m).not.toBeNull();
    expect(dayNumber(m.to) - dayNumber(m.from) + 1).toBeLessThanOrEqual(400);
    expect(m.from < TODAY && m.to > TODAY).toBe(true);
    // Défilement au pixel sur moins d'un bloc : pas de reconstruction à chaque image.
    const before = h.builds();
    const start = h.root.scrollLeft;
    for (let px = 8; px <= 20 * 8; px += 8) h.scrollTo(start + px);
    expect(h.builds()).toBe(before);
    expect(() => h.scrollTo(start + 200 * 8)).not.toThrow();
  });

  it("date du jour mise à jour sans recréer le scroller : « Aujourd'hui » va au nouveau jour, la position est gardée", () => {
    const h = setup({ reducedMotion: () => true });
    h.scrollTo(h.root.scrollLeft + 5 * DAY);
    const sl = h.root.scrollLeft;
    h.s.setToday(addDays(TODAY, 1));
    expect(h.root.scrollLeft).toBe(sl);
    h.s.today();
    h.m.frame();
    expect(h.center()).toBe(addDays(TODAY, 1));
  });

  it("libellés changés (locale) sans recréer le scroller : en-têtes réécrits, position gardée", () => {
    const h = setup();
    h.scrollTo(h.root.scrollLeft + 3 * DAY);
    const sl = h.root.scrollLeft;
    h.s.setLabels({ label: (c) => `x${c.from}` });
    h.m.frame();
    expect(h.root.scrollLeft).toBe(sl);
    const first = h.root.querySelector("[role=columnheader][data-from]")!;
    expect(first.textContent).toBe(`x${first.getAttribute("data-from")}`);
  });

  it("clavier : flèches = une unité d'en-tête ; redimensionnement : centre conservé", () => {
    const h = setup();
    h.s.nudge(1);
    h.m.frame();
    expect(h.center()).toBe(addDays(TODAY, 1));
    h.s.setZoom("week");
    h.s.nudge(-1);
    h.m.frame();
    expect(h.center()).toBe(addDays(TODAY, -6));
    const c = h.s.view().center;
    h.s.resize(GUTTER_PX + 600, 300);
    expect(h.s.view().widthPx).toBe(600);
    expect(h.s.view().center).toBeCloseTo(c, 6);
  });

  it("nouvelles données : modèle reconstruit et redessiné ; destroy vide le conteneur et coupe les rAF", () => {
    const h = setup();
    h.s.setData({ ...uniform(3) });
    expect([...h.root.querySelectorAll("[role=rowheader] .wn-person-name")].filter((e) => e.textContent).length).toBe(3);
    h.scrollTo(h.root.scrollLeft + 10);
    h.root.dispatchEvent(new Event("scroll"));
    h.s.destroy();
    expect(h.root.childElementCount).toBe(0);
    expect(h.m.pendingFrames()).toBe(0);
  });
});

describe("revealPerson (palette de recherche, RT-038)", () => {
  const rowOf = (h: ReturnType<typeof setup>, id: string) => h.root.querySelector<HTMLElement>(`.wn-row[data-person="${id}"]`);

  it("personne lointaine : le défilement vertical l'amène dans la vue, sa ligne est dessinée et mise en évidence", () => {
    const h = setup();
    expect(rowOf(h, "55")).toBeNull();
    expect(h.s.revealPerson("55")).toBe(true);
    const row = h.s.host.model()!.rows.find((r) => r.personId === "55")!;
    // La ligne est entièrement sous l'en-tête de dates et dans la fenêtre.
    expect(h.root.scrollTop).toBeLessThanOrEqual(row.top);
    expect(h.root.scrollTop + 480).toBeGreaterThanOrEqual(HEADER_PX + row.top + row.heightPx);
    const el = rowOf(h, "55");
    expect(el).not.toBeNull();
    expect(el!.hasAttribute("data-highlight")).toBe(true);
    expect(h.root.querySelectorAll(".wn-row[data-highlight]")).toHaveLength(1);
  });

  it("le défilement horizontal ne bouge pas, la mise en évidence s'éteint seule", () => {
    const h = setup();
    const left = h.root.scrollLeft;
    h.s.revealPerson("40");
    expect(h.root.scrollLeft).toBe(left);
    h.m.frame(HIGHLIGHT_MS + 50);
    expect(h.root.querySelectorAll(".wn-row[data-highlight]")).toHaveLength(0);
  });

  it("ligne déjà visible : la vue ne bouge pas, la ligne est quand même mise en évidence", () => {
    const h = setup();
    expect(h.s.revealPerson("2")).toBe(true);
    expect(h.root.scrollTop).toBe(0);
    expect(rowOf(h, "2")!.hasAttribute("data-highlight")).toBe(true);
  });

  it("personne absente du modèle (écartée par les filtres) : false, rien ne bouge ni ne s'allume", () => {
    const h = setup();
    expect(h.s.revealPerson("999")).toBe(false);
    expect(h.root.scrollTop).toBe(0);
    expect(h.root.querySelectorAll(".wn-row[data-highlight]")).toHaveLength(0);
  });

  it("une deuxième recherche déplace la mise en évidence ; recycler la ligne ne la laisse pas sur une autre personne", () => {
    const h = setup();
    h.s.revealPerson("55");
    h.s.revealPerson("3");
    const lit = [...h.root.querySelectorAll<HTMLElement>(".wn-row[data-highlight]")].map((e) => e.dataset.person);
    expect(lit).toEqual(["3"]);
    h.scrollTo(h.root.scrollLeft, 1500);
    for (const e of h.root.querySelectorAll<HTMLElement>(".wn-row[data-highlight]")) expect(e.dataset.person).toBe("3");
  });
});
