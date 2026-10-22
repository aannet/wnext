// Écran Personnes (lot L-F2 : RT-012 partie Personnes, US-1.1, US-5.1, BR-19, BR-31). Une liste filtrable (recherche, équipe =
// département, rôle, type, actives ou désactivées), une fiche dans le Drawer commun, la création réduite (nom, type, horaire par
// défaut), et l'accès à l'import CSV pour owner et admin. Lecture seule pour member et guest (GET /me).
// Tri et regroupement (RT-031), côté client et en mémoire : en-têtes Nom, Rôle et Équipe triables (aria-sort, second clic =
// sens inverse), interrupteur « Regrouper par équipe » (un tbody par équipe, « Sans équipe » en dernier).
// Colonne « accès » (ADR-002 §1 : users distincts de people) : le contrat ne dit pas quelle personne a un compte de connexion
// (GET /people n'expose ni e-mail ni lien vers un utilisateur) ; elle sera ajoutée quand la route existera.
import type { I18n } from "@lingui/core";
import type { Me } from "@wnext/contracts";
import { todayIn } from "@wnext/engine";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ImportSource } from "../data/import-source";
import type { PeopleSource, Person, ReferenceSource } from "../data/people-source";
import { Button, Drawer, Switch } from "../design";
import type { MessageKey } from "../i18n";
import { ImportDialog } from "../imports/import-dialog";
import { useLoad } from "../projects/use-load";
import { DEFAULT_PEOPLE_SORT, filterPeople, groupPeople, initialsOf, sortPeople, type PeopleSort, type PeopleSortKey, NONE, NO_PEOPLE_FILTERS, PEOPLE_TYPES, refName, TYPE_KEY, errorOf, newPersonValues, parseWeek, weeklySummary, type PeopleFilters, type StateFilter } from "./people-model";
import { PersonForm } from "./person-form";
import { PersonPanel } from "./person-panel";

export interface PeopleScreenProps {
  i18n: I18n;
  source: PeopleSource;
  reference: ReferenceSource;
  account: Me["account"];
  canEdit: boolean;
  /** Import CSV (owner, admin) ; absent : pas de bouton. */
  imports?: ImportSource;
  now?: () => Date;
}

type Side = { kind: "none" } | { kind: "create" } | { kind: "person"; id: string };

