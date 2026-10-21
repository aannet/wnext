// Formulaire de l'onglet « Projet / tâche » de la pop-in du créneau (RT-011, RT-014, RT-016, RT-018) : personnes (création :
// cases à cocher avec recherche, groupe BR-26 au-delà d'une ; édition : une seule, par Combobox), projet et tâche par Combobox
// avec recherche, couleur du projet (palette de l'écran Projets, si le projet est modifiable), dates, charge (heures par jour
// ou pourcentage), statut, note, surcharge signalée (BR-01), contrôles et refus traduits. Sans état propre hors recherche :
// le brouillon vit dans la pop-in (slot-editor-ui).
import type { I18n } from "@lingui/core";
import { useId, useState } from "react";
import type { Allocation } from "../data/allocation-edits";
import { Button, Combobox, type ComboboxOption } from "../design";
import type { MessageKey } from "../i18n";
import { ColorField } from "../projects/color-field";
import type { SlotDraft, SlotIssue } from "./slot-model";

export interface SlotFormProps {
  i18n: I18n;
  formId: string;
  draft: SlotDraft;
  onChange(patch: Partial<SlotDraft>): void;
  onSubmit(): void;
  people: ComboboxOption[];
  projects: ComboboxOption[];
  /** Tâches du projet choisi (sans l'option « Sans tâche », ajoutée ici). */
  tasks: ComboboxOption[];
  /** Allocation éditée (série : mention de la portée) ; absente en création. */
  current?: Allocation | undefined;
  /** Noms des personnes en surcharge sur la plage. */
  overloads: string[];
  issues: SlotIssue[];
  error: string | null;
  /** Couleur du projet : null = fermé ; absent (undefined) = projet non modifiable, pas de bouton. */
  color?: { value: string | null; onToggle(): void; onChange(hex: string): void; onApply(): void } | undefined;
}

export function SlotForm(p: SlotFormProps) {
  const t = (k: MessageKey, v?: Record<string, unknown>) => p.i18n._(k, v);
  const d = p.draft;
  const empty = t("schedule.slot.options", { count: 0 });
  return (
    <form id={p.formId} className="wn-slot-form" onSubmit={(e) => { e.preventDefault(); p.onSubmit(); }}>
      {d.allocationId === null
        ? <PeoplePicker i18n={p.i18n} people={p.people} value={d.personIds} onChange={(personIds) => p.onChange({ personIds })} />
        : <Combobox label={t("schedule.slot.person")} value={d.personIds[0] ?? null} options={p.people} emptyLabel={empty}
            placeholder={t("schedule.slot.people.search")} onChange={(id) => p.onChange({ personIds: [id] })} />}
      <Combobox label={t("schedule.slot.project")} value={d.projectId} options={p.projects} emptyLabel={empty} initialFocus
        placeholder={t("schedule.slot.project.search")} onChange={(id) => p.onChange({ projectId: id, taskId: id === d.projectId ? d.taskId : null })}
        swatch={(o) => <span aria-hidden="true" className="wn-slot-swatch" style={{ background: o.color ?? undefined }} />} />
      <Combobox label={t("schedule.slot.task")} value={d.taskId ?? ""} options={[{ id: "", name: t("schedule.slot.task.none") }, ...p.tasks]} disabled={!d.projectId}
        emptyLabel={empty} placeholder={t("schedule.slot.task.search")} onChange={(id) => p.onChange({ taskId: id || null })} />
      {p.color && (
        <div className="wn-slot-color wn-slot-wide">
          <Button aria-expanded={p.color.value !== null} onClick={p.color.onToggle}>{t("schedule.slot.color.open")}</Button>
          {p.color.value !== null && (
            <>
              <ColorField i18n={p.i18n} value={p.color.value} onChange={p.color.onChange} />
              <Button onClick={p.color.onApply}>{t("schedule.slot.color.apply")}</Button>
            </>
          )}
        </div>
      )}
      <label>{t("schedule.slot.start")}<input type="date" required value={d.startDate} onChange={(e) => p.onChange({ startDate: e.target.value })} /></label>
      <label>{t("schedule.slot.end")}<input type="date" required value={d.endDate} onChange={(e) => p.onChange({ endDate: e.target.value })} /></label>
      <label>{t("schedule.slot.mode")}
        <select value={d.mode} onChange={(e) => p.onChange({ mode: e.target.value as SlotDraft["mode"] })}>
          <option value="hours">{t("schedule.slot.mode.hours")}</option><option value="percentage">{t("schedule.slot.mode.percentage")}</option>
        </select>
      </label>
      {d.mode === "hours"
        ? <label>{t("schedule.slot.hours")}<input type="number" min="0.5" max="24" step="0.5" value={d.hours} onChange={(e) => p.onChange({ hours: e.target.value })} /></label>
        : <label>{t("schedule.slot.percent")}<input type="number" min="5" max="500" step="5" value={d.percent} onChange={(e) => p.onChange({ percent: e.target.value })} /></label>}
      <label>{t("schedule.slot.status")}
        <select value={d.status} onChange={(e) => p.onChange({ status: e.target.value as SlotDraft["status"] })}>
          <option value="confirmed">{t("schedule.slot.status.confirmed")}</option><option value="tentative">{t("schedule.slot.status.tentative")}</option>
        </select>
      </label>
      <label className="wn-slot-wide">{t("schedule.slot.notes")}<textarea rows={2} value={d.notes} onChange={(e) => p.onChange({ notes: e.target.value })} /></label>
      {p.current && p.current.repeatState !== "none" && <p className="wn-slot-wide">{t("schedule.slot.series")}</p>}
      {p.overloads.length > 0 && <p role="status" className="wn-slot-wide wn-slot-overload">{t("schedule.slot.overload", { people: p.overloads.join(", "), count: p.overloads.length })}</p>}
      {p.issues.length > 0 && <ul role="alert" className="wn-slot-wide wn-dialog-error">{p.issues.map((x) => <li key={x}>{t(`schedule.slot.issue.${x}`)}</li>)}</ul>}
      {p.error && <p role="alert" className="wn-slot-wide wn-dialog-error">{p.error}</p>}
    </form>
  );
}

