// Routeur minimal sur l'History API : chemins, requête conservée, popstate, pas d'entrée d'historique en double.
import { describe, expect, it, vi } from "vitest";
import { createRouter, hrefOf, pathOf, routeOf, ROUTE_IDS } from "../src/shell/router";

const apply = (url: string) => { const [p, q = ""] = url.split("?"); env0.location.pathname = p!; env0.location.search = q ? `?${q}` : ""; };
let env0: ReturnType<typeof fakeEnv>;
function fakeEnv(path = "/", search = "") {
  const env = {
    location: { pathname: path, search },
    pushed: [] as string[],
    replaced: [] as string[],
    history: {
      pushState: (_s: unknown, _u: string, url: string) => { env.pushed.push(url); apply(url); },
      replaceState: (_s: unknown, _u: string, url: string) => { env.replaced.push(url); apply(url); },
    },
    pop: () => {},
    onPopState: (fn: () => void) => { env.pop = fn; return () => {}; },
  };
  env0 = env;
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

describe("paramètres propres à une page (?projet=, RT-038)", () => {
  it("navigate avec paramètres : ajoutés à la requête courante, lus par param(), notifie même sur la page courante", () => {
    const env = fakeEnv("/", "?demo=1&lang=en");
    const router = createRouter(env);
    const seen = vi.fn();
    router.subscribe(seen);
    router.navigate("projects", { projet: "p 7" });
    expect(env.pushed).toEqual(["/projets?demo=1&lang=en&projet=p+7"]);
    expect(router.param("projet")).toBe("p 7");
    expect(router.param("absent")).toBeNull();
    expect(seen).toHaveBeenCalledTimes(1);
    router.navigate("projects", { projet: "8" });
    expect(env.pushed.at(-1)).toBe("/projets?demo=1&lang=en&projet=8");
    expect(seen).toHaveBeenCalledTimes(2);
  });

  it("le paramètre ne suit pas vers une autre page, ni dans les liens", () => {
    const env = fakeEnv("/projets", "?demo=1&projet=7");
    const router = createRouter(env);
    expect(router.href("people")).toBe("/personnes?demo=1");
    router.navigate("planning");
    expect(env.pushed).toEqual(["/?demo=1"]);
    expect(router.param("projet")).toBeNull();
  });

  it("clearParam : retire le paramètre par replaceState (pas d'entrée d'historique, pas de notification)", () => {
    const env = fakeEnv("/projets", "?demo=1&projet=7");
    const router = createRouter(env);
    const seen = vi.fn();
    router.subscribe(seen);
    router.clearParam("projet");
    expect(env.replaced).toEqual(["/projets?demo=1"]);
    expect(env.pushed).toEqual([]);
    expect(seen).not.toHaveBeenCalled();
    router.clearParam("projet");
    expect(env.replaced).toHaveLength(1);
  });
});
