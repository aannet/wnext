// Routeur minimal sur l'History API (pas de bibliothèque) : quatre pages, un chemin chacune. La requête (?lang=, ?demo=1) est
// conservée d'une page à l'autre (sauf les paramètres propres à une page, PAGE_PARAMS) ; l'ancre est abandonnée. Précédent / suivant du navigateur : événement popstate.
// Logique pure et testable : l'environnement (location, history, popstate) est injecté.

export type RouteId = "planning" | "projects" | "people" | "settings";
export const ROUTE_IDS: readonly RouteId[] = ["planning", "projects", "people", "settings"];

const PATHS: Record<RouteId, string> = { planning: "/", projects: "/projets", people: "/personnes", settings: "/reglages" };

/** Paramètres de requête qui n'ont de sens que sur la page où ils sont posés (?projet= : fiche à ouvrir ; ?personne= : ligne du
 *  Planning à révéler, RT-059 ; ?onglet= : onglet de Réglages, RT-054) : jamais reportés ailleurs. */
export const PAGE_PARAMS: readonly string[] = ["projet", "personne", "onglet"];

/** Requête sans les paramètres propres à une page, puis avec `params` ; inchangée (même texte) s'il n'y a rien à faire. */
export function carriedSearch(search: string, params: Readonly<Record<string, string>> = {}): string {
  const q = new URLSearchParams(search);
  const extra = Object.entries(params);
  if (extra.length === 0 && !PAGE_PARAMS.some((k) => q.has(k))) return search;
  for (const k of PAGE_PARAMS) q.delete(k);
  for (const [k, v] of extra) q.set(k, v);
  const out = q.toString();
  return out ? `?${out}` : "";
}

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
  history: { pushState(state: unknown, unused: string, url: string): void; replaceState(state: unknown, unused: string, url: string): void };
  /** Abonne au retour en arrière / en avant du navigateur ; rend le désabonnement. */
  onPopState(fn: () => void): () => void;
}

export interface Router {
  /** Page courante ; null : chemin inconnu. */
  current(): RouteId | null;
  /** Va à une page (nouvelle entrée d'historique), avec des paramètres propres à la page ; sans effet si c'est déjà la page courante et sans paramètre. */
  navigate(id: RouteId, params?: Readonly<Record<string, string>>): void;
  /** Valeur d'un paramètre de la requête courante, null s'il est absent. */
  param(name: string): string | null;
  /** Retire un paramètre de la requête courante sans entrée d'historique ni notification (fiche ouverte : l'adresse ne la rouvrirait plus). */
  clearParam(name: string): void;
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
    href: (id) => hrefOf(id, carriedSearch(env.location.search)),
    navigate(id, params) {
      if (routeOf(env.location.pathname) === id && !params) return;
      env.history.pushState({}, "", hrefOf(id, carriedSearch(env.location.search, params)));
      notify();
    },
    param: (name) => new URLSearchParams(env.location.search).get(name),
    clearParam(name) {
      const q = new URLSearchParams(env.location.search);
      if (!q.has(name)) return;
      q.delete(name);
      const out = q.toString();
      env.history.replaceState({}, "", env.location.pathname + (out ? `?${out}` : ""));
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
