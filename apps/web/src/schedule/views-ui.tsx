// Vues sauvegardées du Schedule (FR-10), au niveau 1 de l'en-tête : choisir une vue (par défaut « Tout le monde »),
// enregistrer la vue courante (nom, partagée ou non), la mettre à jour, la renommer, la supprimer. L'état courant se reflète
// dans l'URL (?view=<id>, remplacé sans empiler l'historique).
//  * Les filtres sont portés par l'écran et édités au niveau 2 (schedule/filters-ui) ; la barre les lit et les enregistre.
//  * Une vue enregistre les filtres, le zoom ET la densité au moment de l'enregistrement ; l'appliquer remet les trois (une
//    vue enregistrée sans zoom ni densité ne les change pas).
//  * Seules les vues que l'appelant peut gérer (`canManage`) offrent mise à jour, renommage et suppression.
//  * Erreurs : codes stables de l'API, traduits ici ; sur VERSION_CONFLICT la vue est relue. Annonces dans une région role=status.
import type { I18n } from "@lingui/core";
import type { SavedView } from "@wnext/contracts";
import type { Zoom } from "@wnext/engine";
import type { Density } from "./density";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import type { ViewsErrorCode, ViewsResult, ViewsSource } from "../data/views-source";
import { Button, Modal } from "../design";
import type { MessageKey } from "../i18n";
import { normalizeFilters, sameFilters, type ViewFilters } from "./view-filters";

export interface ViewsBarProps {
  i18n: I18n;
  /** Nombre de personnes affichées après filtrage (annonce). */
  shownCount: number;
  source: ViewsSource;
  filters: ViewFilters;
  zoom: Zoom;
  /** Densité courante (absente : la barre ne l'enregistre pas) et son application par une vue. */
  density?: Density;
  onFilters(f: ViewFilters): void;
  onZoom(z: Zoom): void;
  onDensity?(d: Density): void;
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

/** Le zoom et la densité ne comptent dans la comparaison que si la vue en porte (une vue sans zoom ne le force pas). */
const modifiedFrom = (view: SavedView, now: ViewFilters) =>
  !sameFilters({ ...view.filters, zoom: view.filters.zoom ?? now.zoom, density: view.filters.density ?? now.density }, now);

/** Filtres portés par l'écran : ceux d'une vue sans le zoom ni la densité (états à part). */
const screenFilters = (f: ViewFilters): ViewFilters => { const { zoom: _zoom, density: _density, ...rest } = f; return rest; };

const byPosition = (a: SavedView, b: SavedView) => a.position - b.position || a.name.localeCompare(b.name);

export function ViewsBar({ i18n, shownCount, source, filters, zoom, density, onFilters, onZoom, onDensity, urlSync = true }: ViewsBarProps) {
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
  const effective: ViewFilters = { ...filters, zoom, ...(density ? { density } : {}) };
  const modified = current !== null && modifiedFrom(current, effective);

  const say = (text: string, error = false) => setMessage({ text, error });
  const fail = (code: ViewsErrorCode) => say(t(errorKey(code)), true);
  const select = (id: string | null) => { setCurrentId(id); if (urlSync) writeViewParam(id); };

  const apply = (view: SavedView | null) => {
    select(view?.id ?? null);
    if (!view) { onFilters({}); say(t("views.status.all")); return; }
    onFilters(screenFilters(view.filters));
    if (view.filters.zoom) onZoom(view.filters.zoom);
    if (view.filters.density) onDensity?.(view.filters.density);
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
      if (view) {
        setCurrentId(view.id);
        onFilters(screenFilters(view.filters));
        if (view.filters.zoom) onZoom(view.filters.zoom);
        if (view.filters.density) onDensity?.(view.filters.density);
      }
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
        <Button type="button" onClick={() => openForm("save")}>{t("views.save")}</Button>
        {current?.canManage && (
          <>
            <Button type="button" disabled={!modified || busy} onClick={update}>{t("views.update")}</Button>
            <Button size="sm" type="button" onClick={() => openForm("rename")}>{t("views.rename")}</Button>
            <Button type="button" onClick={() => openForm("delete")}>{t("views.delete")}</Button>
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
    </div>
  );
}
