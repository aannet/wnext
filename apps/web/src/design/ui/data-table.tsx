// DataTable (RT-053, ADR-010) : le gabarit unique des listes Projets, Personnes et Clients. Barre d'outils (recherche, filtres,
// action primaire), en-têtes triables (aria-sort, actionnables au clavier), colonne d'actions « … » à droite (menu de
// dropdown-menu.tsx, action destructive en dernier avec confirmation), regroupement optionnel (RT-031) et deux états vides :
// liste vide (avec son action) ou résultat filtré vide (avec « Réinitialiser »). Lignes de 40 px, en-têtes 12 px graisse 500.
// Le composant ne connaît ni les filtres ni les droits : l'écran filtre ses lignes, ne fournit que les actions permises
// (`actions` renvoie [] pour qui ne peut rien faire ; sans aucune action, la colonne disparaît) et passe ses libellés (i18n).
// Tri : côté client. Contrôlé (`sort` + `onSortChange`, l'écran trie ses lignes) ou interne (`compare` sur la colonne).
import { cn } from "cn";
import { useId, useMemo, useRef, useState, type ReactNode } from "react";
import { Button } from "../Button";
import { Modal } from "../Modal";
import { buttonVariants } from "./button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "./dropdown-menu";

export type SortDir = "asc" | "desc";
export interface TableSort { key: string; dir: SortDir }

export interface DataTableColumn<T> {
  id: string;
  header: string;
  cell(row: T): ReactNode;
  /** Colonne triable : comparateur croissant (mode interne) ; en mode contrôlé, `sortable` suffit. */
  compare?(a: T, b: T): number;
  sortable?: boolean;
  /** Cellule d'en-tête de ligne (<th scope="row">) : le nom, qui porte le bouton d'ouverture. */
  rowHeader?: boolean;
}

export interface ConfirmCopy {
  title: string;
  body?: string;
  confirm: string;
  cancel: string;
  closeLabel: string;
}

export interface RowAction<T> {
  id: string;
  label: string;
  /** Reçoit la ligne et le déclencheur du menu (retour du focus par l'écran). */
  onSelect(row: T, trigger: HTMLElement | null): void | Promise<void>;
  /** Action destructive : rangée en dernier, en rouge, et soumise à `confirm`. */
  destructive?: boolean;
  confirm?: ConfirmCopy;
}

export interface DataTableGroup<T> { key: string; label: string; rows: readonly T[] }

export interface DataTableProps<T> {
  rows: readonly T[];
  /** Groupes (RT-031) : remplacent `rows` pour l'affichage. */
  groups?: readonly DataTableGroup<T>[];
  rowKey(row: T): string;
  columns: readonly DataTableColumn<T>[];
  /** Légende (masquée) du tableau. */
  caption: string;
  /** Nombre de lignes avant filtrage : 0 = liste vide, sinon un filtre vide la liste. */
  totalCount: number;
  search?: { value: string; onChange(v: string): void; label: string };
  /** Emplacement des filtres (puces ou sélecteurs), dans la barre d'outils. */
  filters?: ReactNode;
  /** Action primaire de la barre d'outils (à droite) : « Nouveau … ». */
  primaryAction?: ReactNode;
  /** Libellé de la barre d'outils (rôle search). */
  toolbarLabel: string;
  actions?(row: T): readonly RowAction<T>[];
  actionsHeader?: string;
  actionsLabel?(row: T): string;
  isCurrent?(row: T): boolean;
  sort?: TableSort;
  onSortChange?(sort: TableSort): void;
  defaultSort?: TableSort;
  empty: { title: string; body: string; action?: ReactNode };
  emptyFiltered: { title: string; body: string; resetLabel: string; onReset(): void };
  className?: string;
}

const collator = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });
export const compareText = (a: string, b: string) => collator.compare(a, b);

function Dots() {
  return <svg aria-hidden="true" viewBox="0 0 16 16" width="16" height="16" fill="currentColor"><circle cx="3" cy="8" r="1.25" /><circle cx="8" cy="8" r="1.25" /><circle cx="13" cy="8" r="1.25" /></svg>;
}

