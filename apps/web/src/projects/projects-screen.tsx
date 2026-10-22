// Écran Projets (lot L-F1 : RT-010, RT-012 partie Projets, RT-018, US-2.1). Une liste filtrable (recherche par nom ou code, client,
// statut), un panneau latéral pour le détail d'un projet ou la création réduite (dossier §4.1 principes 1 et 6), et la gestion
// minimale des clients (liste, création, renommage) dans un second onglet. Lecture seule pour member et guest (GET /me).
// Aucune navigation : ouvrir ou fermer le panneau ne change pas de page, le focus revient au déclencheur à la fermeture.
import type { I18n } from "@lingui/core";
import type { Client, ProjectDetail } from "@wnext/contracts";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ProjectsSource } from "../data/projects-source";
import type { TeamRemovalEditor } from "../data/team-removal";
import { Button, Drawer, Tabs, TabsContent, TabsList, TabsTrigger } from "../design";
import { suggestColor } from "../design/project-palette";
import type { MessageKey } from "../i18n";
import { ClientsSection } from "./clients-section";
import { ProjectForm } from "./project-form";
import { ProjectPanel } from "./project-panel";
import { resolveClient } from "./projects-actions";
import { clientName, errorKey, filterProjects, inputOf, NO_CLIENT, NO_FILTERS, STATUS_KEY, STATUSES, type FormErrors, type FormValues, type ProjectFilters } from "./projects-model";
import { useLoad } from "./use-load";

export interface ProjectsScreenProps {
  i18n: I18n;
  source: ProjectsSource;
  canEdit: boolean;
  /** Parcours de retrait BR-10 (source du planning) ; absent : pas de retrait depuis cet écran. */
  editor?: TeamRemovalEditor;
  /** Projet dont la fiche s'ouvre dès le chargement (?projet=, recherche du Planning, RT-038) ; inconnu : ignoré. */
  openProjectId?: string;
  /** Appelé une fois, quand `openProjectId` a été pris en compte (l'adresse n'a plus à le porter). */
  onOpenProjectHandled?(): void;
}

type Tab = "projects" | "clients";
type Side = { kind: "none" } | { kind: "create" } | { kind: "project"; id: string };

