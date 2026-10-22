// Palette de recherche du Planning (RT-038, Ctrl+K ou ⌘K, bouton « Rechercher » du niveau 1 de l'en-tête) : une fenêtre modale
// (design/Modal) avec un champ et, dessous, les résultats groupés « Personnes » / « Projets ». Elle ne fait que chercher et
// rendre le choix (`onPick`) : défiler jusqu'à la personne ou ouvrir la fiche du projet est l'affaire de l'écran.
//  * Autocomplete de Base UI en mode `inline` (liste dans la fenêtre, sans portail : un portail masquerait la page aux lecteurs
//    d'écran, axe) et `mode="none"` : la liste est filtrée ici (search-model), le champ garde ce qui est tapé. Flèches haut / bas,
//    Entrée ou clic choisissent ; Échap ferme la fenêtre et rend le focus (Dialog).
//  * Listes déjà chargées : personnes de la réponse du Planning, projets du compte (`listProjects`, relus à l'ouverture), le
//    temps de les lire ceux de la réponse. Sans `onPick` projet possible (`projects` absent), le groupe Projets n'existe pas.
//  * Personne masquée par les filtres : l'option le dit ; la choisir ouvre une confirmation dans la fenêtre (« Retirer les filtres et
//    afficher <nom> » / Annuler, focus sur la confirmation, Échap revient à la liste). `onPick` n'est appelé qu'après confirmation :
//    la palette ne touche jamais aux filtres d'elle-même.
//  * Sans résultat : le champ n'annonce plus de liste (aria-expanded=false) et « Aucun résultat » est écrit dans une région de statut
//    présente dès l'ouverture (un texte inséré avec sa région n'est pas toujours annoncé).
//  * Rien n'est enregistré : ni dans les vues sauvegardées ni dans l'adresse.
import type { I18n } from "@lingui/core";
import { Autocomplete } from "@base-ui/react/autocomplete";
import { useEffect, useMemo, useState } from "react";
import { Button, Modal } from "../design";
import type { MessageKey } from "../i18n";
import { searchEntries, type SearchItem, type SearchPerson, type SearchProject } from "./search-model";

export interface SearchPaletteProps {
  i18n: I18n;
  people: readonly SearchPerson[];
  /** Personnes qui ne sont pas dans les lignes affichées (filtres actifs). */
  hiddenIds: ReadonlySet<string>;
  /** Projets de la réponse du Planning ; absent : pas de groupe Projets. */
  projects?: readonly SearchProject[];
  /** Tous les projets du compte ; absent ou en échec : ceux de `projects`. */
  listProjects?(): Promise<{ id: string; name: string }[]>;
  onPick(item: SearchItem): void;
  onClose(): void;
}

/** Raccourci affiché sur le bouton : ⌘K sur Mac, Ctrl K ailleurs (noms de touches, hors catalogue, comme les pastilles de touches). */
export function searchShortcutLabel(platform = globalThis.navigator?.platform ?? ""): string {
  return /mac|iphone|ipad/i.test(platform) ? "⌘K" : "Ctrl K";
}

