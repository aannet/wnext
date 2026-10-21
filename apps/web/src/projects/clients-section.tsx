// Clients (RT-012, gestion minimale) : liste, création, renommage. La suppression d'un client n'est pas proposée ici : l'API la
// refuse tant que des projets y sont rattachés, et le détachement se fait projet par projet.
import type { I18n } from "@lingui/core";
import type { Client } from "@wnext/contracts";
import { useId, useState } from "react";
import type { ProjectsSource } from "../data/projects-source";
import type { MessageKey } from "../i18n";
import { errorKey } from "./projects-model";
import { Button } from "../design";

export interface ClientsSectionProps {
  i18n: I18n;
  source: ProjectsSource;
  clients: readonly Client[];
  canEdit: boolean;
  onCreated(c: Client): void;
  onRenamed(c: Client): void;
}

export function ClientsSection({ i18n, source, clients, canEdit, onCreated, onRenamed }: ClientsSectionProps) {
  const t = (k: MessageKey, v?: Record<string, unknown>) => i18n._(k, v);
  const id = useId();
  const [name, setName] = useState("");
  const [editing, setEditing] = useState<{ id: string; name: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const sorted = [...clients].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));

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

  return (
    <section className="wn-clients" aria-labelledby={`${id}-h`}>
      <h2 id={`${id}-h`} className="wn-panel-section">{t("projects.clients.title")}</h2>
      {error && <p role="alert" className="wn-error">{error}</p>}
      {canEdit && (
        <form className="wn-inline-form" onSubmit={(e) => void create(e)}>
          <label htmlFor={`${id}-new`}>{t("projects.clients.new.label")}</label>
          <input id={`${id}-new`} value={name} maxLength={200} autoComplete="off" onChange={(e) => setName(e.target.value)} />
          <Button type="submit" variant="primary" disabled={busy || !name.trim()}>{t("projects.clients.add")}</Button>
        </form>
      )}
      {sorted.length === 0 ? <p className="wn-muted">{t("projects.clients.empty")}</p> : (
        <ul className="wn-rows">
          {sorted.map((c) => (
            <li key={c.id}>
              {editing?.id === c.id ? (
                <form className="wn-inline-form" onSubmit={(e) => { e.preventDefault(); void rename(c, editing.name); }}>
                  <input aria-label={t("projects.clients.rename.label", { name: c.name })} value={editing.name} autoFocus maxLength={200}
                    onChange={(e) => setEditing({ id: c.id, name: e.target.value })} onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); setEditing(null); } }} />
                  <Button size="sm" type="submit" disabled={busy}>{t("projects.tasks.save")}</Button>
                  <Button size="sm" type="button" onClick={() => setEditing(null)}>{t("projects.form.cancel")}</Button>
                </form>
              ) : (
                <>
                  <span className="wn-row-name">{c.name}</span>
                  {canEdit && <Button size="sm" type="button" onClick={() => { setError(null); setEditing({ id: c.id, name: c.name }); }}>{t("projects.clients.rename", { name: c.name })}</Button>}
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