export function ProjectsScreen({ i18n, source, canEdit, editor, openProjectId, onOpenProjectHandled }: ProjectsScreenProps) {
  const t = (k: MessageKey, v?: Record<string, unknown>) => i18n._(k, v);
  const projects = useLoad(() => source.listProjects(), "projects");
  const clients = useLoad(() => source.listClients(), "clients");
  const [tab, setTab] = useState<Tab>("projects");
  const [filters, setFilters] = useState<ProjectFilters>(NO_FILTERS);
  const [side, setSide] = useState<Side>(() => (openProjectId ? { kind: "project", id: openProjectId } : { kind: "none" }));
  const trigger = useRef<HTMLElement | null>(null);

  const ready = projects.state.status === "ready" && clients.state.status === "ready";
  const all = projects.state.status === "ready" ? projects.state.data : [];
  const clientList = clients.state.status === "ready" ? clients.state.data : [];
  const shown = useMemo(() => filterProjects(all, filters), [all, filters]);
  const selected = side.kind === "project" ? all.find((p) => p.id === side.id) : undefined;

  function open(next: Side, el: HTMLElement | null) {
    trigger.current = el;
    setSide(next);
  }
  // Le focus est rendu au déclencheur par le Drawer commun ; seul le cas où le déclencheur a changé (création -> fiche) passe ici.
  function close() {
    setSide({ kind: "none" });
    requestAnimationFrame(() => { if (document.activeElement === document.body && trigger.current?.isConnected) trigger.current.focus(); });
  }
  // Fiche demandée par l'adresse : prise en compte une seule fois, au chargement (un projet inconnu referme le panneau ci-dessous).
  const handled = useRef(false);
  useEffect(() => {
    if (!openProjectId || !ready || handled.current) return;
    handled.current = true;
    onOpenProjectHandled?.();
  }, [openProjectId, ready]);
  // Un projet disparu (autre session) ferme son panneau.
  useEffect(() => { if (side.kind === "project" && ready && !selected) setSide({ kind: "none" }); }, [side, ready, selected]);

  const upsertProject = (p: ProjectDetail) => projects.update((d) => (d.some((x) => x.id === p.id) ? d.map((x) => (x.id === p.id ? p : x)) : [...d, p]));
  const addClient = (c: Client) => clients.update((d) => (d.some((x) => x.id === c.id) ? d : [...d, c]));

  return (
    <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)} render={<main className="wn-page wn-projects" />}>
      <div className="wn-subheader">
        <h1 tabIndex={-1} className="wn-subheader-title">{t("shell.nav.projects")}</h1>
        <TabsList aria-label={t("projects.tabs.label")}>
          <TabsTrigger value="projects">{t("projects.tabs.projects")}</TabsTrigger>
          <TabsTrigger value="clients">{t("projects.tabs.clients")}</TabsTrigger>
        </TabsList>
        {tab === "projects" && canEdit && (
          <Button type="button" variant="primary" onClick={(e) => open({ kind: "create" }, e.currentTarget)}>{t("projects.new")}</Button>
        )}
      </div>

      {(projects.state.status === "loading" || clients.state.status === "loading") && <p className="wn-muted" role="status">{t("projects.loading")}</p>}
      {(projects.state.status === "error" || clients.state.status === "error") && (
        <p role="alert" className="wn-error">{t("projects.error.load")} <Button size="sm" type="button" onClick={() => { projects.reload(); clients.reload(); }}>{t("projects.retry")}</Button></p>
      )}

      {ready && (
        <div className="wn-projects-body">
          <div className="wn-projects-main">
            <TabsContent value="projects" keepMounted>
              <Filters i18n={i18n} filters={filters} clients={clientList} onChange={setFilters} />
              {shown.length === 0 ? (
                <EmptyState i18n={i18n} filtered={all.length > 0} canEdit={canEdit} onCreate={(el) => open({ kind: "create" }, el)} onReset={() => setFilters(NO_FILTERS)} />
              ) : (
                <ProjectTable i18n={i18n} projects={shown} clients={clientList} currentId={side.kind === "project" ? side.id : null} onOpen={(p, el) => open({ kind: "project", id: p.id }, el)} />
              )}
            </TabsContent>
            <TabsContent value="clients" keepMounted>
              <ClientsSection i18n={i18n} source={source} clients={clientList} canEdit={canEdit}
                onCreated={addClient} onRenamed={(c) => clients.update((d) => d.map((x) => (x.id === c.id ? c : x)))} />
            </TabsContent>
          </div>
          {tab === "projects" && side.kind === "create" && (
            <CreatePanel i18n={i18n} source={source} clients={clientList} others={all} onClose={close}
              onClientCreated={addClient} onCreated={(p) => { upsertProject(p); setSide({ kind: "project", id: p.id }); }} />
          )}
          {tab === "projects" && selected && (
            <ProjectPanel i18n={i18n} source={source} project={selected} clients={clientList} others={all} canEdit={canEdit} editor={editor}
              onUpdated={upsertProject} onClientCreated={addClient} onClose={close} />
          )}
        </div>
      )}
    </Tabs>
  );
}

