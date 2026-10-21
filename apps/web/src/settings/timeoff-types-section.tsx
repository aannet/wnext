// Types de congé (Réglages) : nom et « déduit de la capacité » (BR-04 : un congé non déduit ne réduit pas la capacité). Création,
// bascule de « déduit » et suppression confirmée (REFERENCE_IN_USE si des congés l'utilisent).
import type { I18n } from "@lingui/core";
import { useId, useState } from "react";
import type { RefStore, TimeoffType } from "../data/people-source";
import { Button, Modal } from "../design";
import type { MessageKey } from "../i18n";
import { errorOf } from "../people/people-model";
import { useLoad } from "../projects/use-load";
import { sortByName } from "./settings-model";

export interface TimeoffTypesSectionProps {
  i18n: I18n;
  store: RefStore<TimeoffType, { name: string; deducted: boolean }, { name?: string; deducted?: boolean }>;
  canEdit: boolean;
}

export function TimeoffTypesSection({ i18n, store, canEdit }: TimeoffTypesSectionProps) {
  const t = (k: MessageKey, v?: Record<string, unknown>) => i18n._(k, v);
  const id = useId();
  const list = useLoad(() => store.list(), "timeoff-types");
  const [name, setName] = useState("");
  const [deducted, setDeducted] = useState(true);
  const [removing, setRemoving] = useState<TimeoffType | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const items = list.state.status === "ready" ? sortByName(list.state.data) : [];

  async function create(e: React.FormEvent) {
    e.preventDefault();
    const next = name.trim();
    if (!next || busy) return;
    if (items.some((x) => x.name.toLocaleLowerCase() === next.toLocaleLowerCase())) { setError(t("settings.error.exists")); return; }
    setBusy(true); setError(null); setNotice("");
    const r = await store.create({ name: next, deducted });
    setBusy(false);
    if (!r.ok) { setError(t(errorOf(r.error).key)); return; }
    list.update((d) => [...d, r.value]);
    setName("");
    setNotice(t("settings.created", { name: r.value.name }));
  }
  async function toggle(item: TimeoffType) {
    setBusy(true); setError(null); setNotice("");
    const r = await store.update(item, { deducted: !item.deducted });
    setBusy(false);
    if (!r.ok) { setError(t(errorOf(r.error).key)); return; }
    list.update((d) => d.map((x) => (x.id === item.id ? r.value : x)));
  }
  async function remove(item: TimeoffType) {
    setBusy(true); setError(null); setNotice("");
    const r = await store.remove(item);
    setBusy(false);
    setRemoving(null);
    if (!r.ok) { setError(t(errorOf(r.error).key)); return; }
    list.update((d) => d.filter((x) => x.id !== item.id));
    setNotice(t("settings.deleted", { name: item.name }));
  }

  return (
    <section className="wn-clients" aria-labelledby={`${id}-h`}>
      <h2 id={`${id}-h`} className="wn-panel-section">{t("settings.timeoff.title")}</h2>
      {error && <p role="alert" className="wn-error">{error}</p>}
      <p role="status" className={notice ? "wn-panel-notice" : "wn-visually-hidden"}>{notice}</p>
      {list.state.status === "loading" && <p className="wn-muted">{t("people.loading")}</p>}
      {list.state.status === "error" && <p role="alert" className="wn-error">{t("people.error.load")} <Button size="sm" type="button" onClick={list.reload}>{t("people.retry")}</Button></p>}
      {canEdit && (
        <form className="wn-inline-form" onSubmit={(e) => void create(e)}>
          <label htmlFor={`${id}-new`}>{t("settings.timeoff.new")}</label>
          <input id={`${id}-new`} value={name} maxLength={200} autoComplete="off" onChange={(e) => setName(e.target.value)} />
          <label><input type="checkbox" checked={deducted} onChange={(e) => setDeducted(e.target.checked)} /> {t("settings.timeoff.deducted")}</label>
          <Button type="submit" variant="primary" disabled={busy || !name.trim()}>{t("settings.add")}</Button>
        </form>
      )}
      {list.state.status === "ready" && (items.length === 0 ? <p className="wn-muted">{t("settings.timeoff.empty")}</p> : (
        <ul className="wn-rows">
          {items.map((x) => (
            <li key={x.id}>
              <span className="wn-row-name">{x.name} <span className="wn-muted">{t(x.deducted ? "settings.timeoff.deducted.yes" : "settings.timeoff.deducted.no")}</span></span>
              {canEdit && (
                <span className="wn-row-actions">
                  <Button size="sm" type="button" disabled={busy} onClick={() => void toggle(x)}>{t(x.deducted ? "settings.timeoff.make_free" : "settings.timeoff.make_deducted", { name: x.name })}</Button>
                  <Button size="sm" type="button" onClick={() => { setError(null); setRemoving(x); }}>{t("settings.delete", { name: x.name })}</Button>
                </span>
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
