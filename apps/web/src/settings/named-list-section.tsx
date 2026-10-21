// Liste de référence à un seul nom, éditable (Réglages) : équipes (départements) et rôles. Création, renommage en place (If-Match),
// suppression confirmée ; l'API refuse la suppression d'un élément encore utilisé (REFERENCE_IN_USE), ce qui est dit clairement.
// Le doublon de nom (insensible à la casse) est refusé avant l'appel puis par l'API (ALREADY_EXISTS).
import type { I18n } from "@lingui/core";
import { useId, useState } from "react";
import type { RefStore } from "../data/people-source";
import { Button, Modal } from "../design";
import type { MessageKey } from "../i18n";
import { errorOf } from "../people/people-model";
import { useLoad } from "../projects/use-load";
import { sortByName } from "./settings-model";

export interface NamedListSectionProps<T extends { id: string; version: number; name: string }> {
  i18n: I18n;
  store: RefStore<T, { name: string }, { name: string }>;
  canEdit: boolean;
  headingKey: MessageKey;
  newLabel: MessageKey;
  empty: MessageKey;
}

export function NamedListSection<T extends { id: string; version: number; name: string }>({ i18n, store, canEdit, headingKey, newLabel, empty }: NamedListSectionProps<T>) {
  const t = (k: MessageKey, v?: Record<string, unknown>) => i18n._(k, v);
  const id = useId();
  const list = useLoad(() => store.list(), `list:${headingKey}`);
  const [name, setName] = useState("");
  const [editing, setEditing] = useState<{ id: string; name: string } | null>(null);
  const [removing, setRemoving] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const items = list.state.status === "ready" ? sortByName(list.state.data) : [];
  const clash = (value: string, selfId: string | null) => items.some((x) => x.id !== selfId && x.name.toLocaleLowerCase() === value.toLocaleLowerCase());
  const show = (e: Parameters<typeof errorOf>[0]) => setError(t(errorOf(e).key));

  async function create(e: React.FormEvent) {
    e.preventDefault();
    const next = name.trim();
    if (!next || busy) return;
    if (clash(next, null)) { setError(t("settings.error.exists")); return; }
    setBusy(true); setError(null); setNotice("");
    const r = await store.create({ name: next });
    setBusy(false);
    if (!r.ok) { show(r.error); return; }
    list.update((d) => [...d, r.value]);
    setName("");
    setNotice(t("settings.created", { name: r.value.name }));
  }
  async function rename(item: T, value: string) {
    const next = value.trim();
    if (!next || next === item.name) { setEditing(null); return; }
    if (clash(next, item.id)) { setError(t("settings.error.exists")); return; }
    setBusy(true); setError(null); setNotice("");
    const r = await store.update(item, { name: next });
    setBusy(false);
    if (!r.ok) { show(r.error); return; }
    list.update((d) => d.map((x) => (x.id === item.id ? r.value : x)));
    setEditing(null);
    setNotice(t("settings.renamed", { name: r.value.name }));
  }
  async function remove(item: T) {
    setBusy(true); setError(null); setNotice("");
    const r = await store.remove(item);
    setBusy(false);
    setRemoving(null);
    if (!r.ok) { show(r.error); return; }
    list.update((d) => d.filter((x) => x.id !== item.id));
    setNotice(t("settings.deleted", { name: item.name }));
  }

  return (
    <section className="wn-clients" aria-labelledby={`${id}-h`}>
      <h2 id={`${id}-h`} className="wn-panel-section">{t(headingKey)}</h2>
      {error && <p role="alert" className="wn-error">{error}</p>}
      <p role="status" className={notice ? "wn-panel-notice" : "wn-visually-hidden"}>{notice}</p>
      {list.state.status === "loading" && <p className="wn-muted">{t("people.loading")}</p>}
      {list.state.status === "error" && <p role="alert" className="wn-error">{t("people.error.load")} <button type="button" onClick={list.reload}>{t("people.retry")}</button></p>}
      {canEdit && (
        <form className="wn-inline-form" onSubmit={(e) => void create(e)}>
          <label htmlFor={`${id}-new`}>{t(newLabel)}</label>
          <input id={`${id}-new`} value={name} maxLength={200} autoComplete="off" onChange={(e) => setName(e.target.value)} />
          <button type="submit" className="wn-primary" disabled={busy || !name.trim()}>{t("settings.add")}</button>
        </form>
      )}
      {list.state.status === "ready" && (items.length === 0 ? <p className="wn-muted">{t(empty)}</p> : (
        <ul className="wn-rows">
          {items.map((x) => (
            <li key={x.id}>
              {editing?.id === x.id ? (
                <form className="wn-inline-form" onSubmit={(e) => { e.preventDefault(); void rename(x, editing.name); }}>
                  <input aria-label={t("settings.rename.label", { name: x.name })} value={editing.name} autoFocus maxLength={200}
                    onChange={(e) => setEditing({ id: x.id, name: e.target.value })} onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); setEditing(null); } }} />
                  <button type="submit" disabled={busy}>{t("settings.save")}</button>
                  <button type="button" onClick={() => setEditing(null)}>{t("settings.cancel")}</button>
                </form>
              ) : (
                <>
                  <span className="wn-row-name">{x.name}</span>
                  {canEdit && (
                    <span className="wn-row-actions">
                      <button type="button" onClick={() => { setError(null); setEditing({ id: x.id, name: x.name }); }}>{t("settings.rename", { name: x.name })}</button>
                      <button type="button" onClick={() => { setError(null); setRemoving(x); }}>{t("settings.delete", { name: x.name })}</button>
                    </span>
                  )}
                </>
              )}
            </li>
          ))}
        </ul>
      ))}
      {removing && (
        <Modal title={t("settings.delete.title", { name: removing.name })} closeLabel={t("dialog.close")} onClose={() => setRemoving(null)} busy={busy}
          footer={<><Button onClick={() => setRemoving(null)}>{t("settings.cancel")}</Button><Button variant="danger" autoFocus disabled={busy} onClick={() => void remove(removing)}>{t("settings.delete.confirm")}</Button></>}>
          <p>{t("settings.delete.body")}</p>
        </Modal>
      )}
    </section>
  );
}