function Filters({ i18n, filters, clients, onChange }: { i18n: I18n; filters: ProjectFilters; clients: readonly Client[]; onChange(f: ProjectFilters): void }) {
  const t = (k: MessageKey) => i18n._(k);
  return (
    <form className="wn-filters" role="search" aria-label={t("projects.filters.label")} onSubmit={(e) => e.preventDefault()}>
      <div className="wn-field">
        <label htmlFor="wn-filter-search">{t("projects.filters.search")}</label>
        <input id="wn-filter-search" type="search" value={filters.search} autoComplete="off" onChange={(e) => onChange({ ...filters, search: e.target.value })} />
      </div>
      <div className="wn-field">
        <label htmlFor="wn-filter-client">{t("projects.filters.client")}</label>
        <select id="wn-filter-client" value={filters.clientId} onChange={(e) => onChange({ ...filters, clientId: e.target.value })}>
          <option value="">{t("projects.filters.client.all")}</option>
          <option value={NO_CLIENT}>{t("projects.form.client.none")}</option>
          {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
      </div>
      <div className="wn-field">
        <label htmlFor="wn-filter-status">{t("projects.filters.status")}</label>
        <select id="wn-filter-status" value={filters.status} onChange={(e) => onChange({ ...filters, status: e.target.value as ProjectFilters["status"] })}>
          <option value="">{t("projects.filters.status.active")}</option>
          {STATUSES.map((s) => <option key={s} value={s}>{t(STATUS_KEY[s])}</option>)}
        </select>
      </div>
    </form>
  );
}

function EmptyState({ i18n, filtered, canEdit, onCreate, onReset }: { i18n: I18n; filtered: boolean; canEdit: boolean; onCreate(el: HTMLElement): void; onReset(): void }) {
  const t = (k: MessageKey) => i18n._(k);
  return (
    <section className="wn-soon wn-empty" aria-labelledby="wn-empty-title">
      <h2 id="wn-empty-title">{t(filtered ? "projects.empty.filtered.title" : "projects.empty.title")}</h2>
      <p>{t(filtered ? "projects.empty.filtered.body" : "projects.empty.body")}</p>
      {filtered
        ? <Button type="button" onClick={onReset}>{t("projects.filters.reset")}</Button>
        : canEdit && <Button type="button" variant="primary" onClick={(e) => onCreate(e.currentTarget)}>{t("projects.new")}</Button>}
    </section>
  );
}

function ProjectTable({ i18n, projects, clients, currentId, onOpen }: { i18n: I18n; projects: readonly ProjectDetail[]; clients: readonly Client[]; currentId: string | null; onOpen(p: ProjectDetail, el: HTMLElement): void }) {
  const t = (k: MessageKey, v?: Record<string, unknown>) => i18n._(k, v);
  const fmt = useMemo(() => new Intl.DateTimeFormat(i18n.locale, { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }), [i18n.locale]);
  const day = (iso: string | null) => (iso ? fmt.format(new Date(`${iso}T00:00:00Z`)) : "");
  return (
    <table className="wn-table">
      <caption className="wn-visually-hidden">{t("projects.table.caption", { count: projects.length })}</caption>
      <thead>
        <tr>
          <th scope="col">{t("projects.col.name")}</th>
          <th scope="col">{t("projects.col.code")}</th>
          <th scope="col">{t("projects.col.client")}</th>
          <th scope="col">{t("projects.col.status")}</th>
          <th scope="col">{t("projects.col.dates")}</th>
        </tr>
      </thead>
      <tbody>
        {projects.map((p) => (
          <tr key={p.id} data-current={p.id === currentId || undefined}>
            <th scope="row">
              <Button variant="link" aria-expanded={p.id === currentId} {...(p.id === currentId ? { "aria-current": "true" as const } : {})}
                onClick={(e) => onOpen(p, e.currentTarget)}>
                <span className="wn-dot" aria-hidden="true" style={{ background: p.color }} />
                {p.name}
              </Button>
            </th>
            <td>{p.projectCode ?? ""}</td>
            <td>{clientName(clients, p.clientId)}</td>
            <td>{t(STATUS_KEY[p.status])}</td>
            <td>{p.startDate || p.endDate ? `${day(p.startDate)} – ${day(p.endDate)}` : ""}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

interface CreatePanelProps {
  i18n: I18n;
  source: ProjectsSource;
  clients: readonly Client[];
  others: readonly ProjectDetail[];
  onClose(): void;
  onClientCreated(c: Client): void;
  onCreated(p: ProjectDetail): void;
}

/** Création réduite d'un projet (US-2.1) : client choisi ou créé à la volée, couleur proposée dans la palette, code unique. */
function CreatePanel({ i18n, source, clients, others, onClose, onClientCreated, onCreated }: CreatePanelProps) {
  const t = (k: MessageKey, v?: Record<string, unknown>) => i18n._(k, v);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<FormErrors>({});
  const [draft, setDraft] = useState<FormValues | null>(null);
  const [formKey, setFormKey] = useState(0);
  const initial: FormValues = useMemo(() => draft ?? ({
    name: "", clientId: "", newClientName: "", projectCode: "", color: suggestColor(others.map((p) => p.color)), startDate: "", endDate: "", status: "planned",
  }), [draft, others]);

  const [dirty, setDirty] = useState(false);
  async function create(v: FormValues) {
    setBusy(true); setError(null); setFieldErrors({});
    try {
      const step = await resolveClient(source, v);
      if (!step.ok) { setError(t(errorKey(step.error))); return; }
      if (step.created) onClientCreated(step.created);
      const r = await source.createProject(inputOf(v, step.clientId));
      if (r.ok) { onCreated(r.value); return; }
      // Le client créé pour ce projet reste : le formulaire le propose déjà choisi au nouvel essai.
      if (step.created) { setDraft({ ...v, clientId: step.created.id, newClientName: "" }); setFormKey((n) => n + 1); }
      if (r.error.code === "ALREADY_EXISTS" && r.error.params.field === "projectCode") setFieldErrors({ projectCode: "projects.error.code_taken" });
      else if (r.error.code === "VALIDATION_FAILED" && r.error.params.field === "endDate") setFieldErrors({ endDate: "projects.form.error.dates" });
      else setError(t(errorKey(r.error)));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Drawer title={t("projects.create.title")} closeLabel={t("dialog.close")} onClose={onClose} busy={busy} className="wn-project-panel"
      unsaved={{ dirty, title: t("dialog.discard.title"), keep: t("dialog.discard.keep"), discard: t("dialog.discard.discard") }}>
      <ProjectForm key={formKey} i18n={i18n} mode="create" initial={initial} clients={clients} others={others} busy={busy} submitError={error}
        serverFieldErrors={fieldErrors} onDirtyChange={setDirty} onSubmit={(v) => void create(v)} onCancel={onClose} />
    </Drawer>
  );
}
