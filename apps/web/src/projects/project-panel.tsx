// Panneau latéral d'un projet (dossier §4.1 principe 1 : le détail s'ouvre à côté de la liste, sans quitter l'écran) : propriétés
// éditables avec le verrou optimiste (If-Match = version lue ; 409 VERSION_CONFLICT proposé en rechargement), tâches, phases et
// jalons (lecture), équipe. Posé dans le Drawer commun (design/) : focus piégé puis rendu au déclencheur, Échap, bouton ×.
// Lecture seule pour member et guest : champs désactivés, aucune action d'écriture.
import type { I18n } from "@lingui/core";
import type { Client, ProjectDetail } from "@wnext/contracts";
import { useEffect, useState } from "react";
import { Drawer } from "../design";
import type { ProjectsSource } from "../data/projects-source";
import type { TeamRemovalEditor } from "../data/team-removal";
import type { MessageKey } from "../i18n";
import { ProjectForm } from "./project-form";
import { StructureLists } from "./project-structure";
import { ProjectTasks } from "./project-tasks";
import { ProjectTeam } from "./project-team";
import { resolveClient } from "./projects-actions";
import { diffOf, errorKey, valuesOf, type FormErrors, type FormValues } from "./projects-model";

export interface ProjectPanelProps {
  i18n: I18n;
  source: ProjectsSource;
  project: ProjectDetail;
  clients: readonly Client[];
  others: readonly ProjectDetail[];
  canEdit: boolean;
  /** Parcours BR-10 (récapitulatif puis retrait confirmé) : fourni par la source du planning. */
  editor: TeamRemovalEditor | undefined;
  onUpdated(project: ProjectDetail): void;
  onClientCreated(client: Client): void;
  onClose(): void;
}

export function ProjectPanel(p: ProjectPanelProps) {
  const t = (k: MessageKey, v?: Record<string, unknown>) => p.i18n._(k, v);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<FormErrors>({});
  const [draft, setDraft] = useState<FormValues | null>(null);
  const [formKey, setFormKey] = useState(0);
  const [notice, setNotice] = useState("");
  const [dirty, setDirty] = useState(false);
  const { project, source } = p;

  useEffect(() => { setError(null); setConflict(false); setFieldErrors({}); setDraft(null); setNotice(""); }, [project.id]);

  async function save(v: FormValues) {
    setBusy(true);
    setError(null);
    setConflict(false);
    setFieldErrors({});
    setNotice("");
    try {
      const step = await resolveClient(source, v);
      if (!step.ok) { setError(t(errorKey(step.error))); return; }
      if (step.created) p.onClientCreated(step.created);
      const r = await source.updateProject(project, diffOf(project, v, step.clientId));
      if (r.ok) {
        p.onUpdated(r.value);
        setDraft(null);
        setFormKey((n) => n + 1);
        setNotice(t("projects.panel.saved"));
        return;
      }
      // Le client créé pour ce projet reste : le formulaire le propose déjà choisi au nouvel essai.
      if (step.created) { setDraft({ ...v, clientId: step.created.id, newClientName: "" }); setFormKey((n) => n + 1); }
      if (r.error.code === "VERSION_CONFLICT") setConflict(true);
      else if (r.error.code === "ALREADY_EXISTS" && r.error.params.field === "projectCode") setFieldErrors({ projectCode: "projects.error.code_taken" });
      else setError(t(errorKey(r.error)));
    } finally {
      setBusy(false);
    }
  }

  async function reloadAfterConflict() {
    const fresh = await source.reloadProject(project.id);
    setConflict(false);
    if (fresh) { p.onUpdated(fresh); setDraft(null); setFormKey((n) => n + 1); }
    else p.onClose();
  }

  return (
    <Drawer title={project.name} closeLabel={t("dialog.close")} onClose={p.onClose} busy={busy} className="wn-project-panel"
      unsaved={{ dirty, title: t("dialog.discard.title"), keep: t("dialog.discard.keep"), discard: t("dialog.discard.discard") }}>
      {!p.canEdit && <p className="wn-muted">{t("projects.panel.readonly")}</p>}
      <p role="status" className={notice ? "wn-panel-notice" : "wn-visually-hidden"}>{notice}</p>
      {conflict && (
        <div role="alert" className="wn-error">
          <p>{t("projects.error.conflict")}</p>
          <button type="button" onClick={() => void reloadAfterConflict()}>{t("projects.panel.reload")}</button>
        </div>
      )}
      <h3 className="wn-panel-section">{t("projects.panel.properties")}</h3>
      <ProjectForm key={`${project.id}:${project.version}:${formKey}`} i18n={p.i18n} mode="edit" initial={draft ?? valuesOf(project)} clients={p.clients}
        others={p.others.filter((o) => o.id !== project.id)} readOnly={!p.canEdit} busy={busy} submitError={error} serverFieldErrors={fieldErrors}
        dirtyCheck={(v) => Object.keys(diffOf(project, v, v.newClientName.trim() ? "new" : v.clientId || null)).length > 0}
        onDirtyChange={setDirty} onSubmit={(v) => void save(v)} />
      <ProjectTasks i18n={p.i18n} source={source} projectId={project.id} canEdit={p.canEdit} />
      <StructureLists i18n={p.i18n} source={source} projectId={project.id} />
      <ProjectTeam i18n={p.i18n} source={source} projectId={project.id} projectName={project.name} canEdit={p.canEdit} editor={p.editor} />
    </Drawer>
  );
}
