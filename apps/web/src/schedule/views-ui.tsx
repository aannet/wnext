// Barre des vues sauvegardées du Schedule (FR-10) : choisir une vue (par défaut « Tout le monde »), filtrer les lignes
// (département, rôle, projet, personne, tri), enregistrer la vue courante (nom, partagée ou non), la mettre à jour, la
// renommer, la supprimer. L'état courant se reflète dans l'URL (?view=<id>, remplacé sans empiler l'historique).
//  * Les filtres sont portés par l'écran (lignes filtrées côté client, schedule/view-filters) ; la barre les édite et les lit.
//  * Une vue enregistre les filtres ET le zoom au moment de l'enregistrement ; l'appliquer remet les deux.
//  * Seules les vues que l'appelant peut gérer (`canManage`) offrent mise à jour, renommage et suppression.
//  * Erreurs : codes stables de l'API, traduits ici ; sur VERSION_CONFLICT la vue est relue. Annonces dans une région role=status.
import type { I18n } from "@lingui/core";
import type { SavedView, ScheduleResponse } from "@wnext/contracts";
import type { Zoom } from "@wnext/engine";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import type { ViewsErrorCode, ViewsResult, ViewsSource } from "../data/views-source";
import { Button, Modal } from "../design";
import type { MessageKey } from "../i18n";
import { activeFilterCount, normalizeFilters, sameFilters, type ViewFilters } from "./view-filters";

export interface ViewsBarProps {
  i18n: I18n;
  /** Données complètes (non filtrées) : listes de choix. */
  data: ScheduleResponse;
  /** Nombre de personnes affichées après filtrage (annonce). */
  shownCount: number;
  source: ViewsSource;
  filters: ViewFilters;
  zoom: Zoom;
  onFilters(f: ViewFilters): void;
  onZoom(z: Zoom): void;
  /** Reflète la vue courante dans l'URL (défaut : oui). */
  urlSync?: boolean;
}

type Form = "save" | "rename" | "delete" | null;
const ERROR_KEYS = new Set<ViewsErrorCode>(["ALREADY_EXISTS", "FORBIDDEN", "VERSION_CONFLICT", "NOT_FOUND"]);
const errorKey = (code: ViewsErrorCode): MessageKey => `views.error.${ERROR_KEYS.has(code) ? code as "NOT_FOUND" : "other"}`;
const VIEW_PARAM = "view";

function readViewParam(): string | null {
  try { return new URLSearchParams(location.search).get(VIEW_PARAM); } catch { return null; }
}
function writeViewParam(id: string | null) {
  try {
    const url = new URL(location.href);
    if (id) url.searchParams.set(VIEW_PARAM, id); else url.searchParams.delete(VIEW_PARAM);
    history.replaceState(history.state, "", url);
  } catch { /* URL non modifiable (contexte sans historique) : sans effet */ }
}

/** Le zoom ne compte dans la comparaison que si la vue en porte un (une vue sans zoom ne le force pas). */
const modifiedFrom = (view: SavedView, now: ViewFilters) =>
  !sameFilters(view.filters.zoom ? view.filters : { ...view.filters, zoom: now.zoom }, now);

/** Filtres portés par l'écran : ceux d'une vue sans le zoom (état à part). */
const screenFilters = (f: ViewFilters): ViewFilters => { const { zoom: _zoom, ...rest } = f; return rest; };

const byPosition = (a: SavedView, b: SavedView) => a.position - b.position || a.name.localeCompare(b.name);

