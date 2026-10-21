// Interface des congés de l'écran Schedule : formulaire (créer, modifier, supprimer), avertissement BR-04 et assistant de
// reprogrammation. Le calcul et les écritures vivent dans timeoff-flow ; ici, seulement l'état des boîtes de dialogue.
//  * Enregistrer un congé qui recouvre des allocations ouvre l'avertissement (jours, heures planifiées, projets, temps déjà
//    saisi signalé) : « Reprogrammer… » (congé approuvé, BR-29) ouvre l'assistant, « Garder tel quel » enregistre sans
//    toucher aux allocations (surcharge signalée, BR-01), « Retour » revient au formulaire. Rien n'est jamais supprimé en
//    silence (écart volontaire à Float).
//  * Assistant : un choix par allocation (reporter, réduire, garder ; séries : garder), aperçu des dates qui en résultent,
//    « Appliquer » écrit tout et l'enregistre comme une seule action d'annulation.
//  * Refus : chevauchement (TIMEOFF_OVERLAP) et autres codes traduits dans le formulaire, resté ouvert ; refus en cours de
//    report : annonce, ce qui a été écrit s'annule par Ctrl+Z. Échap ferme (ou revient d'un cran).
//  * Pas de fenêtre propre (RT-017) : le hook rend la vue de l'étape courante (titre, contenu, pied, retour), affichée par la
//    pop-in du créneau dans son onglet « Congé ».
import type { I18n } from "@lingui/core";
import type { ScheduleResponse } from "@wnext/contracts";
import type { LoggedTimeInput } from "@wnext/engine";
import { useMemo, useRef, useState, type ReactNode } from "react";
import type { TimeoffPatch } from "../api/client.gen";
import type { EditError } from "../data/allocation-edits";
import type { Timeoff } from "../data/record-edits";
import { Button } from "../design";
import type { MessageKey } from "../i18n";
import { planResolution, runTimeoffAction, timeoffConflicts, type Choice, type FlowDeps, type TimeoffConflictReport, type TimeoffDraft } from "./timeoff-flow";

type Fields = Pick<Timeoff, "personId" | "typeId" | "startDate" | "endDate" | "startHalf" | "endHalf" | "approvalStatus">;
interface Review { id: string | null; fields: Fields; report: TimeoffConflictReport; logged: LoggedTimeInput[] | null; choices: Record<string, Choice> }
type Step =
  | { kind: "form"; id: string | null; fields: Fields; error: string | null }
  | (Review & { kind: "warn" })
  | (Review & { kind: "assist" });

/** Étape courante, à afficher dans la pop-in du créneau. */
export interface TimeoffView {
  title: string;
  body: ReactNode;
  footer: ReactNode;
  describedBy?: string;
  /** Formulaire d'un nouveau congé (les onglets de la pop-in restent proposés) ; sinon modification ou avertissement BR-04. */
  creating: boolean;
  /** Échap : revient d'une étape (assistant, avertissement), puis ferme. */
  back(): void;
}

export interface TimeoffEdits {
  /** « C » ou double clic : le congé de cette personne ce jour-là s'il existe (modification), sinon un nouveau. */
  openAt(personId: string, date: string): void;
  openEdit(id: string): void;
  /** Nouveau congé prérempli sur une plage (onglet « Congé » de la pop-in d'un bloc ou d'un bloc provisoire). */
  openCreate(personId: string, startDate: string, endDate: string): void;
  /** Oublie l'étape en cours sans rien écrire ni prévenir (onglet quitté, pop-in fermée). */
  reset(): void;
  isOpen(): boolean;
  view: TimeoffView | null;
}

const SHOWN = new Set<EditError>(["TIMEOFF_OVERLAP", "VERSION_CONFLICT", "NOT_FOUND", "FORBIDDEN", "NETWORK"]);
const errorKey = (e: EditError): MessageKey => (SHOWN.has(e) ? `schedule.timeoff.error.${e as "NETWORK"}` : "schedule.timeoff.error.other");
const FIELDS = ["personId", "typeId", "startDate", "endDate", "startHalf", "endHalf", "approvalStatus"] as const;

