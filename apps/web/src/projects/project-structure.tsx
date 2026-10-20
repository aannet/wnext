// Phases et jalons d'un projet, en lecture (RT-010) : la création et l'édition viendront avec la planification des projets.
import type { I18n } from "@lingui/core";
import { useId, useMemo } from "react";
import type { ProjectsSource } from "../data/projects-source";
import type { MessageKey } from "../i18n";
import { useLoad } from "./use-load";

export function StructureLists({ i18n, source, projectId }: { i18n: I18n; source: ProjectsSource; projectId: string }) {
  const t = (k: MessageKey, v?: Record<string, unknown>) => i18n._(k, v);
  const id = useId();
  const phases = useLoad(() => source.listPhases(projectId), `phases:${projectId}`);
  const milestones = useLoad(() => source.listMilestones(projectId), `milestones:${projectId}`);
  const fmt = useMemo(() => new Intl.DateTimeFormat(i18n.locale, { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }), [i18n.locale]);
  const day = (iso: string | null) => (iso ? fmt.format(new Date(`${iso}T00:00:00Z`)) : "");
  const range = (a: string | null, b: string | null) => (a || b ? `${day(a)} – ${day(b)}` : t("projects.dates.none"));
  return (
    <>
      <section className="wn-panel-block" aria-labelledby={`${id}-ph`}>
        <h3 id={`${id}-ph`} className="wn-panel-section">{t("projects.phases.title")}</h3>
        {phases.state.status === "ready" && (phases.state.data.length === 0
          ? <p className="wn-muted">{t("projects.phases.empty")}</p>
          : <ul className="wn-rows">{phases.state.data.map((p) => <li key={p.id}><span className="wn-row-name">{p.name}</span><span className="wn-muted">{range(p.startDate, p.endDate)}</span></li>)}</ul>)}
        {phases.state.status === "error" && <p role="alert" className="wn-error">{t("projects.structure.error")}</p>}
      </section>
      <section className="wn-panel-block" aria-labelledby={`${id}-ms`}>
        <h3 id={`${id}-ms`} className="wn-panel-section">{t("projects.milestones.title")}</h3>
        {milestones.state.status === "ready" && (milestones.state.data.length === 0
          ? <p className="wn-muted">{t("projects.milestones.empty")}</p>
          : <ul className="wn-rows">{milestones.state.data.map((m) => <li key={m.id}><span className="wn-row-name">{m.name}</span><span className="wn-muted">{day(m.dueDate)}</span></li>)}</ul>)}
        {milestones.state.status === "error" && <p role="alert" className="wn-error">{t("projects.structure.error")}</p>}
      </section>
    </>
  );
}
