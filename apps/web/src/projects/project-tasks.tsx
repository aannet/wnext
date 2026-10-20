// Tâches d'un projet (RT-010) : liste, ajout, renommage, suppression. Suppression refusée par l'API tant que des allocations ou des
// temps saisis y renvoient (REFERENCE_IN_USE) : le message le dit, rien n'est supprimé en silence.
import type { I18n } from "@lingui/core";
import type { ProjectTask } from "@wnext/contracts";
import { useId, useState } from "react";
import type { ProjectsError, ProjectsSource } from "../data/projects-source";
import type { MessageKey } from "../i18n";
import { errorKey } from "./projects-model";
import { useLoad } from "./use-load";

export function ProjectTasks({ i18n, source, projectId, canEdit }: { i18n: I18n; source: ProjectsSource; projectId: string; canEdit: boolean }) {
  const t = (k: MessageKey, v?: Record<string, unknown>) => i18n._(k, v);
  const id = useId();
  const { state, reload, update } = useLoad(() => source.listTasks(projectId), `tasks:${projectId}`);
  const [newName, setNewName] = useState("");
  const [editing, setEditing] = useState<{ id: string; name: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fail = (e: ProjectsError) => setError(t(e.code === "REFERENCE_IN_USE" ? "projects.tasks.error.in_use" : errorKey(e)));

  async function add(e: React.FormEvent) {
    e.preventDefault();
    const name = newName.trim();
    if (!name || busy) return;
    setBusy(true); setError(null);
    const r = await source.createTask(projectId, name);
    setBusy(false);
    if (r.ok) { update((d) => [...d, r.value]); setNewName(""); } else fail(r.error);
  }
  async function rename(task: ProjectTask, name: string) {
    const next = name.trim();
    if (!next || next === task.name) { setEditing(null); return; }
    setBusy(true); setError(null);
    const r = await source.renameTask(task, next);
    setBusy(false);
    if (r.ok) { update((d) => d.map((x) => (x.id === task.id ? r.value : x))); setEditing(null); }
    else { fail(r.error); if (r.error.code === "VERSION_CONFLICT") { setEditing(null); reload(); } }
  }
  async function remove(task: ProjectTask) {
    setBusy(true); setError(null);
    const r = await source.deleteTask(task);
    setBusy(false);
    if (r.ok) update((d) => d.filter((x) => x.id !== task.id)); else fail(r.error);
  }

  return (
    <section className="wn-panel-block" aria-labelledby={`${id}-h`}>
      <h3 id={`${id}-h`} className="wn-panel-section">{t("projects.tasks.title")}</h3>
      {error && <p role="alert" className="wn-error">{error}</p>}
      {state.status === "loading" && <p className="wn-muted">{t("projects.loading")}</p>}
      {state.status === "error" && <p role="alert" className="wn-error">{t("projects.tasks.error.load")} <button type="button" onClick={reload}>{t("projects.retry")}</button></p>}
      {state.status === "ready" && (state.data.length === 0
        ? <p className="wn-muted">{t("projects.tasks.empty")}</p>
        : (
          <ul className="wn-rows">
            {state.data.map((task) => (
              <li key={task.id}>
                {editing?.id === task.id ? (
                  <form className="wn-inline-form" onSubmit={(e) => { e.preventDefault(); void rename(task, editing.name); }}>
                    <input aria-label={t("projects.tasks.rename.label", { name: task.name })} value={editing.name} autoFocus maxLength={200}
                      onChange={(e) => setEditing({ id: task.id, name: e.target.value })} onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); setEditing(null); } }} />
                    <button type="submit" disabled={busy}>{t("projects.tasks.save")}</button>
                    <button type="button" onClick={() => setEditing(null)}>{t("projects.form.cancel")}</button>
                  </form>
                ) : (
                  <>
                    <span className="wn-row-name">{task.name}</span>
                    {canEdit && (
                      <span className="wn-row-actions">
                        <button type="button" onClick={() => setEditing({ id: task.id, name: task.name })}>{t("projects.tasks.rename", { name: task.name })}</button>
                        <button type="button" disabled={busy} onClick={() => void remove(task)}>{t("projects.tasks.delete", { name: task.name })}</button>
                      </span>
                    )}
                  </>
                )}
              </li>
            ))}
          </ul>
        ))}
      {canEdit && (
        <form className="wn-inline-form" onSubmit={(e) => void add(e)}>
          <label htmlFor={`${id}-new`} className="wn-visually-hidden">{t("projects.tasks.new.label")}</label>
          <input id={`${id}-new`} value={newName} placeholder={t("projects.tasks.new.placeholder")} maxLength={200} autoComplete="off" onChange={(e) => setNewName(e.target.value)} />
          <button type="submit" disabled={busy || !newName.trim()}>{t("projects.tasks.add")}</button>
        </form>
      )}
    </section>
  );
}