export function useTimeoffEdits(i18n: I18n, deps: FlowDeps | undefined, data: ScheduleResponse, announce: (text: string) => void, onClose: () => void): TimeoffEdits {
  const t = (k: MessageKey, v?: Record<string, unknown>) => i18n._(k, v);
  const [step, setStep] = useState<Step | null>(null);
  const stepRef = useRef(step);
  stepRef.current = step;
  const dataRef = useRef(data);
  dataRef.current = data;
  const busy = useRef(false);
  const fmt = useMemo(() => new Intl.DateTimeFormat(i18n.locale, { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" }), [i18n.locale]);
  const date = (d: string) => fmt.format(new Date(`${d}T00:00:00Z`));
  const personName = (id: string) => dataRef.current.people.find((p) => p.id === id)?.name ?? "";
  const projectName = (allocationId: string) => {
    const a = dataRef.current.allocations.find((x) => x.id === allocationId);
    return dataRef.current.projects.find((p) => p.id === a?.projectId)?.name ?? "";
  };

  const close = () => { setStep(null); onClose(); };
  const draftOf = (id: string | null, f: Fields): TimeoffDraft => {
    const cur = id ? dataRef.current.timeoffs.find((x) => x.id === id) : undefined;
    return { id, scope: cur?.scope ?? "full_day", hoursPerDay: cur?.hoursPerDay ?? null, ...f };
  };

  function openCreate(personId: string, day: string, endDate = day) {
    const types = dataRef.current.timeoffTypes;
    const typeId = (types.find((x) => x.deducted) ?? types[0])?.id ?? "";
    setStep({ kind: "form", id: null, error: null, fields: { personId, typeId, startDate: day, endDate, startHalf: "am", endHalf: "pm", approvalStatus: "approved" } });
  }
  function openEdit(id: string) {
    const x = dataRef.current.timeoffs.find((o) => o.id === id);
    if (!x) return;
    setStep({ kind: "form", id, error: null, fields: Object.fromEntries(FIELDS.map((k) => [k, x[k]])) as Fields });
  }

  async function run(s: Extract<Step, { kind: "form" | "warn" | "assist" }>, withWrites: boolean) {
    if (!deps || busy.current) return;
    busy.current = true;
    try {
      const writes = withWrites && s.kind !== "form" ? planResolution(dataRef.current, s.fields.personId, s.report.resolutions, s.choices) : [];
      let action: Parameters<typeof runTimeoffAction>[1];
      if (s.id === null) action = { kind: "create", body: { ...s.fields, scope: "full_day" }, writes };
      else {
        const cur = dataRef.current.timeoffs.find((x) => x.id === s.id);
        const patch = Object.fromEntries(FIELDS.filter((k) => cur?.[k] !== s.fields[k]).map((k) => [k, s.fields[k]])) as TimeoffPatch;
        if (Object.keys(patch).length === 0) { close(); return; }
        action = { kind: "update", id: s.id, patch, writes };
      }
      const out = await runTimeoffAction(deps, action);
      if (out.ok) {
        const kept = s.kind !== "form" && !withWrites;
        close();
        announce(writes.length ? t("schedule.timeoff.rescheduled") : kept ? t("schedule.timeoff.keptOverload", { person: personName(s.fields.personId) }) : t("schedule.timeoff.saved"));
      } else if (out.partial) {
        close();
        announce(t("schedule.timeoff.error.partial"));
      } else {
        setStep({ kind: "form", id: s.id, fields: s.fields, error: t(errorKey(out.error)) });
      }
    } finally {
      busy.current = false;
    }
  }

  async function submit() {
    const s = stepRef.current;
    if (!s || s.kind !== "form" || !deps) return;
    const f = s.fields;
    if (f.endDate < f.startDate || (f.endDate === f.startDate && f.startHalf === "pm" && f.endHalf === "am") || !f.startDate || !f.endDate) {
      setStep({ ...s, error: t("schedule.timeoff.error.dates") });
      return;
    }
    const logged = await deps.editor.loggedTime(f.personId, f.startDate, f.endDate);
    if (stepRef.current !== s) return; // fermé ou modifié entre-temps
    const report = timeoffConflicts(dataRef.current, draftOf(s.id, f), logged ?? []);
    if (report.days.length === 0) return run(s, false);
    const choices = Object.fromEntries(report.days.flatMap((d) => d.allocations.map((a) => [a.allocationId, "move" as Choice])));
    setStep({ kind: "warn", id: s.id, fields: f, report, logged, choices });
  }

  async function remove() {
    const s = stepRef.current;
    if (!s || s.id === null || !deps || busy.current) return;
    busy.current = true;
    try {
      const out = await runTimeoffAction(deps, { kind: "delete", id: s.id });
      if (out.ok) { close(); announce(t("schedule.timeoff.deleted")); } else setStep({ ...s, kind: "form", fields: s.fields, error: t(errorKey(out.error)) } as Step);
    } finally {
      busy.current = false;
    }
  }

  /** Échap : revient d'une étape (assistant, avertissement, formulaire), puis ferme. Le bouton × ferme tout. */
  const back = () => {
    if (!step) return;
    if (step.kind === "assist") setStep({ ...step, kind: "warn" });
    else if (step.kind === "warn") setStep({ kind: "form", id: step.id, fields: step.fields, error: null });
    else close();
  };
  // Une seule vue pour les trois étapes, affichée par la pop-in du créneau.
  const modal = (title: string, body: ReactNode, footer: ReactNode, describedBy?: string): TimeoffView => ({
    title, body, footer, back, creating: step?.kind === "form" && step.id === null, ...(describedBy ? { describedBy } : {}),
  });

  let view: TimeoffView | null = null;
  if (step?.kind === "form") view = renderForm(step);
  else if (step?.kind === "warn") view = renderWarning(step);
  else if (step?.kind === "assist") view = renderAssistant(step);

  function renderForm(s: Extract<Step, { kind: "form" }>) {
    const set = (k: keyof Fields) => (e: { target: { value: string } }) => setStep({ ...s, error: null, fields: { ...s.fields, [k]: e.target.value } });
    const d = dataRef.current;
    return modal(t(s.id === null ? "schedule.timeoff.form.create" : "schedule.timeoff.form.edit"), (
        <form id="wn-timeoff-form" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
          <label>{t("schedule.timeoff.form.person")}
            <select data-autofocus value={s.fields.personId} onChange={set("personId")}>{d.people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
          </label>
          <label>{t("schedule.timeoff.form.type")}
            <select value={s.fields.typeId} onChange={set("typeId")}>{d.timeoffTypes.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select>
          </label>
          <label>{t("schedule.timeoff.form.start")}<input type="date" required value={s.fields.startDate} onChange={set("startDate")} /></label>
          <label>{t("schedule.timeoff.form.startHalf")}
            <select value={s.fields.startHalf} onChange={set("startHalf")}>
              <option value="am">{t("schedule.timeoff.form.half.full")}</option><option value="pm">{t("schedule.timeoff.form.half.pm")}</option>
            </select>
          </label>
          <label>{t("schedule.timeoff.form.end")}<input type="date" required value={s.fields.endDate} onChange={set("endDate")} /></label>
          <label>{t("schedule.timeoff.form.endHalf")}
            <select value={s.fields.endHalf} onChange={set("endHalf")}>
              <option value="pm">{t("schedule.timeoff.form.half.full")}</option><option value="am">{t("schedule.timeoff.form.half.am")}</option>
            </select>
          </label>
          <label>{t("schedule.timeoff.form.status")}
            <select value={s.fields.approvalStatus} onChange={set("approvalStatus")}>
              {(["approved", "pending", "declined"] as const).map((v) => <option key={v} value={v}>{t(`schedule.timeoff.form.status.${v}`)}</option>)}
            </select>
          </label>
          {d.timeoffTypes.length === 0 && <p role="alert">{t("schedule.timeoff.form.noType")}</p>}
          {s.error && <p role="alert" className="wn-dialog-error">{s.error}</p>}
        </form>
    ), (
      <>
        <Button onClick={close}>{t("schedule.timeoff.form.cancel")}</Button>
        {s.id !== null && <Button variant="danger" onClick={() => void remove()}>{t("schedule.timeoff.form.delete")}</Button>}
        <Button type="submit" form="wn-timeoff-form" variant="primary" disabled={d.timeoffTypes.length === 0}>{t("schedule.timeoff.form.save")}</Button>
      </>
    ));
  }

  function renderWarning(s: Extract<Step, { kind: "warn" }>) {
    const logged = new Map((s.logged ?? []).map((l) => [l.day, 0]));
    for (const l of s.logged ?? []) logged.set(l.day, (logged.get(l.day) ?? 0) + l.hours);
    return modal(t("schedule.timeoff.warning.title", { person: personName(s.fields.personId) }), (
      <>
        <p id="wn-timeoff-warn-intro">{t("schedule.timeoff.warning.intro")}</p>
        <ul>
          {s.report.days.map((d) => (
            <li key={d.day}>
              {t("schedule.timeoff.warning.day", {
                day: date(d.day), planned: d.plannedHours, capacity: d.capacityHours,
                projects: [...new Set(d.allocations.map((a) => projectName(a.allocationId)))].join(", "),
              })}
              {d.loggedHours > 0 && <> ; <strong>{t("schedule.timeoff.warning.logged", { hours: d.loggedHours })}</strong></>}
            </li>
          ))}
        </ul>
        {s.logged === null && <p>{t("schedule.timeoff.warning.loggedUnknown")}</p>}
        {!s.report.assistant && <p>{t("schedule.timeoff.warning.pending")}</p>}
      </>
    ), (
      <>
        <Button onClick={() => setStep({ kind: "form", id: s.id, fields: s.fields, error: null })}>{t("schedule.timeoff.warning.back")}</Button>
        <Button autoFocus={!s.report.assistant} onClick={() => void run(s, false)}>{t("schedule.timeoff.warning.keep")}</Button>
        {s.report.assistant && <Button variant="primary" autoFocus onClick={() => setStep({ ...s, kind: "assist" })}>{t("schedule.timeoff.warning.reschedule")}</Button>}
      </>
    ), "wn-timeoff-warn-intro");
  }

  function renderAssistant(s: Extract<Step, { kind: "assist" }>) {
    const d = dataRef.current;
    const ids = [...new Set(s.report.days.flatMap((x) => x.allocations.map((a) => a.allocationId)))];
    const writes = new Map(planResolution(d, s.fields.personId, s.report.resolutions, s.choices).map((w) => [w.allocationId, w]));
    const range = (a: { startDate: string; endDate: string }) => ({ start: date(a.startDate), end: date(a.endDate) });
    return modal(t("schedule.timeoff.assistant.title"), (
      <>
        {ids.map((id, i) => {
          const a = d.allocations.find((x) => x.id === id);
          if (!a) return null;
          const series = a.repeatState !== "none";
          const w = writes.get(id);
          const legend = t("schedule.timeoff.assistant.choice", { project: projectName(id), ...range(a) });
          return (
            <fieldset key={id} className="wn-timeoff-choice">
              <legend>{legend}</legend>
              {series ? <p>{t("schedule.timeoff.assistant.series")}</p> : (["move", "reduce", "keep"] as const).map((c) => (
                <label key={c}>
                  <input type="radio" name={`wn-choice-${id}`} value={c} checked={s.choices[id] === c} autoFocus={i === 0 && c === s.choices[id]}
                    onChange={() => setStep({ ...s, choices: { ...s.choices, [id]: c } })} />
                  {t(`schedule.timeoff.assistant.${c}`)}
                </label>
              ))}
              <ul aria-live="polite">
                {!w && <li>{t("schedule.timeoff.assistant.preview.unchanged")}</li>}
                {w && w.movedHours > 0 && <li>{t("schedule.timeoff.assistant.preview.moved", { hours: w.movedHours })}</li>}
                {w && w.removedHours > 0 && <li>{t("schedule.timeoff.assistant.preview.removed", { hours: w.removedHours })}</li>}
                {w?.update && <li>{t("schedule.timeoff.assistant.preview.update", { ...range(w.update), hours: w.update.hoursPerDay ?? 0 })}</li>}
                {w?.creates.map((c) => <li key={c.startDate}>{t("schedule.timeoff.assistant.preview.create", { ...range(c), hours: c.hoursPerDay ?? 0 })}</li>)}
                {w && !w.update && <li>{t("schedule.timeoff.assistant.preview.delete")}</li>}
              </ul>
            </fieldset>
          );
        })}
      </>
    ), (
      <>
        <Button onClick={() => setStep({ ...s, kind: "warn" })}>{t("schedule.timeoff.warning.back")}</Button>
        <Button variant="primary" onClick={() => void run(s, true)}>{t("schedule.timeoff.assistant.apply")}</Button>
      </>
    ));
  }

  return {
    openAt(personId, day) {
      if (!deps) return;
      const hit = dataRef.current.timeoffs.find((x) => x.personId === personId && x.startDate <= day && x.endDate >= day);
      if (hit) openEdit(hit.id);
      else openCreate(personId, day);
    },
    openEdit: (id) => { if (deps) openEdit(id); },
    openCreate: (personId, startDate, endDate) => { if (deps) openCreate(personId, startDate, endDate); },
    reset: () => setStep(null),
    isOpen: () => stepRef.current !== null,
    view,
  };
}