export function DataTable<T>(props: DataTableProps<T>) {
  const { rows, groups, rowKey, columns, caption, totalCount, search, filters, primaryAction, toolbarLabel, actions, actionsHeader = "", actionsLabel, isCurrent, empty, emptyFiltered, className } = props;
  const emptyId = useId();
  const wrapper = useRef<HTMLDivElement | null>(null);
  const [inner, setInner] = useState<TableSort | null>(props.defaultSort ?? null);
  const sort = props.sort ?? inner;
  const [confirming, setConfirming] = useState<{ row: T; action: RowAction<T>; trigger: HTMLElement | null } | null>(null);
  const [busy, setBusy] = useState(false);

  function sortBy(col: DataTableColumn<T>) {
    const next: TableSort = sort?.key === col.id ? { key: col.id, dir: sort.dir === "asc" ? "desc" : "asc" } : { key: col.id, dir: "asc" };
    if (props.onSortChange) props.onSortChange(next);
    if (!props.sort) setInner(next);
  }
  const sorter = useMemo(() => {
    const col = props.sort ? null : columns.find((c) => c.id === sort?.key);
    if (!col?.compare || !sort) return null;
    const sign = sort.dir === "asc" ? 1 : -1;
    return (a: T, b: T) => sign * col.compare!(a, b);
  }, [columns, sort, props.sort]);
  const order = (list: readonly T[]) => (sorter ? [...list].sort(sorter) : list);

  const shownGroups: readonly DataTableGroup<T>[] | null = groups ? groups.map((g) => ({ ...g, rows: order(g.rows) })) : null;
  const flat = shownGroups ? shownGroups.flatMap((g) => g.rows) : order(rows);
  const hasActions = !!actions && flat.some((r) => actions(r).length > 0);
  const colSpan = columns.length + (hasActions ? 1 : 0);

  // Le focus ne doit jamais tomber sur <body> : retour au menu de la ligne, sinon à la zone du tableau (ligne supprimée).
  function restoreFocus(key: string, trigger: HTMLElement | null) {
    requestAnimationFrame(() => {
      if (document.activeElement && document.activeElement !== document.body && !document.activeElement.matches("[data-dt-guard]")) return;
      const own = wrapper.current?.querySelector<HTMLElement>(`[data-row-actions="${CSS.escape(key)}"]`);
      const next = own ?? (trigger?.isConnected ? trigger : null) ?? wrapper.current?.querySelector<HTMLElement>("[data-row-actions]");
      (next ?? wrapper.current)?.focus();
    });
  }

  async function run(row: T, action: RowAction<T>, trigger: HTMLElement | null) {
    // Sans confirmation, l'action ouvre sa propre fenêtre ou son champ (drawer, renommage) qui prend le focus.
    await action.onSelect(row, trigger);
  }
  function choose(row: T, action: RowAction<T>, trigger: HTMLElement | null) {
    if (action.confirm) setConfirming({ row, action, trigger });
    else void run(row, action, trigger);
  }
  async function confirmed() {
    if (!confirming) return;
    setBusy(true);
    try { await confirming.action.onSelect(confirming.row, confirming.trigger); } finally { setBusy(false); }
    const { row, trigger } = confirming;
    setConfirming(null);
    restoreFocus(rowKey(row), trigger);
  }

  function cells(row: T) {
    return columns.map((c) => (c.rowHeader
      ? <th key={c.id} scope="row" className="font-normal">{c.cell(row)}</th>
      : <td key={c.id}>{c.cell(row)}</td>));
  }
  function rowActions(row: T) {
    const list = actions?.(row) ?? [];
    const ordered = [...list.filter((a) => !a.destructive), ...list.filter((a) => a.destructive)];
    if (ordered.length === 0) return <td className="wn-dt-actions" />;
    const key = rowKey(row);
    return (
      <td className="wn-dt-actions">
        <DropdownMenu>
          <DropdownMenuTrigger data-row-actions={key} aria-label={actionsLabel?.(row) ?? actionsHeader} className={buttonVariants({ variant: "ghost", size: "icon" })}>
            <Dots />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-[160px]">
            {ordered.map((a, i) => (
              <DropdownMenuItem key={a.id} className={cn(a.destructive && "text-danger-text", a.destructive && i > 0 && "border-t border-solid border-border")}
                onClick={(e) => choose(row, a, wrapper.current?.querySelector<HTMLElement>(`[data-row-actions="${CSS.escape(key)}"]`) ?? (e.currentTarget as HTMLElement))}>
                {a.label}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </td>
    );
  }
  function bodyRow(row: T) {
    const current = isCurrent?.(row);
    return <tr key={rowKey(row)} data-current={current || undefined}>{cells(row)}{hasActions && rowActions(row)}</tr>;
  }

  const isEmpty = flat.length === 0;
  return (
    <div ref={wrapper} tabIndex={-1} data-dt-guard className={cn("wn-datatable outline-none", className)}>
      <div className="wn-dt-toolbar" role="search" aria-label={toolbarLabel}>
        {search && <input type="search" className="wn-dt-search" value={search.value} aria-label={search.label} placeholder={search.label} autoComplete="off" onChange={(e) => search.onChange(e.target.value)} />}
        {filters && <div className="wn-dt-filters">{filters}</div>}
        {primaryAction && <div className="wn-dt-primary">{primaryAction}</div>}
      </div>

      {isEmpty ? (
        <section className="wn-soon wn-empty" aria-labelledby={emptyId}>
          {totalCount > 0 ? (
            <>
              <h2 id={emptyId}>{emptyFiltered.title}</h2>
              <p>{emptyFiltered.body}</p>
              <Button type="button" onClick={emptyFiltered.onReset}>{emptyFiltered.resetLabel}</Button>
            </>
          ) : (
            <>
              <h2 id={emptyId}>{empty.title}</h2>
              {empty.body && <p>{empty.body}</p>}
              {empty.action}
            </>
          )}
        </section>
      ) : (
        <table className="wn-table wn-dt">
          <caption className="wn-visually-hidden">{caption}</caption>
          <thead>
            <tr>
              {columns.map((c) => {
                const sortable = c.sortable ?? !!c.compare;
                const active = sortable && sort?.key === c.id;
                return (
                  <th key={c.id} scope="col" aria-sort={active ? (sort!.dir === "asc" ? "ascending" : "descending") : undefined}>
                    {sortable ? <button type="button" className="wn-sort" onClick={() => sortBy(c)}>{c.header}</button> : c.header}
                  </th>
                );
              })}
              {hasActions && <th scope="col" className="wn-dt-actions"><span className="wn-visually-hidden">{actionsHeader}</span></th>}
            </tr>
          </thead>
          {shownGroups
            ? shownGroups.map((g) => (
              <tbody key={g.key}>
                <tr className="wn-group-row"><th scope="rowgroup" colSpan={colSpan}>{g.label}</th></tr>
                {g.rows.map(bodyRow)}
              </tbody>
            ))
            : <tbody>{flat.map(bodyRow)}</tbody>}
        </table>
      )}

      {confirming?.action.confirm && (
        <Modal title={confirming.action.confirm.title} closeLabel={confirming.action.confirm.closeLabel} busy={busy}
          onClose={() => { const c = confirming; setConfirming(null); restoreFocus(rowKey(c.row), c.trigger); }}
          footer={<>
            <Button onClick={() => { const c = confirming; setConfirming(null); restoreFocus(rowKey(c.row), c.trigger); }}>{confirming.action.confirm.cancel}</Button>
            <Button variant="danger" autoFocus disabled={busy} onClick={() => void confirmed()}>{confirming.action.confirm.confirm}</Button>
          </>}>
          {confirming.action.confirm.body && <p>{confirming.action.confirm.body}</p>}
        </Modal>
      )}
    </div>
  );
}
