// Chargement d'une liste de l'écran Projets : état (chargement, prêt, erreur), rechargement et mise à jour locale après écriture.
import { useCallback, useEffect, useRef, useState } from "react";
import type { ProjectsResult } from "../data/projects-source";

export type Loaded<T> =
  | { status: "loading" }
  | { status: "error" }
  | { status: "ready"; data: T };

export function useLoad<T>(load: () => Promise<ProjectsResult<T>>, key: string): { state: Loaded<T>; reload(): void; update(fn: (data: T) => T): void } {
  const [state, setState] = useState<Loaded<T>>({ status: "loading" });
  const [tick, setTick] = useState(0);
  const loader = useRef(load);
  loader.current = load;
  useEffect(() => {
    let live = true;
    setState((s) => (s.status === "ready" ? s : { status: "loading" }));
    loader.current().then(
      (r) => { if (live) setState(r.ok ? { status: "ready", data: r.value } : { status: "error" }); },
      () => { if (live) setState({ status: "error" }); },
    );
    return () => { live = false; };
  }, [key, tick]);
  const reload = useCallback(() => { setState({ status: "loading" }); setTick((n) => n + 1); }, []);
  const update = useCallback((fn: (data: T) => T) => setState((s) => (s.status === "ready" ? { status: "ready", data: fn(s.data) } : s)), []);
  return { state, reload, update };
}