/** Ctrl+K ou ⌘K, sans Alt ni Maj. */
export function isSearchShortcut(e: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey">): boolean {
  return (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "k";
}

export function SearchPalette({ i18n, people, hiddenIds, projects, listProjects, onPick, onClose }: SearchPaletteProps) {
  const t = (k: MessageKey) => i18n._(k);
  const [query, setQuery] = useState("");
  const [all, setAll] = useState<{ id: string; name: string }[] | null>(null);
  useEffect(() => {
    if (!projects || !listProjects) return;
    let alive = true;
    listProjects().then((l) => { if (alive) setAll(l); }, () => {});
    return () => { alive = false; };
  }, []);
  const known = useMemo<SearchProject[]>(() => {
    if (!projects) return [];
    const color = new Map(projects.map((p) => [p.id, p.color]));
    const byId = new Map<string, SearchProject>((all ?? []).map((p) => [p.id, { id: p.id, name: p.name, color: color.get(p.id) ?? null }]));
    for (const p of projects) if (!byId.has(p.id)) byId.set(p.id, p);
    return [...byId.values()];
  }, [projects, all]);
  const groups = useMemo(() => searchEntries({ people, projects: known, hiddenIds, query }).map((g) => ({ value: g.kind, items: g.items })), [people, known, hiddenIds, query]);
  const none = groups.length === 0;
  /** Personne masquée choisie, en attente de confirmation. */
  const [confirming, setConfirming] = useState<Extract<SearchItem, { kind: "person" }> | null>(null);
  const choose = (item: SearchItem) => { if (item.kind === "person" && item.hidden) setConfirming(item); else onPick(item); };

  return (
    <Modal title={t("schedule.search.title")} closeLabel={t("schedule.search.close")} onClose={onClose} className="wn-search"
      {...(confirming ? {
        onEscape: () => setConfirming(null),
        footer: (
          <>
            <Button type="button" onClick={() => setConfirming(null)}>{t("schedule.search.confirm.cancel")}</Button>
            <Button type="button" variant="primary" autoFocus onClick={() => onPick(confirming)}>{i18n._("schedule.search.confirm.action", { name: confirming.name })}</Button>
          </>
        ),
      } : {})}>
      {confirming ? <p className="m-0">{i18n._("schedule.search.confirm.text", { name: confirming.name })}</p> : (<>
        <Autocomplete.Root
          inline items={groups} mode="none" autoHighlight="always" value={query} open itemToStringValue={(i: SearchItem) => i.key}
          onValueChange={(v, details) => { if (details.reason === "input-change") setQuery(v); }}
        >
          <Autocomplete.Input
            aria-label={t("schedule.search.input")} aria-expanded={!none} autoFocus placeholder={t("schedule.search.placeholder")} autoComplete="off" spellCheck={false} data-autofocus=""
            // Échap remonte à la fenêtre (qui se ferme) au lieu de vider le champ.
            onKeyDown={(e) => { if (e.key === "Escape") (e as typeof e & { preventBaseUIHandler(): void }).preventBaseUIHandler(); }}
          />
          {!none && (
            <Autocomplete.List aria-label={t("schedule.search.results")} className="m-0 mt-2 max-h-[min(20rem,50vh)] list-none overflow-auto p-0 outline-none">
              {(group: { value: "people" | "projects"; items: SearchItem[] }) => (
                <Autocomplete.Group key={group.value} items={group.items}>
                  <Autocomplete.GroupLabel className="px-2 pt-2 pb-1 text-label font-semibold text-muted-foreground">
                    {t(group.value === "people" ? "schedule.search.people" : "schedule.search.projects")}
                  </Autocomplete.GroupLabel>
                  <Autocomplete.Collection>
                    {(item: SearchItem) => (
                      <Autocomplete.Item key={item.key} value={item} onClick={() => choose(item)}
                        className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 outline-none select-none data-highlighted:bg-(--focus) data-highlighted:text-(--color-on-focus)">
                        {item.kind === "project" && item.color && <span aria-hidden="true" className="size-2.5 flex-none rounded-full" style={{ background: item.color }} />}
                        <span className="min-w-0 flex-1 truncate">{item.name}</span>
                        {item.kind === "person" && item.hidden && <span className="flex-none text-label opacity-80">{t("schedule.search.hidden")}</span>}
                      </Autocomplete.Item>
                    )}
                  </Autocomplete.Collection>
                </Autocomplete.Group>
              )}
            </Autocomplete.List>
          )}
        </Autocomplete.Root>
        <p role="status" className="m-0 mt-3 text-muted-foreground empty:hidden">{none ? t("schedule.search.empty") : ""}</p>
      </>)}
    </Modal>
  );
}
