// Formulaire d'une personne, partagé par la création réduite (US-1.1 : nom, type, horaire par défaut ; équipe, rôle et pays
// facultatifs, repliés) et l'édition dans la fiche. En édition, un changement d'horaire, d'équipe ou de rôle est daté
// (BR-19) : le champ « À partir du » apparaît, avec la date du jour par défaut. Validation locale avant l'appel ; le refus de
// l'API revient sous forme de message traduit (`submitError`).
import type { I18n } from "@lingui/core";
import { useId, useState, useEffect } from "react";
import type { Department, Person, Role } from "../data/people-source";
import type { MessageKey } from "../i18n";
import { COUNTRY_EXAMPLE, diffOf, PEOPLE_TYPES, TYPE_KEY, validatePerson, type PersonErrors, type PersonField, type PersonValues } from "./people-model";
import { WeekHoursField } from "./week-hours-field";
import { Button } from "../design";

export interface PersonFormProps {
  i18n: I18n;
  mode: "create" | "edit";
  initial: PersonValues;
  /** Personne éditée (mode edit) : sert à détecter les changements et leur datation. */
  person?: Person;
  departments: readonly Department[];
  roles: readonly Role[];
  weekStart: number;
  /** Date du jour (fuseau du compte) : défaut de « À partir du ». */
  today: string;
  readOnly?: boolean;
  busy?: boolean;
  submitError?: string | null;
  onSubmit(values: PersonValues, effectiveFrom: string | undefined): void;
  onCancel?(): void;
  /** Modifications non enregistrées (confirmation à la fermeture du drawer, RT-023, Q7). */
  onDirtyChange?(dirty: boolean): void;
}

export function PersonForm(p: PersonFormProps) {
  const t = (k: MessageKey, v?: Record<string, unknown>) => p.i18n._(k, v);
  const id = useId();
  const [v, setV] = useState<PersonValues>(p.initial);
  const [effective, setEffective] = useState(p.today);
  const [showErrors, setShowErrors] = useState(false);
  const set = <K extends keyof PersonValues>(k: K, value: PersonValues[K]) => setV((x) => ({ ...x, [k]: value }));
  const errors: PersonErrors = showErrors ? validatePerson(v) : {};
  const change = p.person ? diffOf(p.person, v) : null;
  // Une saisie invalide (heures hors 0-24) compte comme une modification : l'enregistrement l'explique au lieu de rester grisé.
  const dirty = change === null || JSON.stringify(v) !== JSON.stringify(p.initial);
  const dated = change?.historized ?? false;
  const edited = JSON.stringify(v) !== JSON.stringify(p.initial) || (p.person !== undefined && effective !== p.today);
  const onDirty = p.onDirtyChange;
  useEffect(() => { onDirty?.(edited); }, [edited, onDirty]);
  const disabled = p.readOnly || p.busy;

  const field = (f: PersonField, label: MessageKey, control: (a: { id: string; "aria-invalid"?: true; "aria-describedby"?: string }) => React.ReactNode) => (
    <div className="wn-field">
      <label htmlFor={`${id}-${f}`}>{t(label)}</label>
      {control({ id: `${id}-${f}`, ...(errors[f] ? { "aria-invalid": true as const, "aria-describedby": `${id}-${f}-err` } : {}) })}
      {errors[f] && <p id={`${id}-${f}-err`} className="wn-field-error">{t(errors[f]!)}</p>}
    </div>
  );
  const extras = (
    <>
      <div className="wn-field">
        <label htmlFor={`${id}-dept`}>{t("people.form.team")}</label>
        <select id={`${id}-dept`} value={v.departmentId} disabled={disabled} onChange={(e) => set("departmentId", e.target.value)}>
          <option value="">{t("people.form.none")}</option>
          {p.departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
        </select>
      </div>
      <div className="wn-field">
        <label htmlFor={`${id}-role`}>{t("people.form.role")}</label>
        <select id={`${id}-role`} value={v.roleId} disabled={disabled} onChange={(e) => set("roleId", e.target.value)}>
          <option value="">{t("people.form.none")}</option>
          {p.roles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
        </select>
      </div>
      {field("country", "people.form.country", (a) => (
        <input {...a} type="text" value={v.country} maxLength={2} size={4} disabled={disabled} autoComplete="off" placeholder={COUNTRY_EXAMPLE} onChange={(e) => set("country", e.target.value)} />
      ))}
    </>
  );

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (p.readOnly) return;
    setShowErrors(true);
    if (Object.keys(validatePerson(v)).length) return;
    p.onSubmit(v, dated ? effective || undefined : undefined);
  }

  return (
    <form className="wn-person-form" onSubmit={submit} noValidate aria-busy={p.busy || undefined}>
      {p.submitError && <p role="alert" className="wn-error">{p.submitError}</p>}
      {field("name", "people.form.name", (a) => (
        <input {...a} type="text" value={v.name} disabled={disabled} required maxLength={200} autoComplete="off" onChange={(e) => set("name", e.target.value)} />
      ))}
      <div className="wn-field">
        <label htmlFor={`${id}-type`}>{t("people.form.type")}</label>
        <select id={`${id}-type`} value={v.peopleType} disabled={disabled} onChange={(e) => set("peopleType", e.target.value as PersonValues["peopleType"])}>
          {PEOPLE_TYPES.map((x) => <option key={x} value={x}>{t(TYPE_KEY[x])}</option>)}
        </select>
      </div>
      <WeekHoursField i18n={p.i18n} weekStart={p.weekStart} value={v.hours} onChange={(h) => set("hours", h)} disabled={disabled} error={errors.hours} errorId={`${id}-hours-err`} />
      {p.mode === "create"
        ? <details className="wn-more"><summary>{t("people.form.more")}</summary>{extras}</details>
        : extras}
      {dated && !p.readOnly && (
        <div className="wn-field">
          <label htmlFor={`${id}-from`}>{t("people.form.effective")}</label>
          <input id={`${id}-from`} type="date" value={effective} disabled={disabled} onChange={(e) => setEffective(e.target.value)} aria-describedby={`${id}-from-hint`} />
          <p id={`${id}-from-hint`} className="wn-muted">{t("people.form.effective.hint")}</p>
        </div>
      )}
      {!p.readOnly && (
        <div className="wn-dialog-actions">
          <Button type="submit" variant="primary" disabled={p.busy || !dirty}>{t(p.mode === "create" ? "people.form.create" : "people.form.save")}</Button>
          {p.onCancel && <Button type="button" onClick={p.onCancel}>{t("people.form.cancel")}</Button>}
        </div>
      )}
    </form>
  );
}
