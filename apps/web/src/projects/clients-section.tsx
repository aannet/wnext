// Clients (RT-012, RT-053) : le DataTable commun (recherche, tri, actions « … ») dans Réglages, seul endroit où ils se gèrent.
// Actions par ligne : Modifier (renommage en ligne) et Supprimer avec confirmation ; l'API refuse la suppression tant que des
// projets sont rattachés (REFERENCE_IN_USE) et le message le dit.
import type { I18n } from "@lingui/core";
import type { Client } from "@wnext/contracts";
import { useId, useState } from "react";
import type { ProjectsSource } from "../data/projects-source";
import type { MessageKey } from "../i18n";
import { errorKey } from "./projects-model";
import { Button, compareText, DataTable, type RowAction } from "../design";

export interface ClientsSectionProps {
  i18n: I18n;
  source: ProjectsSource;
  clients: readonly Client[];
  canEdit: boolean;
  onCreated(c: Client): void;
  onRenamed(c: Client): void;
  onDeleted(c: Client): void;
}

export function ClientsSection({ i18n, source, clients, canEdit, onCreated, onRenamed, onDeleted }: ClientsSectionProps) {
  const t = (k: MessageKey, v?: Record<string, unknown>) => i18n._(k, v);
  const id = useId();
  const [name, setName] = useState("");
  const [search, setSearch] = useState("");
  const [editing, setEditing] = useState<{ id: string; name: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const needle = search.trim().toLocaleLowerCase();
  const shown = needle ? clients.filter((c) => c.name.toLocaleLowerCase().includes(needle)) : clients;

  async function create(e: React.FormEvent) {
    e.preventDefault();
    const next = name.trim();
    if (!next || busy) return;
    if (clients.some((c) => c.name.toLocaleLowerCase() === next.toLocaleLowerCase())) { setError(t("projects.form.error.client_exists")); return; }
    setBusy(true); setError(null);
    const r = await source.createClient(next);
    setBusy(false);
    if (r.ok) { onCreated(r.value); setName(""); } else setError(t(errorKey(r.error)));
  }
  async function rename(c: Client, value: string) {
    const next = value.trim();
    if (!next || next === c.name) { setEditing(null); return; }
    if (clients.some((x) => x.id !== c.id && x.name.toLocaleLowerCase() === next.toLocaleLowerCase())) { setError(t("projects.form.error.client_exists")); return; }
    setBusy(true); setError(null);
    const r = await source.renameClient(c, next);
    setBusy(false);
    if (r.ok) { onRenamed(r.value); setEditing(null); } else setError(t(errorKey(r.error)));
  }
  async function remove(c: Client) {
    setError(null);
    const r = await source.deleteClient(c);
    if (r.ok) onDeleted(c); else setError(t(errorKey(r.error)));
  }

  const actions = (c: Client): RowAction<Client>[] => (canEdit ? [
    { id: "edit", label: t("table.edit"), onSelect: () => { setError(null); setEditing({ id: c.id, name: c.name }); } },
    {
      id: "delete", label: t("table.delete"), destructive: true, onSelect: () => remove(c),
      confirm: { title: t("clients.delete.title", { name: c.name }), body: t("clients.delete.body"), confirm: t("table.delete"), cancel: t("table.cancel"), closeLabel: t("dialog.close") },
    },
  ] : []);

  return (
    <section className="wn-clients" aria-labelledby={`${id}-h`}>
      <h2 id={`${id}-h`} className="wn-panel-section">{t("projects.clients.title")}</h2>
      {error && <p role="alert" className="wn-error">{error}</p>}
      <DataTable<Client>
        rows={shown} totalCount={clients.length} rowKey={(c) => c.id} caption={t("clients.table.caption", { count: shown.length })}
        toolbarLabel={t("clients.filters.label")}
        search={{ value: search, onChange: setSearch, label: t("clients.search") }}
        primaryAction={canEdit ? (
          <form className="wn-inline-form" onSubmit={(e) => void create(e)}>
            <label htmlFor={`${id}-new`} className="wn-visually-hidden">{t("projects.clients.new.label")}</label>
            <input id={`${id}-new`} value={name} maxLength={200} autoComplete="off" placeholder={t("projects.clients.new.label")} onChange={(e) => setName(e.target.value)} />
            <Button type="submit" variant="primary" disabled={busy || !name.trim()}>{t("projects.clients.add")}</Button>
          </form>
        ) : undefined}
        columns={[{
          id: "name", header: t("clients.col.name"), rowHeader: true, compare: (a, b) => compareText(a.name, b.name),
          cell: (c) => (editing?.id === c.id ? (
            <form className="wn-inline-form" onSubmit={(e) => { e.preventDefault(); void rename(c, editing.name); }}>
              <input aria-label={t("projects.clients.rename.label", { name: c.name })} value={editing.name} autoFocus maxLength={200}
                onChange={(e) => setEditing({ id: c.id, name: e.target.value })} onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); setEditing(null); } }} />
              <Button size="sm" type="submit" disabled={busy}>{t("projects.tasks.save")}</Button>
              <Button size="sm" type="button" onClick={() => setEditing(null)}>{t("projects.form.cancel")}</Button>
            </form>
          ) : <span className="wn-row-name">{c.name}</span>),
        }]}
        defaultSort={{ key: "name", dir: "asc" }}
        actions={actions} actionsHeader={t("table.actions.header")} actionsLabel={(c) => t("table.actions.for", { name: c.name })}
        empty={{ title: t("projects.clients.empty"), body: canEdit ? t("clients.empty.body") : "" }}
        emptyFiltered={{ title: t("clients.empty.filtered.title"), body: t("clients.empty.filtered.body"), resetLabel: t("clients.filters.reset"), onReset: () => setSearch("") }}
      />
    </section>
  );
}
