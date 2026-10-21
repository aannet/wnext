// Équipe d'un projet : liste, ajout de personnes, retrait. Le retrait suit le parcours BR-10 du planning (team-removal-ui, attaché
// au menu contextuel de la grille) : même dialogue partagé (team/team-removal-dialog), mêmes règles et mêmes textes. Même
// `TeamRemovalEditor` que le planning (source du planning), donc même moteur de règles.
import type { I18n } from "@lingui/core";
import type { TeamMember } from "@wnext/contracts";
import { useId, useState } from "react";
import type { EditError } from "../data/allocation-edits";
import type { PersonRef, ProjectsSource } from "../data/projects-source";
import { confirmationOf, type RemovalSummary, type TeamRemovalEditor } from "../data/team-removal";
import type { MessageKey } from "../i18n";
import { TeamRemovalDialog } from "../team/team-removal-dialog";
import { errorKey } from "./projects-model";
import { useLoad } from "./use-load";
import { Button } from "../design";

interface Removal { member: TeamMember; summary: RemovalSummary | null; error: string | null; stale: boolean; busy: boolean }

const SHOWN = new Set<EditError>(["FORBIDDEN", "NETWORK", "NOT_FOUND"]);
const removalErrorKey = (e: EditError): MessageKey => (SHOWN.has(e) ? `schedule.removal.error.${e as "NETWORK"}` : "schedule.removal.error.other");

export interface ProjectTeamProps {
  i18n: I18n;
  source: ProjectsSource;
  projectId: string;
  projectName: string;
  canEdit: boolean;
  editor: TeamRemovalEditor | undefined;
}

export function ProjectTeam({ i18n, source, projectId, projectName, canEdit, editor }: ProjectTeamProps) {
  const t = (k: MessageKey, v?: Record<string, unknown>) => i18n._(k, v);
  const id = useId();
  const team = useLoad(() => source.listTeam(projectId), `team:${projectId}`);
  const people = useLoad(() => (canEdit ? source.listPeople() : Promise.resolve({ ok: true as const, value: [] as PersonRef[] })), `people:${canEdit}`);
  const [pick, setPick] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [removal, setRemoval] = useState<Removal | null>(null);

  const members = team.state.status === "ready" ? team.state.data : [];
  const candidates = people.state.status === "ready" ? people.state.data.filter((x) => !members.some((m) => m.personId === x.id)) : [];

  async function add(e: React.FormEvent) {
    e.preventDefault();
    const person = candidates.find((c) => c.id === pick);
    if (!person || busy) return;
    setBusy(true); setError(null); setNotice("");
    const r = await source.addToTeam(projectId, [person.id]);
    setBusy(false);
    if (!r.ok) { setError(t(errorKey(r.error))); return; }
    team.update((d) => (d.some((m) => m.personId === person.id) ? d : [...d, { personId: person.id, name: person.name }]));
    setPick("");
    setNotice(t("projects.team.added", { person: person.name }));
  }

  async function openRemoval(member: TeamMember) {
    if (!editor) return;
    setNotice("");
    setRemoval({ member, summary: null, error: null, stale: false, busy: false });
    const r = await editor.teamRemovalSummary(projectId, member.personId);
    setRemoval(r.ok ? { member, summary: r.summary, error: null, stale: false, busy: false } : { member, summary: null, error: t(removalErrorKey(r.error)), stale: false, busy: false });
  }

  async function confirmRemoval() {
    if (!editor || !removal?.summary || removal.busy) return;
    const { member, summary } = removal;
    setRemoval({ ...removal, busy: true });
    const r = await editor.removeFromTeam(projectId, member.personId, confirmationOf(summary));
    if (r.ok) {
      source.teamRemoved(projectId, member.personId);
      team.update((d) => d.filter((m) => m.personId !== member.personId));
      setRemoval(null);
      setNotice(t("schedule.removal.done", { person: member.name, project: projectName, allocations: r.removedAllocations, logs: r.removedLogs }));
      return;
    }
    const refused = r.error === "TEAM_REMOVAL_STALE_CONFIRMATION" || r.error === "TEAM_REMOVAL_LOCKED_LOGS" || r.error === "TEAM_REMOVAL_CONFIRMATION_REQUIRED";
    if (refused && r.summary) { setRemoval({ member, summary: r.summary, error: null, stale: r.error !== "TEAM_REMOVAL_LOCKED_LOGS", busy: false }); return; }
    if (refused) { await openRemoval(member); return; }
    setRemoval({ member, summary, error: t(removalErrorKey(r.error)), stale: false, busy: false });
  }

  return (
    <section className="wn-panel-block" aria-labelledby={`${id}-h`}>
      <h3 id={`${id}-h`} className="wn-panel-section">{t("projects.team.title")}</h3>
      {error && <p role="alert" className="wn-error">{error}</p>}
      <p role="status" className={notice ? "wn-panel-notice" : "wn-visually-hidden"}>{notice}</p>
      {team.state.status === "loading" && <p className="wn-muted">{t("projects.loading")}</p>}
      {team.state.status === "error" && <p role="alert" className="wn-error">{t("projects.team.error.load")} <Button size="sm" type="button" onClick={team.reload}>{t("projects.retry")}</Button></p>}
      {team.state.status === "ready" && (members.length === 0
        ? <p className="wn-muted">{t("projects.team.empty")}</p>
        : (
          <ul className="wn-rows">
            {members.map((m) => (
              <li key={m.personId}>
                <span className="wn-row-name">{m.name}</span>
                {canEdit && editor && <Button size="sm" type="button" onClick={() => void openRemoval(m)}>{t("projects.team.remove", { person: m.name })}</Button>}
              </li>
            ))}
          </ul>
        ))}
      {removal && (
        <TeamRemovalDialog i18n={i18n} person={removal.member.name} project={projectName} summary={removal.summary} error={removal.error}
          stale={removal.stale} busy={removal.busy} onConfirm={() => void confirmRemoval()} onCancel={() => setRemoval(null)} />
      )}
      {canEdit && (
        <form className="wn-inline-form" onSubmit={(e) => void add(e)}>
          <label htmlFor={`${id}-pick`} className="wn-visually-hidden">{t("projects.team.add.label")}</label>
          <select id={`${id}-pick`} value={pick} onChange={(e) => setPick(e.target.value)}>
            <option value="">{t("projects.team.add.placeholder")}</option>
            {candidates.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <Button type="submit" disabled={busy || !pick}>{t("projects.team.add")}</Button>
        </form>
      )}
    </section>
  );
}
