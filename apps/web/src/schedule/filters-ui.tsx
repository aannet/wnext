// Filtres du Schedule dans l'en-tête (recette n°2, L-J : RT-025) : bouton « Filtres » avec compteur qui déplie un panneau sous
// la barre d'outils (aria-expanded, aria-controls), une puce par filtre actif, retirable d'un clic. Les filtres sont portés par
// l'écran (lignes filtrées côté client, schedule/view-filters) et enregistrés par les vues (views-ui).
import type { I18n } from "@lingui/core";
import type { ScheduleResponse } from "@wnext/contracts";
import { useId } from "react";
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

export function FiltersButton({ i18n, filters, expanded, controls, onToggle }: Pick<Props, "i18n" | "filters"> & { expanded: boolean; controls: string; onToggle(): void }) {
  const count = activeFilterCount(filters);
  return (
    <Button type="button" aria-expanded={expanded} aria-controls={controls} onClick={onToggle}>
      {count ? i18n._("views.filters.count", { count }) : i18n._("views.filters")}
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

export function FiltersPanel({ i18n, data, filters, onFilters, id }: Props & { id: string }) {
  const uid = useId();
  const t = (k: MessageKey) => i18n._(k);
  const count = activeFilterCount(filters);
  return (
    <div id={id} role="group" aria-label={t("views.filters")} className="wn-filters wn-filters-panel">
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
  );
}
