// Écran Personnes (lot L-F2 : RT-012 partie Personnes, US-1.1, US-5.1, BR-19, BR-31). Une liste filtrable (recherche, équipe =
// département, rôle, type, actives ou désactivées), une fiche dans le Drawer commun, la création réduite (nom, type, horaire par
// défaut). L'import CSV vit dans Réglages > Import (RT-054) : l'état vide y mène (owner, admin). Lecture seule pour member et
// guest (GET /me). Un member ne reçoit que sa
// personne liée (RT-048) ; sans personne liée, un état vide le dit.
// Tri et regroupement (RT-031), côté client et en mémoire : en-têtes Nom, Rôle et Équipe triables (aria-sort, second clic =
// sens inverse), interrupteur « Regrouper par équipe » (un tbody par équipe, « Sans équipe » en dernier). RT-053 : la liste est
// le DataTable commun (barre d'outils, menu d'actions « … » par ligne) ; le tri reste celui de people-model (contrôlé).
// Colonne « Accès » (RT-040, ADR-002 §1 : users distincts de people) : `access` de PersonDetail, servi par l'API aux seuls
// owner, admin et project_manager ; la colonne n'apparaît que si le champ est présent. « Invitation envoyée » viendra en T2.
import type { I18n } from "@lingui/core";
import type { Me } from "@wnext/contracts";
import { todayIn } from "@wnext/engine";
import { useEffect, useMemo, useRef, useState } from "react";
import type { PeopleSource, Person, ReferenceSource } from "../data/people-source";
import { Button, DataTable, Drawer, Switch, type DataTableColumn } from "../design";
import type { MessageKey } from "../i18n";
import { ImportSettingsLink, type ImportLink } from "../imports/import-link";
import { useLoad } from "../projects/use-load";
import { accessKey, DEFAULT_PEOPLE_SORT, filterPeople, groupPeople, initialsOf, sortPeople, type PeopleSort, type PeopleSortKey, NONE, NO_PEOPLE_FILTERS, PEOPLE_TYPES, refName, TYPE_KEY, errorOf, newPersonValues, parseWeek, weeklySummary, type PeopleFilters, type StateFilter } from "./people-model";
import { PersonForm } from "./person-form";
import { PersonPanel } from "./person-panel";

export interface PeopleScreenProps {
  i18n: I18n;
  source: PeopleSource;
  reference: ReferenceSource;
  account: Me["account"];
  canEdit: boolean;
  /** Lien vers Réglages > Import dans l'état vide (owner, admin) ; absent : pas de lien. */
  importLink?: ImportLink;
  /** member (RT-048) : l'API ne sert que sa personne liée ; sans personne, un état vide explique ce périmètre. */
  ownOnly?: boolean;
  now?: () => Date;
}

type Side = { kind: "none" } | { kind: "create" } | { kind: "person"; id: string };

