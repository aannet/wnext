// Recherche globale (recette n°4, D5 : RT-059, rouvre RT-038). Le bouton « Rechercher » et sa pastille de raccourci vivent dans
// l'en-tête commun (shell/app-header), juste avant la cloche ; la palette (schedule/search-ui) est montée par la coque, et Ctrl+K
// (⌘K sur Mac) l'ouvre sur tous les écrans.
//  * Le Planning, quand il est monté, s'inscrit comme cible (`useSearchTarget`) : ses personnes (avec celles masquées par les
//    filtres), ses projets, et son choix (révéler la ligne, retirer les filtres après confirmation : comportement de RT-038).
//  * Hors du Planning, les listes viennent de ce que l'app charge déjà (`searchSources` : personnes actives de GET /people,
//    projets non archivés du catalogue), relues à chaque ouverture ; choisir une personne ouvre le Planning sur sa ligne
//    (`openPerson`, ?personne=), un projet ouvre sa fiche (`openProject`). Aucune nouvelle route.
//  * Raccourci (shell/shortcuts « search ») ignoré dans une autre fenêtre modale, dans une zone de texte (textarea,
//    contenteditable) et quand l'événement est déjà traité ; un champ simple, lui, ouvre la palette.
//  * Le choix est transmis après la fermeture de la fenêtre (le focus rendu par la fenêtre ne reprend pas celui de la cible) ;
//    fermée sans choix, le focus ne reste pas perdu sur le corps de la page : il revient au bouton.
import type { I18n } from "@lingui/core";
import type { PersonDetail, ProjectDetail } from "@wnext/contracts";
import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { Button } from "../design";
import { SearchPalette, searchShortcutLabel } from "../schedule/search-ui";
import type { SearchItem, SearchPerson, SearchProject } from "../schedule/search-model";
import { matches, shortcut } from "./shortcuts";

type Listed<T> = Promise<{ ok: true; value: T } | { ok: false; error: unknown }>;

/** Ce que le Planning fournit tant qu'il est monté. */
export interface SearchTarget {
  people: readonly SearchPerson[];
  hiddenIds: ReadonlySet<string>;
  /** Projets proposés ; absent : pas de groupe Projets. */
  projects?: readonly SearchProject[];
  listProjects?(): Promise<{ id: string; name: string }[]>;
  onPick(item: SearchItem): void;
}

/** Listes et destinations hors du Planning. */
export interface SearchSources {
  listPeople?(): Promise<SearchPerson[]>;
  listProjects?(): Promise<{ id: string; name: string; color?: string | null }[]>;
  openPerson?(personId: string): void;
  openProject?(projectId: string): void;
}

/** Sources de la palette à partir des listes de l'app (personnes actives, projets non archivés). */
export function searchSources(o: {
  people: { listPeople(): Listed<readonly Pick<PersonDetail, "id" | "name" | "active">[]> };
  projects: { listProjects(): Listed<readonly Pick<ProjectDetail, "id" | "name" | "color" | "status">[]> };
  openPerson(id: string): void;
  openProject(id: string): void;
}): SearchSources {
  return {
    listPeople: async () => { const r = await o.people.listPeople(); return r.ok ? r.value.filter((p) => p.active).map((p) => ({ id: p.id, name: p.name })) : []; },
    listProjects: async () => {
      const r = await o.projects.listProjects();
      return r.ok ? r.value.filter((p) => p.status !== "archived").map((p) => ({ id: p.id, name: p.name, color: p.color ?? null })) : [];
    },
    openPerson: o.openPerson,
    openProject: o.openProject,
  };
}

interface SearchContextValue {
  open(): void;
  register(target: RefObject<SearchTarget | null>): () => void;
  button: RefObject<HTMLButtonElement | null>;
}
const SearchContext = createContext<SearchContextValue | null>(null);

/** Cible où Ctrl+K garde son sens d'édition (zone de texte multiligne, contenteditable). */
function inTextArea(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  return t.isContentEditable || t.closest('textarea, [contenteditable]:not([contenteditable="false"])') !== null;
}

const EMPTY: ReadonlySet<string> = new Set();

