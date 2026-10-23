// Filtres du Schedule dans l'en-tête (recette n°2, L-J : RT-025) : bouton « Filtres » avec compteur qui déplie un panneau sous
// la barre d'outils (aria-expanded, aria-controls), une puce par filtre actif, retirable d'un clic. Les filtres sont portés par
// l'écran (lignes filtrées côté client, schedule/view-filters) et enregistrés par les vues (views-ui).
// RT-058 (D6) : les vues sauvegardées vivent dans ce panneau, « Vue » en tête (`header`), les filtres, puis les actions
// d'enregistrement en pied (`footer`) ; le bouton affiche le nom de la vue active (« Filtres · Studio », ● si modifiée, annoncé
// « vue modifiée »).
import type { I18n } from "@lingui/core";
import type { ScheduleResponse } from "@wnext/contracts";
import { useId, type ReactNode } from "react";
import { Button } from "../design";
import type { MessageKey } from "../i18n";
import { activeFilterCount, type ViewFilters } from "./view-filters";

type ListKey = "departmentIds" | "roleIds" | "projectIds" | "personIds";
const LISTS: readonly { key: ListKey; label: MessageKey; options(d: ScheduleResponse): ReadonlyArray<{ id: string; name: string }> }[] = [
  { key: "departmentIds", label: "views.filter.department", options: (d) => d.departments },
  { key: "roleIds", label: "views.filter.role", options: (d) => d.roles },
  { key: "projectIds", label: "views.filter.project", options: (d) => d.projects },
  { key: "personIds", label: "views.filter.person", options: (d) => d.people },
];

interface Props { i18n: I18n; data: ScheduleResponse; filters: ViewFilters; onFilters(f: ViewFilters): void }

export function FiltersButton({ i18n, filters, expanded, controls, onToggle, view }: Pick<Props, "i18n" | "filters"> & {
  expanded: boolean; controls: string; onToggle(): void;
  /** Vue sauvegardée active : son nom suit le libellé, ● si elle est modifiée. */
  view?: { name: string; modified: boolean } | null;
}) {
  const count = activeFilterCount(filters);
  return (
    <Button type="button" aria-expanded={expanded} aria-controls={controls} onClick={onToggle}>
      {count ? i18n._("views.filters.count", { count }) : i18n._("views.filters")}
      {view && (
        <span className="wn-filters-view">
          {" · "}{view.name}
          {view.modified && <>{" "}<span aria-hidden="true" className="wn-filters-modified">●</span>{" "}<span className="wn-visually-hidden">{i18n._("views.filters.modified")}</span></>}
        </span>
      )}
    </Button>
  );
}

/** Une puce par filtre actif : « Département : Design, Produit », bouton × qui retire ce filtre. */
export function FilterChips({ i18n, data, filters, onFilters }: Props) {
  const chips = LISTS.flatMap(({ key, label, options }) => {
    const ids = filters[key];
    if (!ids || ids.length === 0) return [];
    const names = new Map(options(data).map((o) => [o.id, o.name]));
    const text = i18n._("views.filter.chip", { label: i18n._(label), values: ids.map((id) => names.get(id) ?? id).join(", ") });
    const remove = i18n._("views.filter.chip.remove", { label: i18n._(label), values: ids.map((id) => names.get(id) ?? id).join(", ") });
    return [{ key, text, remove }];
  });
  if (chips.length === 0) return null;
  return (
    <ul className="wn-chips">
      {chips.map((c) => (
        <li key={c.key} className="wn-chip">
          <span>{c.text}</span>
          <button type="button" className="wn-chip-remove" aria-label={c.remove} title={c.remove} onClick={() => onFilters({ ...filters, [c.key]: [] })}>
            <svg aria-hidden="true" viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><path d="M4 4l8 8M12 4l-8 8" /></svg>
          </button>
        </li>
      ))}
    </ul>
  );
}

export function FiltersPanel({ i18n, data, filters, onFilters, id, header, footer }: Props & { id: string; header?: ReactNode; footer?: ReactNode }) {
  const uid = useId();
  const t = (k: MessageKey) => i18n._(k);
  const count = activeFilterCount(filters);
  return (
    <div id={id} role="group" aria-label={t("views.filters")} className="wn-filters-panel">
      {header}
      <div className="wn-filters">
      {LISTS.map(({ key, label, options }) => (
        <div key={key} className="wn-filter">
          <span id={`${uid}-${key}`}>{t(label)}</span>
          <select multiple size={4} aria-labelledby={`${uid}-${key}`} value={filters[key] ?? []}
            onChange={(e) => onFilters({ ...filters, [key]: [...e.currentTarget.selectedOptions].map((o) => o.value) })}>
            {options(data).map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
          </select>
        </div>
      ))}
      <div className="wn-filter">
        <span id={`${uid}-sort`}>{t("views.sort.label")}</span>
        <select aria-labelledby={`${uid}-sort`} value={filters.peopleSort ?? "name"} onChange={(e) => onFilters({ ...filters, peopleSort: e.currentTarget.value as ViewFilters["peopleSort"] })}>
          {(["name", "department", "role"] as const).map((s) => <option key={s} value={s}>{t(`views.sort.${s}`)}</option>)}
        </select>
      </div>
      <Button type="button" disabled={count === 0 && !filters.peopleSort} onClick={() => onFilters({})}>{t("views.reset")}</Button>
      </div>
      {footer}
    </div>
  );
}