export function PeopleScreen({ i18n, source, reference, account, canEdit, importLink, ownOnly = false, now = () => new Date() }: PeopleScreenProps) {
  const t = (k: MessageKey, v?: Record<string, unknown>) => i18n._(k, v);
  const people = useLoad(() => source.listPeople(), "people");
  const departments = useLoad(() => reference.departments.list(), "departments");
  const roles = useLoad(() => reference.roles.list(), "roles");
  const [filters, setFilters] = useState<PeopleFilters>(NO_PEOPLE_FILTERS);
  const [sort, setSort] = useState<PeopleSort>(DEFAULT_PEOPLE_SORT);
  const [grouped, setGrouped] = useState(false);
  const [side, setSide] = useState<Side>({ kind: "none" });
  const trigger = useRef<HTMLElement | null>(null);
  const today = useMemo(() => todayIn(account.timezone, now()), [account.timezone, now]);

  const ready = people.state.status === "ready" && departments.state.status === "ready" && roles.state.status === "ready";
  const all = people.state.status === "ready" ? people.state.data : [];
  const deptList = departments.state.status === "ready" ? departments.state.data : [];
  const roleList = roles.state.status === "ready" ? roles.state.data : [];
  const shown = useMemo(() => sortPeople(filterPeople(all, filters), sort, deptList, roleList), [all, filters, sort, deptList, roleList]);
  const showAccess = all.some((x) => x.access !== undefined);
  const groups = useMemo(() => (grouped ? groupPeople(shown, deptList) : [{ id: null, name: null, people: shown }]), [grouped, shown, deptList]);
  const selected = side.kind === "person" ? all.find((x) => x.id === side.id) : undefined;
  useEffect(() => { if (side.kind === "person" && ready && !selected) setSide({ kind: "none" }); }, [side, ready, selected]);

  const open = (next: Side, el: HTMLElement | null) => { trigger.current = el; setSide(next); };
  const close = () => {
    setSide({ kind: "none" });
    requestAnimationFrame(() => { if (document.activeElement === document.body && trigger.current?.isConnected) trigger.current.focus(); });
  };
  const upsert = (x: Person) => people.update((d) => (d.some((y) => y.id === x.id) ? d.map((y) => (y.id === x.id ? x : y)) : [...d, x]));

  const fmt = (k: MessageKey) => t(k);
  const columns: DataTableColumn<Person>[] = [
    {
      id: "name", header: t("people.col.name"), rowHeader: true, sortable: true,
      cell: (x) => (
        <Button variant="link" aria-expanded={side.kind === "person" && side.id === x.id} onClick={(e) => open({ kind: "person", id: x.id }, e.currentTarget)}>
          <span className="wn-avatar" aria-hidden="true">{initialsOf(x.name)}</span>
          {x.name}
          {!x.active && <span className="wn-tag">{t("people.inactive")}</span>}
        </Button>
      ),
    },
    { id: "role", header: t("people.col.role"), sortable: true, cell: (x) => refName(roleList, x.roleId) },
    { id: "department", header: t("people.col.team"), sortable: true, cell: (x) => refName(deptList, x.departmentId) },
    { id: "type", header: t("people.col.type"), cell: (x) => t(TYPE_KEY[x.peopleType]) },
    { id: "hours", header: t("people.col.hours"), cell: (x) => { const { total, days } = weeklySummary(x.workDaysHours); return t("people.hours.summary", { hours: total, days }); } },
    ...(showAccess ? [{
      id: "access", header: t("people.col.access"), sortable: true,
      cell: (x: Person) => x.access && <span className={x.access === "member" ? "wn-tag" : "wn-muted"}>{t(accessKey(x.access))}</span>,
    }] : []),
  ];
  return (
    <main className="wn-page wn-people">
      <div className="wn-subheader">
        <h1 tabIndex={-1} className="wn-subheader-title">{t("shell.nav.people")}</h1>
      </div>

      {(people.state.status === "loading" || departments.state.status === "loading" || roles.state.status === "loading") && <p className="wn-muted" role="status">{t("people.loading")}</p>}
      {(people.state.status === "error" || departments.state.status === "error" || roles.state.status === "error") && (
        <p role="alert" className="wn-error">{t("people.error.load")} <Button size="sm" type="button" onClick={() => { people.reload(); departments.reload(); roles.reload(); }}>{t("people.retry")}</Button></p>
      )}

      {ready && ownOnly && all.length === 0 && (
        <section className="wn-soon wn-empty" aria-labelledby="wn-pempty-title">
          <h2 id="wn-pempty-title">{t("access.own.title")}</h2>
          <p>{t("access.own.body")}</p>
        </section>
      )}
      {ready && !(ownOnly && all.length === 0) && (
        <DataTable<Person>
          rows={shown} groups={grouped ? groups.map((g) => ({ key: g.id ?? "none", label: t("people.group.heading", { name: g.name ?? t("people.group.none"), count: g.people.length }), rows: g.people })) : undefined}
          totalCount={all.length} rowKey={(x) => x.id} columns={columns} caption={t("people.table.caption", { count: shown.length })}
          toolbarLabel={t("people.filters.label")}
          search={{ value: filters.search, onChange: (v) => setFilters({ ...filters, search: v }), label: t("people.filters.search") }}
          filters={<>
            <div className="wn-field">
              <label htmlFor="wn-pf-team">{t("people.filters.team")}</label>
              <select id="wn-pf-team" value={filters.departmentId} onChange={(e) => setFilters({ ...filters, departmentId: e.target.value })}>
                <option value="">{fmt("people.filters.all")}</option>
                <option value={NONE}>{fmt("people.filters.none")}</option>
                {deptList.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
              </select>
            </div>
            <div className="wn-field">
              <label htmlFor="wn-pf-role">{t("people.filters.role")}</label>
              <select id="wn-pf-role" value={filters.roleId} onChange={(e) => setFilters({ ...filters, roleId: e.target.value })}>
                <option value="">{fmt("people.filters.all")}</option>
                <option value={NONE}>{fmt("people.filters.none")}</option>
                {roleList.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
              </select>
            </div>
            <div className="wn-field">
              <label htmlFor="wn-pf-type">{t("people.filters.type")}</label>
              <select id="wn-pf-type" value={filters.type} onChange={(e) => setFilters({ ...filters, type: e.target.value as PeopleFilters["type"] })}>
                <option value="">{fmt("people.filters.all")}</option>
                {PEOPLE_TYPES.map((x) => <option key={x} value={x}>{t(TYPE_KEY[x])}</option>)}
              </select>
            </div>
            <div className="wn-field">
              <label htmlFor="wn-pf-state">{t("people.filters.state")}</label>
              <select id="wn-pf-state" value={filters.state} onChange={(e) => setFilters({ ...filters, state: e.target.value as StateFilter })}>
                <option value="active">{fmt("people.filters.state.active")}</option>
                <option value="inactive">{fmt("people.filters.state.inactive")}</option>
                <option value="all">{fmt("people.filters.state.all")}</option>
              </select>
            </div>
            <Switch checked={grouped} onCheckedChange={setGrouped} className="wn-filters-switch">{t("people.group.department")}</Switch>
          </>}
          primaryAction={canEdit ? <Button type="button" variant="primary" onClick={(e) => open({ kind: "create" }, e.currentTarget)}>{t("people.new")}</Button> : undefined}
          sort={sort} onSortChange={(next) => setSort(next as PeopleSort)}
          isCurrent={(x) => side.kind === "person" && side.id === x.id}
          actions={(x) => (canEdit ? [{ id: "edit", label: t("table.edit"), onSelect: (_row, el) => open({ kind: "person", id: x.id }, el) }] : [])}
          actionsHeader={t("table.actions.header")} actionsLabel={(x) => t("table.actions.for", { name: x.name })}
          empty={{ title: t("people.empty.title"), body: t("people.empty.body"), ...(canEdit || importLink ? { action: <>
            {canEdit && <Button type="button" variant="primary" onClick={(e) => open({ kind: "create" }, e.currentTarget)}>{t("people.new")}</Button>}
            {importLink && <ImportSettingsLink i18n={i18n} link={importLink} />}
          </> } : {}) }}
          emptyFiltered={{ title: t("people.empty.filtered.title"), body: t("people.empty.filtered.body"), resetLabel: t("people.filters.reset"), onReset: () => setFilters(NO_PEOPLE_FILTERS) }}
        />
      )}

      {ready && side.kind === "create" && (
        <CreatePanel i18n={i18n} source={source} departments={deptList} roles={roleList} weekStart={account.weekStart} today={today} onClose={close}
          onCreated={(x) => { upsert(x); setSide({ kind: "person", id: x.id }); }} />
      )}
      {ready && selected && (
        <PersonPanel i18n={i18n} source={source} person={selected} people={all} departments={deptList} roles={roleList} weekStart={account.weekStart}
          today={today} canEdit={canEdit} onUpdated={upsert} onClose={close} />
      )}
    </main>
  );
}

interface CreateProps {
  i18n: I18n;
  source: PeopleSource;
  departments: Parameters<typeof PersonForm>[0]["departments"];
  roles: Parameters<typeof PersonForm>[0]["roles"];
  weekStart: number;
  today: string;
  onClose(): void;
  onCreated(p: Person): void;
}

/** Création réduite (US-1.1) : nom, type, horaire ; équipe, rôle et pays facultatifs et repliés. */
function CreatePanel({ i18n, source, departments, roles, weekStart, today, onClose, onCreated }: CreateProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<ReturnType<typeof newPersonValues> | null>(null);
  const [formKey, setFormKey] = useState(0);
  const initial = useMemo(() => draft ?? newPersonValues(), [draft]);
  const [dirty, setDirty] = useState(false);
  return (
    <Drawer title={i18n._("people.create.title")} closeLabel={i18n._("dialog.close")} onClose={onClose} busy={busy} className="wn-person-panel"
      unsaved={{ dirty, title: i18n._("dialog.discard.title"), keep: i18n._("dialog.discard.keep"), discard: i18n._("dialog.discard.discard") }}>
      <PersonForm key={formKey} i18n={i18n} mode="create" initial={initial} departments={departments} roles={roles} weekStart={weekStart} today={today}
        busy={busy} submitError={error} onCancel={onClose} onDirtyChange={setDirty}
        onSubmit={(v) => {
          void (async () => {
            setBusy(true); setError(null);
            const hours = parseWeek(v.hours) ?? [];
            const r = await source.createPerson({
              name: v.name.trim(), peopleType: v.peopleType, workDaysHours: hours,
              ...(v.departmentId ? { departmentId: v.departmentId } : {}), ...(v.roleId ? { roleId: v.roleId } : {}), ...(v.country.trim() ? { country: v.country.trim().toUpperCase() } : {}),
            });
            setBusy(false);
            if (r.ok) { onCreated(r.value); return; }
            const m = errorOf(r.error);
            setError(i18n._(m.key, m.values));
            setDraft(v); setFormKey((n) => n + 1);
          })();
        }} />
    </Drawer>
  );
}