export function PeopleScreen({ i18n, source, reference, account, canEdit, imports, now = () => new Date() }: PeopleScreenProps) {
  const t = (k: MessageKey, v?: Record<string, unknown>) => i18n._(k, v);
  const people = useLoad(() => source.listPeople(), "people");
  const departments = useLoad(() => reference.departments.list(), "departments");
  const roles = useLoad(() => reference.roles.list(), "roles");
  const [filters, setFilters] = useState<PeopleFilters>(NO_PEOPLE_FILTERS);
  const [sort, setSort] = useState<PeopleSort>(DEFAULT_PEOPLE_SORT);
  const [grouped, setGrouped] = useState(false);
  const [side, setSide] = useState<Side>({ kind: "none" });
  const [importing, setImporting] = useState(false);
  const trigger = useRef<HTMLElement | null>(null);
  const today = useMemo(() => todayIn(account.timezone, now()), [account.timezone, now]);

  const ready = people.state.status === "ready" && departments.state.status === "ready" && roles.state.status === "ready";
  const all = people.state.status === "ready" ? people.state.data : [];
  const deptList = departments.state.status === "ready" ? departments.state.data : [];
  const roleList = roles.state.status === "ready" ? roles.state.data : [];
  const shown = useMemo(() => sortPeople(filterPeople(all, filters), sort, deptList, roleList), [all, filters, sort, deptList, roleList]);
  const groups = useMemo(() => (grouped ? groupPeople(shown, deptList) : [{ id: null, name: null, people: shown }]), [grouped, shown, deptList]);
  const sortBy = (key: PeopleSortKey) => setSort((s) => (s.key === key ? { key, dir: s.dir === "asc" ? "desc" : "asc" } : { key, dir: "asc" }));
  const sortable = (key: PeopleSortKey, label: MessageKey) => (
    <th scope="col" aria-sort={sort.key === key ? (sort.dir === "asc" ? "ascending" : "descending") : undefined}>
      <button type="button" className="wn-sort" onClick={() => sortBy(key)}>{t(label)}</button>
    </th>
  );
  const selected = side.kind === "person" ? all.find((x) => x.id === side.id) : undefined;
  useEffect(() => { if (side.kind === "person" && ready && !selected) setSide({ kind: "none" }); }, [side, ready, selected]);

  const open = (next: Side, el: HTMLElement | null) => { trigger.current = el; setSide(next); };
  const close = () => {
    setSide({ kind: "none" });
    requestAnimationFrame(() => { if (document.activeElement === document.body && trigger.current?.isConnected) trigger.current.focus(); });
  };
  const upsert = (x: Person) => people.update((d) => (d.some((y) => y.id === x.id) ? d.map((y) => (y.id === x.id ? x : y)) : [...d, x]));

  const fmt = (k: MessageKey) => t(k);
  return (
    <main className="wn-page wn-people">
      <div className="wn-subheader">
        <h1 tabIndex={-1} className="wn-subheader-title">{t("shell.nav.people")}</h1>
        {imports && <Button type="button" aria-haspopup="dialog" onClick={(e) => { trigger.current = e.currentTarget; setImporting(true); }}>{t("import.open")}</Button>}
        {canEdit && <Button type="button" variant="primary" onClick={(e) => open({ kind: "create" }, e.currentTarget)}>{t("people.new")}</Button>}
      </div>
      {imports && importing && <ImportDialog i18n={i18n} source={imports} onClose={() => { setImporting(false); people.reload(); }} />}

      {(people.state.status === "loading" || departments.state.status === "loading" || roles.state.status === "loading") && <p className="wn-muted" role="status">{t("people.loading")}</p>}
      {(people.state.status === "error" || departments.state.status === "error" || roles.state.status === "error") && (
        <p role="alert" className="wn-error">{t("people.error.load")} <Button size="sm" type="button" onClick={() => { people.reload(); departments.reload(); roles.reload(); }}>{t("people.retry")}</Button></p>
      )}

      {ready && (
        <>
          <form className="wn-filters" role="search" aria-label={t("people.filters.label")} onSubmit={(e) => e.preventDefault()}>
            <div className="wn-field">
              <label htmlFor="wn-pf-search">{t("people.filters.search")}</label>
              <input id="wn-pf-search" type="search" value={filters.search} autoComplete="off" onChange={(e) => setFilters({ ...filters, search: e.target.value })} />
            </div>
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
          </form>

          {shown.length === 0 ? (
            <section className="wn-soon wn-empty" aria-labelledby="wn-pempty-title">
              <h2 id="wn-pempty-title">{t(all.length > 0 ? "people.empty.filtered.title" : "people.empty.title")}</h2>
              <p>{t(all.length > 0 ? "people.empty.filtered.body" : "people.empty.body")}</p>
              {all.length > 0
                ? <Button type="button" onClick={() => setFilters(NO_PEOPLE_FILTERS)}>{t("people.filters.reset")}</Button>
                : canEdit && <Button type="button" variant="primary" onClick={(e) => open({ kind: "create" }, e.currentTarget)}>{t("people.new")}</Button>}
            </section>
          ) : (
            <table className="wn-table">
              <caption className="wn-visually-hidden">{t("people.table.caption", { count: shown.length })}</caption>
              <thead>
                <tr>
                  {sortable("name", "people.col.name")}
                  {sortable("role", "people.col.role")}
                  {sortable("department", "people.col.team")}
                  <th scope="col">{t("people.col.type")}</th>
                  <th scope="col">{t("people.col.hours")}</th>
                </tr>
              </thead>
              {groups.map((g) => (
              <tbody key={g.id ?? "none"}>
                {grouped && (
                  <tr className="wn-group-row">
                    <th scope="rowgroup" colSpan={5}>{t("people.group.heading", { name: g.name ?? t("people.group.none"), count: g.people.length })}</th>
                  </tr>
                )}
                {g.people.map((x) => {
                  const current = side.kind === "person" && side.id === x.id;
                  const { total, days } = weeklySummary(x.workDaysHours);
                  return (
                    <tr key={x.id} data-current={current || undefined}>
                      <th scope="row">
                        <Button variant="link" aria-expanded={current} onClick={(e) => open({ kind: "person", id: x.id }, e.currentTarget)}>
                          <span className="wn-avatar" aria-hidden="true">{initialsOf(x.name)}</span>
                          {x.name}
                          {!x.active && <span className="wn-tag">{t("people.inactive")}</span>}
                        </Button>
                      </th>
                      <td>{refName(roleList, x.roleId)}</td>
                      <td>{refName(deptList, x.departmentId)}</td>
                      <td>{t(TYPE_KEY[x.peopleType])}</td>
                      <td>{t("people.hours.summary", { hours: total, days })}</td>
                    </tr>
                  );
                })}
              </tbody>
              ))}
            </table>
          )}
        </>
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
