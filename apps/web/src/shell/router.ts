// Routeur minimal sur l'History API (pas de bibliothèque) : quatre pages, un chemin chacune. La requête (?lang=, ?demo=1) est
// conservée d'une page à l'autre ; l'ancre est abandonnée. Précédent / suivant du navigateur : événement popstate.
// Logique pure et testable : l'environnement (location, history, popstate) est injecté.

export type RouteId = "planning" | "projects" | "people" | "settings";
export const ROUTE_IDS: readonly RouteId[] = ["planning", "projects", "people", "settings"];

const PATHS: Record<RouteId, string> = { planning: "/", projects: "/projets", people: "/personnes", settings: "/reglages" };

/** Page d'un chemin (barre finale tolérée), null si inconnu. */
export function routeOf(pathname: string): RouteId | null {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  return ROUTE_IDS.find((id) => PATHS[id] === (path === "" ? "/" : path)) ?? null;
}

export function pathOf(id: RouteId): string {
  return PATHS[id];
}

/** Adresse relative d'une page, requête comprise. */
export function hrefOf(id: RouteId, search = ""): string {
  return PATHS[id] + search;
}

export interface RouterEnv {
  location: { pathname: string; search: string };
  history: { pushState(state: unknown, unused: string, url: string): void };
  /** Abonne au retour en arrière / en avant du navigateur ; rend le désabonnement. */
  onPopState(fn: () => void): () => void;
}

export interface Router {
  /** Page courante ; null : chemin inconnu. */
  current(): RouteId | null;
  /** Va à une page (nouvelle entrée d'historique) ; sans effet si c'est déjà la page courante. */
  navigate(id: RouteId): void;
  subscribe(fn: () => void): () => void;
  /** Adresse d'une page avec la requête courante (pour les liens). */
  href(id: RouteId): string;
}

export function createRouter(env: RouterEnv): Router {
  const listeners = new Set<() => void>();
  const notify = () => listeners.forEach((fn) => fn());
  env.onPopState(notify);
  return {
    current: () => routeOf(env.location.pathname),
    href: (id) => hrefOf(id, env.location.search),
    navigate(id) {
      if (routeOf(env.location.pathname) === id) return;
      env.history.pushState({}, "", hrefOf(id, env.location.search));
      notify();
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => void listeners.delete(fn);
    },
  };
}

export function browserRouter(): Router {
  return createRouter({
    location: globalThis.location,
    history: globalThis.history,
    onPopState: (fn) => {
      globalThis.addEventListener("popstate", fn);
      return () => globalThis.removeEventListener("popstate", fn);
    },
  });
}