const fold = (s: string) => s.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLocaleLowerCase();
/** Personnes affichées au plus (la recherche resserre la liste ; les cochées restent en tête). */
const SHOWN_MAX = 50;

/** Choix de plusieurs personnes : recherche et cases à cocher (une ligne par personne cochée à la création, BR-26). */
function PeoplePicker({ i18n, people, value, onChange }: { i18n: I18n; people: ComboboxOption[]; value: string[]; onChange(ids: string[]): void }) {
  const t = (k: MessageKey, v?: Record<string, unknown>) => i18n._(k, v);
  const [query, setQuery] = useState("");
  const id = useId();
  const q = fold(query.trim());
  const chosen = new Set(value);
  const shown = [...people.filter((x) => chosen.has(x.id)), ...people.filter((x) => !chosen.has(x.id) && (q === "" || fold(x.name).includes(q)))];
  return (
    <fieldset className="wn-slot-people wn-slot-wide">
      <legend>{t("schedule.slot.people")}</legend>
      <input type="search" aria-label={t("schedule.slot.people.search")} placeholder={t("schedule.slot.people.search")} aria-describedby={`${id}-count`}
        value={query} onChange={(e) => setQuery(e.target.value)} />
      <span id={`${id}-count`} className="wn-muted">{t("schedule.slot.people.selected", { count: value.length })}</span>
      <div className="wn-slot-people-list">
        {shown.slice(0, Math.max(SHOWN_MAX, value.length)).map((x) => (
          <label key={x.id}>
            <input type="checkbox" checked={chosen.has(x.id)} onChange={(e) => onChange(e.target.checked ? [...value, x.id] : value.filter((v) => v !== x.id))} />
            {x.name}
          </label>
        ))}
      </div>
      {value.length > 1 && <p className="wn-muted">{t("schedule.slot.people.group")}</p>}
    </fieldset>
  );
}