export function SearchProvider({ i18n, sources = {}, children }: { i18n: I18n; sources?: SearchSources; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const openRef = useRef(false);
  openRef.current = open;
  const target = useRef<RefObject<SearchTarget | null> | null>(null);
  const button = useRef<HTMLButtonElement | null>(null);
  const picked = useRef<{ item: SearchItem; target: SearchTarget | null } | null>(null);
  /** Personnes hors du Planning, relues à chaque ouverture. */
  const [people, setPeople] = useState<SearchPerson[]>([]);
  const sourcesRef = useRef(sources);
  sourcesRef.current = sources;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!matches("search", e)) return;
      if (openRef.current) { e.preventDefault(); return; }
      // Événement déjà traité, ou zone de texte où la touche sert à l'édition (un champ simple, lui, ouvre la palette).
      if (e.defaultPrevented || inTextArea(e.target)) return;
      // Une autre fenêtre modale (pop-in, import, confirmation) garde le clavier ; un menu ancré (aria-modal=false) ne le garde pas.
      if (document.querySelector('[role="dialog"]:not([aria-modal="false"]), [role="alertdialog"]')) return;
      e.preventDefault();
      setOpen(true);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const current = target.current?.current ?? null;
  useEffect(() => {
    if (!open || current) return;
    let alive = true;
    void sourcesRef.current.listPeople?.().then((l) => { if (alive) setPeople(l); }, () => {});
    return () => { alive = false; };
  }, [open]);

  // Fenêtre refermée : le choix est transmis (à la cible inscrite, sinon aux destinations) ; sans choix, focus au bouton.
  const wasOpen = useRef(false);
  useEffect(() => {
    if (open || !wasOpen.current) { wasOpen.current = open; return; }
    wasOpen.current = false;
    const p = picked.current;
    picked.current = null;
    if (p) {
      if (p.target) p.target.onPick(p.item);
      else if (p.item.kind === "person") sourcesRef.current.openPerson?.(p.item.id);
      else sourcesRef.current.openProject?.(p.item.id);
      return;
    }
    if (document.activeElement === document.body && button.current?.isConnected) button.current.focus({ preventScroll: true });
  }, [open]);

  const value = useMemo<SearchContextValue>(() => ({
    open: () => setOpen(true),
    register: (t) => { target.current = t; return () => { if (target.current === t) target.current = null; }; },
    button,
  }), []);
  const s = sourcesRef.current;
  return (
    <SearchContext.Provider value={value}>
      {children}
      {open && (current
        ? <SearchPalette i18n={i18n} people={current.people} hiddenIds={current.hiddenIds} onClose={() => setOpen(false)}
            onPick={(item) => { picked.current = { item, target: current }; setOpen(false); }}
            {...(current.projects ? { projects: current.projects, ...(current.listProjects ? { listProjects: current.listProjects } : s.listProjects ? { listProjects: s.listProjects } : {}) } : {})} />
        : <SearchPalette i18n={i18n} people={people} hiddenIds={EMPTY} onClose={() => setOpen(false)}
            onPick={(item) => { picked.current = { item, target: null }; setOpen(false); }}
            {...(s.listProjects && s.openProject ? { projects: [], listProjects: s.listProjects } : {})} />)}
    </SearchContext.Provider>
  );
}

/** Bouton « Rechercher » de l'en-tête commun, avec la pastille du raccourci ; rien hors d'un SearchProvider. */
export function SearchButton({ i18n }: { i18n: I18n }) {
  const ctx = useContext(SearchContext);
  if (!ctx) return null;
  return (
    <Button ref={ctx.button} type="button" aria-haspopup="dialog" aria-keyshortcuts={shortcut("search").aria} onClick={ctx.open}>
      {i18n._("schedule.search.open")}
      <kbd data-shortcut="" className="rounded-sm border border-solid border-input bg-muted px-1 font-[inherit] text-caption text-muted-foreground">{searchShortcutLabel()}</kbd>
    </Button>
  );
}

/** Inscrit l'écran comme cible de la palette tant qu'il est monté (dernière valeur lue à l'ouverture). */
export function useSearchTarget(target: SearchTarget): void {
  const ctx = useContext(SearchContext);
  const ref = useRef<SearchTarget | null>(target);
  ref.current = target;
  useEffect(() => ctx?.register(ref), [ctx]);
}
