// Routeur minimal sur l'History API : chemins, requête conservée, popstate, pas d'entrée d'historique en double.
import { describe, expect, it, vi } from "vitest";
import { createRouter, hrefOf, pathOf, routeOf, ROUTE_IDS } from "../src/shell/router";

function fakeEnv(path = "/", search = "") {
  const env = {
    location: { pathname: path, search },
    pushed: [] as string[],
    history: { pushState: (_s: unknown, _u: string, url: string) => { env.pushed.push(url); const [p, q = ""] = url.split("?"); env.location.pathname = p!; env.location.search = q ? `?${q}` : ""; } },
    pop: () => {},
    onPopState: (fn: () => void) => { env.pop = fn; return () => {}; },
  };
  return env;
}

describe("routeOf / hrefOf", () => {
  it("quatre pages, un chemin chacune ; barre finale tolérée ; inconnu = null", () => {
    expect(ROUTE_IDS.map(pathOf)).toEqual(["/", "/projets", "/personnes", "/reglages"]);
    expect(["/", "", "/projets", "/projets/", "/personnes", "/reglages//"].map(routeOf)).toEqual(["planning", "planning", "projects", "projects", "people", "settings"]);
    expect(["/inconnu", "/projets/12", "/Projets"].map(routeOf)).toEqual([null, null, null]);
    expect(hrefOf("people", "?lang=en")).toBe("/personnes?lang=en");
  });
});

describe("createRouter", () => {
  it("navigate : pushState avec la requête courante, notifie, route courante à jour", () => {
    const env = fakeEnv("/", "?demo=1&lang=en");
    const router = createRouter(env);
    const seen = vi.fn();
    router.subscribe(seen);
    router.navigate("projects");
    expect(env.pushed).toEqual(["/projets?demo=1&lang=en"]);
    expect(router.current()).toBe("projects");
    expect(seen).toHaveBeenCalledTimes(1);
    router.navigate("planning");
    expect(env.pushed.at(-1)).toBe("/?demo=1&lang=en");
    expect(router.current()).toBe("planning");
  });

  it("aller sur la page courante : ni entrée d'historique ni notification", () => {
    const env = fakeEnv("/personnes");
    const router = createRouter(env);
    const seen = vi.fn();
    router.subscribe(seen);
    router.navigate("people");
    expect(env.pushed).toEqual([]);
    expect(seen).not.toHaveBeenCalled();
  });

  it("popstate (précédent / suivant) : abonnés notifiés, route relue dans l'adresse", () => {
    const env = fakeEnv("/projets");
    const router = createRouter(env);
    const seen = vi.fn();
    const off = router.subscribe(seen);
    env.location.pathname = "/";
    env.pop();
    expect(seen).toHaveBeenCalledTimes(1);
    expect(router.current()).toBe("planning");
    off();
    env.pop();
    expect(seen).toHaveBeenCalledTimes(1);
  });

  it("href garde la requête (lien copiable, ouverture dans un nouvel onglet)", () => {
    expect(createRouter(fakeEnv("/", "?lang=en")).href("settings")).toBe("/reglages?lang=en");
  });
});