export function ViewsBar({ i18n, data, shownCount, source, filters, zoom, onFilters, onZoom, urlSync = true }: ViewsBarProps) {
  const t = (k: MessageKey, values?: Record<string, unknown>) => i18n._(k, values);
  const [views, setViews] = useState<SavedView[]>([]);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [form, setForm] = useState<Form>(null);
  const [name, setName] = useState("");
  const [shared, setShared] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  const uid = useId();
  const opener = useRef<HTMLElement | null>(null);
  const applied = useRef(false);

  const current = views.find((v) => v.id === currentId) ?? null;
  const effective: ViewFilters = { ...filters, zoom };
  const modified = current !== null && modifiedFrom(current, effective);
  const count = activeFilterCount(filters);

  const say = (text: string, error = false) => setMessage({ text, error });
  const fail = (code: ViewsErrorCode) => say(t(errorKey(code)), true);
  const select = (id: string | null) => { setCurrentId(id); if (urlSync) writeViewParam(id); };

  const apply = (view: SavedView | null) => {
    select(view?.id ?? null);
    if (!view) { onFilters({}); say(t("views.status.all")); return; }
    onFilters(screenFilters(view.filters));
    if (view.filters.zoom) onZoom(view.filters.zoom);
    setForm(null);
  };

  useEffect(() => {
    let live = true;
    void source.list().then((r) => {
      if (!live) return;
      if (!r.ok) { say(t("views.load.failed"), true); return; }
      setViews(r.value);
      const wanted = urlSync && !applied.current ? readViewParam() : null;
      applied.current = true;
      const view = wanted ? r.value.find((v) => v.id === wanted) : undefined;
      if (view) { setCurrentId(view.id); onFilters(screenFilters(view.filters)); if (view.filters.zoom) onZoom(view.filters.zoom); }
    });
    return () => { live = false; };
  }, [source]);

  // Annonce de l'effet d'une vue choisie : le nombre de personnes affichées une fois les lignes recalculées.
  const announced = useRef<string | null>(null);
  useEffect(() => {
    if (!current || announced.current === current.id) return;
    announced.current = current.id;
    say(t("views.status.applied", { name: current.name, count: shownCount }));
  }, [current?.id, shownCount]);

  const patchList = (v: SavedView) => setViews((vs) => vs.map((x) => (x.id === v.id ? v : x)));
  /** Après un échec : sur conflit de version, relit la vue (ou la retire si elle a disparu). */
  const afterFailure = async (code: ViewsErrorCode, view: SavedView | null) => {
    if (view && (code === "VERSION_CONFLICT" || code === "NOT_FOUND")) {
      const fresh = await source.reload(view.id);
      if (fresh) patchList(fresh);
      else { setViews((vs) => vs.filter((x) => x.id !== view.id)); if (currentId === view.id) select(null); }
    }
    fail(code);
  };
  const run = async <T,>(op: () => Promise<ViewsResult<T>>, view: SavedView | null, done: (value: T) => void) => {
    setBusy(true);
    try {
      const r = await op();
      if (r.ok) { done(r.value); closeForm(); } else await afterFailure(r.error, view);
    } finally { setBusy(false); }
  };

  const openForm = (f: Exclude<Form, null>) => {
    opener.current = document.activeElement as HTMLElement | null;
    setName(f === "rename" ? current?.name ?? "" : "");
    setShared(false);
    setMessage(null);
    setForm(f);
  };
  const closeForm = () => { setForm(null); queueMicrotask(() => opener.current?.focus()); };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const trimmed = name.trim();
    if (form === "save" && trimmed) {
      void run(() => source.create({ name: trimmed, filters: normalizeFilters(effective), shared }), null, (v) => {
        setViews((vs) => [...vs, v]); select(v.id); announced.current = v.id; say(t("views.status.saved", { name: v.name }));
      });
    } else if (form === "rename" && current && trimmed) {
      void run(() => source.update(current, { name: trimmed }), current, (v) => { patchList(v); say(t("views.status.renamed", { name: v.name })); });
    } else if (form === "delete" && current) {
      void run(() => source.remove(current), current, () => {
        setViews((vs) => vs.filter((x) => x.id !== current.id)); select(null); say(t("views.status.deleted", { name: current.name }));
      });
    }
  };
  const update = () => {
    if (!current || busy) return;
    void run(() => source.update(current, { filters: normalizeFilters(effective) }), current, (v) => { patchList(v); say(t("views.status.updated", { name: v.name })); });
  };

  const multi = (key: "departmentIds" | "roleIds" | "projectIds" | "personIds", label: MessageKey, options: ReadonlyArray<{ id: string; name: string }>) => (
    <div className="wn-filter">
      <span id={`${uid}-${key}`}>{t(label)}</span>
      <select multiple size={4} aria-labelledby={`${uid}-${key}`} value={filters[key] ?? []}
        onChange={(e) => onFilters({ ...filters, [key]: [...e.currentTarget.selectedOptions].map((o) => o.value) })}>
        {options.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
      </select>
    </div>
  );

  const sorted = [...views].sort(byPosition);
  return (
    <div role="group" aria-label={t("views.toolbar.label")} className="wn-views">
      <div className="wn-views-row">
        <label>
          <span id={`${uid}-view`}>{t("views.label")}</span>{" "}
          <select aria-labelledby={`${uid}-view`} value={currentId ?? ""} onChange={(e) => apply(views.find((v) => v.id === e.currentTarget.value) ?? null)}>
            <option value="">{t("views.all")}</option>
            {sorted.map((v) => <option key={v.id} value={v.id}>{v.shared ? t("views.shared", { name: v.name }) : v.name}</option>)}
          </select>
        </label>
        {modified && <span className="wn-views-modified">{t("views.modified")}</span>}
        <button type="button" onClick={() => openForm("save")}>{t("views.save")}</button>
        {current?.canManage && (
          <>
            <button type="button" disabled={!modified || busy} onClick={update}>{t("views.update")}</button>
            <button type="button" onClick={() => openForm("rename")}>{t("views.rename")}</button>
            <button type="button" onClick={() => openForm("delete")}>{t("views.delete")}</button>
          </>
        )}
        <span role="status" className={message?.error ? "wn-views-error" : "wn-views-status"}>{message?.text ?? ""}</span>
      </div>
      {form && (
        <Modal title={t(form === "save" ? "views.dialog.save" : form === "rename" ? "views.dialog.rename" : "views.dialog.delete")} closeLabel={t("dialog.close")} onClose={closeForm} busy={busy}
          footer={
            <>
              <Button onClick={closeForm}>{t("views.form.cancel")}</Button>
              <Button type="submit" form={`${uid}-form`} variant={form === "delete" ? "danger" : "primary"} disabled={busy || (form !== "delete" && !name.trim())} autoFocus={form === "delete"}>
                {t(form === "save" ? "views.form.save" : form === "rename" ? "views.form.rename" : "views.delete.submit")}
              </Button>
            </>
          }>
          <form id={`${uid}-form`} className="wn-views-form" onSubmit={submit}>
            {form === "delete" ? (
              <p>{t("views.delete.confirm", { name: current?.name ?? "" })}</p>
            ) : (
              <>
                <label>
                  <span>{t("views.form.name")}</span>{" "}
                  <input type="text" value={name} required maxLength={100} autoFocus onChange={(e) => setName(e.currentTarget.value)} />
                </label>
                {form === "save" && (
                  <label>
                    <input type="checkbox" checked={shared} onChange={(e) => setShared(e.currentTarget.checked)} /> <span>{t("views.form.shared")}</span>
                  </label>
                )}
              </>
            )}
            {message?.error && <p className="wn-dialog-error">{message.text}</p>}
          </form>
        </Modal>
      )}
      <details className="wn-filters">
        <summary>{count ? t("views.filters.count", { count }) : t("views.filters")}</summary>
        <div className="wn-filters-body">
          {multi("departmentIds", "views.filter.department", data.departments)}
          {multi("roleIds", "views.filter.role", data.roles)}
          {multi("projectIds", "views.filter.project", data.projects)}
          {multi("personIds", "views.filter.person", data.people)}
          <div className="wn-filter">
            <span id={`${uid}-sort`}>{t("views.sort.label")}</span>
            <select aria-labelledby={`${uid}-sort`} value={filters.peopleSort ?? "name"} onChange={(e) => onFilters({ ...filters, peopleSort: e.currentTarget.value as ViewFilters["peopleSort"] })}>
              {(["name", "department", "role"] as const).map((s) => <option key={s} value={s}>{t(`views.sort.${s}`)}</option>)}
            </select>
          </div>
          <button type="button" disabled={count === 0 && !filters.peopleSort} onClick={() => onFilters({})}>{t("views.reset")}</button>
        </div>
      </details>
    </div>
  );
}
